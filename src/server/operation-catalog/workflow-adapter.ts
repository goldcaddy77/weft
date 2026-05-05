import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { StartWorkflowValidationError } from '../../core/start-workflow-validation.ts';
import { QuotaExceededError } from '../../core/tenant-quotas.ts';
import type { AccessPolicy } from '../authorization.ts';
import type { OperationFault } from '../operation-fault.ts';
import { invalidParamsFault } from '../operations/operation-helpers.ts';
import type {
  AuthorizationDecision,
  OperationContext,
  OperationDefinition,
  TransportAvailability,
  UnknownKeyPolicy,
} from './types.ts';
import { validateOperationName } from './types.ts';

const StartHandleSchema = z.object({
  workflowId: z.string(),
  status: z.string(),
});

type StartHandle = z.infer<typeof StartHandleSchema>;

export type CatalogWorkflowOptions<Input> = {
  readonly name: string;
  readonly mcpExposable: boolean;
  readonly workflowType: string;
  readonly engine: Engine;
  readonly summary: string;
  readonly tags?: ReadonlyArray<string>;
  readonly inputSchema?: z.ZodObject<z.ZodRawShape>;
  readonly access: AccessPolicy;
  readonly transports: TransportAvailability;
  readonly unknownKeyPolicy: UnknownKeyPolicy;
  readonly authorize?: (context: OperationContext<Input>) => Promise<AuthorizationDecision>;
};

/**
 * `catalogWorkflow()` — wrap a registered workflow as a typed
 * `OperationDefinition`. Produces one cataloged `start` operation per
 * workflow. Always returns the start handle ({ workflowId, status });
 * never blocks awaiting the workflow result.
 *
 * Schemas are opt-in for v1; required when the operation is later flagged
 * as MCP-exposable (see `mcpExposable` ratchet in PR 6).
 */
export function catalogWorkflow<Input>(
  options: CatalogWorkflowOptions<Input>,
): OperationDefinition<Input, StartHandle> {
  const inputSchema = (options.inputSchema ?? z.object({}).passthrough()) as z.ZodType<Input>;
  validateOperationName(options.name);

  return {
    name: options.name,
    mcpExposable: options.mcpExposable,
    summary: options.summary,
    tags: [...(options.tags ?? [])],
    inputSchema,
    outputSchema: StartHandleSchema,
    access: copyAccessPolicy(options.access),
    transports: { ...options.transports },
    unknownKeyPolicy: { ...options.unknownKeyPolicy },
    ...(options.authorize === undefined ? {} : { authorize: options.authorize }),
    invoke: async ({ input, engine }): Promise<StartHandle> => {
      const typedEngine = engine as Engine;

      try {
        const handle = await typedEngine.start(options.workflowType, input);
        return { workflowId: handle.id, status: 'started' };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (error instanceof StartWorkflowValidationError) {
          throw invalidParamsFault(message);
        }
        if (error instanceof QuotaExceededError) {
          const fault: OperationFault = {
            code: 'RateLimited',
            message,
            data: {},
          };
          throw fault;
        }
        if (message.includes('No workflow registered')) {
          throw invalidParamsFault(message);
        }
        if (message.includes('already exists')) {
          const fault: OperationFault = {
            code: 'Conflict',
            message,
            data: { reason: message },
          };
          throw fault;
        }

        const fault: OperationFault = {
          code: 'EngineFailure',
          message,
          data: {},
        };
        throw fault;
      }
    },
  };
}

function copyAccessPolicy(policy: AccessPolicy): AccessPolicy {
  if (policy.kind === 'scoped') {
    return {
      kind: 'scoped',
      scopes: {
        kind: policy.scopes.kind,
        scopes: [...policy.scopes.scopes] as [
          (typeof policy.scopes.scopes)[number],
          ...(typeof policy.scopes.scopes)[number][],
        ],
      },
    };
  }
  if (policy.kind === 'optionalAuth') {
    return {
      kind: 'optionalAuth',
      authenticatedScopes: {
        kind: policy.authenticatedScopes.kind,
        scopes: [...policy.authenticatedScopes.scopes] as [
          (typeof policy.authenticatedScopes.scopes)[number],
          ...(typeof policy.authenticatedScopes.scopes)[number][],
        ],
      },
    };
  }
  return { ...policy };
}
