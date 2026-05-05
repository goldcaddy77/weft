import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { TransportKind } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import { anonymousPrincipal } from '../principal.ts';
import { DISPATCH_ALLOWLIST } from './dispatch-allowlist.ts';
import { executeOperation } from './pipeline.ts';
import { createOperationRegistry } from './registry.ts';
import type {
  DispatchContext,
  ErasedOperation,
  PipelineTrace,
  PipelineTraceMarker,
} from './types.ts';

const EXPECTED_PIPELINE_TRACE: PipelineTraceMarker[] = [
  'looked-up',
  'transport-checked',
  'access-checked',
  'parsed',
  'unknown-key-policy-applied',
  'authorized',
  'invoked',
  'output-validated',
];

const TRANSPORTS = [
  'http-rest',
  'jsonRpcHttp',
  'jsonRpcWebSocket',
  'jsonRpcStdio',
] as const satisfies ReadonlyArray<TransportKind>;

describe('operation dispatch audit — pipeline trace sweep', () => {
  it('emits every pipeline marker in order for each transport kind', async () => {
    const registry = createOperationRegistry([createTraceOperation()]);

    for (const transport of TRANSPORTS) {
      const markers: PipelineTraceMarker[] = [];
      const result = await executeOperation(
        'weft.audit.trace',
        { value: 'ok' },
        {
          principal: anonymousPrincipal(),
          engine: {},
          transport,
          registry,
          pipelineTrace: (marker) => markers.push(marker),
        },
      );

      expect(result).toEqual({ ok: true, value: { echoed: 'ok' } });
      expect(markers).toEqual(EXPECTED_PIPELINE_TRACE);
    }
  });
});

describe('operation dispatch audit — allow-list invariant', () => {
  it('contains only the stateful WebSocket session lifecycle exemptions', () => {
    expect(DISPATCH_ALLOWLIST).toEqual(
      new Set(['weft.workflows.subscribe', 'weft.workflows.unsubscribe']),
    );
    expect(DISPATCH_ALLOWLIST.size).toBe(2);
  });
});

describe('operation dispatch audit — negative fixture', () => {
  it('detects a handler that skips the parsing and unknown-key-policy stages', async () => {
    const operation = createTraceOperation();
    const registry = createOperationRegistry([operation]);
    const registeredOperation = registry.get('weft.audit.trace');
    if (registeredOperation === undefined) throw new Error('expected audit operation to register');
    const markers: PipelineTraceMarker[] = [];

    await skipParsingHandler(registeredOperation, {
      principal: anonymousPrincipal(),
      engine: {},
      transport: 'jsonRpcWebSocket',
      registry,
      pipelineTrace: (marker) => markers.push(marker),
    });

    expect(markers).not.toContain('parsed');
    expect(markers).not.toContain('unknown-key-policy-applied');
  });
});

function createTraceOperation() {
  return defineOperation({
    name: 'weft.audit.trace',
    mcpExposable: false,
    summary: 'Audit pipeline trace markers',
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ echoed: z.string() }),
    access: { kind: 'public' },
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
    invoke: async ({ input }) => ({ echoed: input.value }),
  });
}

async function skipParsingHandler(
  operation: ErasedOperation,
  context: DispatchContext & { pipelineTrace: PipelineTrace },
): Promise<void> {
  const trace = context.pipelineTrace;
  trace('looked-up');
  trace('transport-checked');
  trace('access-checked');
  trace('authorized');
  await operation.invoke({
    input: { value: 'direct' },
    principal: context.principal,
    engine: context.engine,
    transport: context.transport,
  });
  trace('invoked');
  trace('output-validated');
}
