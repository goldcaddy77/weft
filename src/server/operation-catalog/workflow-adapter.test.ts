import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { Engine } from '../../core/engine.ts';
import { StartWorkflowValidationError } from '../../core/start-workflow-validation.ts';
import { QuotaExceededError } from '../../core/tenant-quotas.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { generateOpenRpcDocument } from '../openrpc.ts';
import { anonymousPrincipal, principalFromApiKey } from '../principal.ts';
import { createOperationRegistry, executeOperation } from './index.ts';
import { catalogWorkflow } from './workflow-adapter.ts';

type CheckoutInput = {
  orderId: string;
  amount: number;
};

type StartHandle = {
  workflowId: string;
  status: string;
};

const checkoutInputSchema = z.object({
  orderId: z.string(),
  amount: z.number(),
});

const catalogTransports = {
  http: true,
  jsonRpcHttp: true,
  jsonRpcWebSocket: true,
  jsonRpcStdio: true,
};

const catalogUnknownKeyPolicy = {
  http: 'strip',
  jsonRpc: 'reject',
} as const;

const engines: Engine[] = [];

afterEach(() => {
  while (engines.length > 0) {
    engines.pop()?.[Symbol.dispose]();
  }
});

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engines.push(engine);
  return engine;
}

function registerCheckoutWorkflow(engine: Engine): void {
  engine.register('checkout', async function* (_context: WorkflowContext, input: unknown) {
    return { completed: true, input };
  });
}

function catalogCheckoutWorkflow(engine: Engine) {
  return catalogWorkflow<CheckoutInput>({
    name: 'weft.workflows.checkout.start',
    workflowType: 'checkout',
    engine,
    summary: 'Start a checkout workflow',
    tags: ['Workflows', 'Checkout'],
    inputSchema: checkoutInputSchema,
    access: { kind: 'public' },
    transports: catalogTransports,
    unknownKeyPolicy: catalogUnknownKeyPolicy,
  });
}

describe('catalogWorkflow', () => {
  it('starts the workflow and returns only the start handle', async () => {
    const engine = createEngine();
    registerCheckoutWorkflow(engine);
    const registry = createOperationRegistry([catalogCheckoutWorkflow(engine)]);

    const result = await executeOperation<StartHandle>(
      'weft.workflows.checkout.start',
      { orderId: 'ord_1', amount: 42 },
      {
        principal: anonymousPrincipal(),
        engine,
        transport: 'http-rest',
        registry,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value.status).toBe('started');
    expect(typeof result.value.workflowId).toBe('string');
    expect(result.value).not.toHaveProperty('completed');

    const workflowResult = await engine.getHandle(result.value.workflowId).result();
    expect(workflowResult).toEqual({
      completed: true,
      input: { orderId: 'ord_1', amount: 42 },
    });
  });

  it('dispatches over JSON-RPC HTTP and passes the entire validated input to engine.start', async () => {
    const engine = createEngine();
    registerCheckoutWorkflow(engine);
    const registry = createOperationRegistry([catalogCheckoutWorkflow(engine)]);

    const result = await executeOperation<StartHandle>(
      'weft.workflows.checkout.start',
      { orderId: 'ord_2', amount: 19 },
      {
        principal: anonymousPrincipal(),
        engine,
        transport: 'jsonRpcHttp',
        registry,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');

    const workflowResult = await engine.getHandle(result.value.workflowId).result();
    expect(workflowResult).toEqual({
      completed: true,
      input: { orderId: 'ord_2', amount: 19 },
    });
  });

  it('rejects invalid input before starting the workflow', async () => {
    const engine = createEngine();
    registerCheckoutWorkflow(engine);
    const registry = createOperationRegistry([catalogCheckoutWorkflow(engine)]);

    const result = await executeOperation(
      'weft.workflows.checkout.start',
      { orderId: 'ord_3' },
      {
        principal: anonymousPrincipal(),
        engine,
        transport: 'jsonRpcHttp',
        registry,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fault');
    expect(result.fault.code).toBe('InvalidParams');
  });

  it('invokes the authorize hook with parsed input', async () => {
    const engine = createEngine();
    registerCheckoutWorkflow(engine);
    const seenAmounts: number[] = [];
    const registry = createOperationRegistry([
      catalogWorkflow<CheckoutInput>({
        name: 'weft.workflows.checkout.start',
        workflowType: 'checkout',
        engine,
        summary: 'Start a checkout workflow',
        inputSchema: checkoutInputSchema,
        access: { kind: 'authenticated' },
        transports: catalogTransports,
        unknownKeyPolicy: catalogUnknownKeyPolicy,
        authorize: async ({ input }) => {
          seenAmounts.push(input.amount);
          return { allowed: true };
        },
      }),
    ]);

    const result = await executeOperation(
      'weft.workflows.checkout.start',
      { orderId: 'ord_4', amount: 25 },
      {
        principal: principalFromApiKey({ subject: 'test-key', scopes: [] }),
        engine,
        transport: 'jsonRpcHttp',
        registry,
      },
    );

    expect(result.ok).toBe(true);
    expect(seenAmounts).toEqual([25]);
  });

  it('defaults to a passthrough empty input schema when omitted', async () => {
    const engine = createEngine();
    engine.register('loose-workflow', async function* (_context: WorkflowContext, input: unknown) {
      return input;
    });
    const registry = createOperationRegistry([
      catalogWorkflow<Record<string, unknown>>({
        name: 'weft.workflows.loose.start',
        workflowType: 'loose-workflow',
        engine,
        summary: 'Start a loose workflow',
        access: { kind: 'public' },
        transports: catalogTransports,
        unknownKeyPolicy: { http: 'passthrough', jsonRpc: 'passthrough' },
      }),
    ]);

    const result = await executeOperation<StartHandle>(
      'weft.workflows.loose.start',
      { arbitrary: true, count: 2 },
      {
        principal: anonymousPrincipal(),
        engine,
        transport: 'jsonRpcHttp',
        registry,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    const workflowResult = await engine.getHandle(result.value.workflowId).result();
    expect(Object.fromEntries(Object.entries(workflowResult as Record<string, unknown>))).toEqual({
      arbitrary: true,
      count: 2,
    });
  });

  it('maps engine start failures to operation faults', async () => {
    const cases = [
      {
        error: new StartWorkflowValidationError('Field "id" must be a string'),
        expectedCode: 'InvalidParams',
      },
      {
        error: new QuotaExceededError({
          tenantId: 'acme',
          quota: 'maxConcurrentWorkflows',
          currentUsage: 2,
          limit: 1,
        }),
        expectedCode: 'RateLimited',
      },
      {
        error: new Error('No workflow registered with name "missing"'),
        expectedCode: 'InvalidParams',
      },
      {
        error: new Error('Workflow "checkout" already exists'),
        expectedCode: 'Conflict',
      },
      {
        error: new Error('database unavailable'),
        expectedCode: 'EngineFailure',
      },
    ] as const;

    for (const testCase of cases) {
      const engine = createEngine();
      engine.start = async () => {
        throw testCase.error;
      };
      const registry = createOperationRegistry([catalogCheckoutWorkflow(engine)]);

      const result = await executeOperation(
        'weft.workflows.checkout.start',
        { orderId: 'ord_5', amount: 12 },
        {
          principal: anonymousPrincipal(),
          engine,
          transport: 'jsonRpcHttp',
          registry,
        },
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected fault');
      expect(result.fault.code).toBe(testCase.expectedCode);
    }
  });

  it('appears in generated OpenRPC documents with the hard-coded start handle result schema', () => {
    const engine = createEngine();
    const registry = createOperationRegistry([catalogCheckoutWorkflow(engine)]);

    const document = generateOpenRpcDocument({ registry, transports: ['http'] });
    const methods = document['methods'] as Array<Record<string, unknown>>;
    const method = methods.find(
      (candidate) => candidate['name'] === 'weft.workflows.checkout.start',
    );
    expect(method).toBeDefined();
    if (method === undefined) throw new Error('expected method');
    expect(method['summary']).toBe('Start a checkout workflow');
    expect(method['tags']).toEqual([{ name: 'Checkout' }, { name: 'Workflows' }]);
    expect(method['result']).toMatchObject({
      name: 'result',
      required: true,
      schema: {
        type: 'object',
        properties: {
          workflowId: { type: 'string' },
          status: { type: 'string' },
        },
        required: ['workflowId', 'status'],
      },
    });
  });
});
