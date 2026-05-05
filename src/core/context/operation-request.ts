import type {
  DebateOptions,
  HandoffOptions,
  SuperviseOptions,
} from '../../ai/coordination/index.ts';
import type { HumanReviewOptions } from '../../ai/human-review.ts';
import type { ChildWorkflowOptions } from '../types.ts';
import type { Context } from './index.ts';
import type { AgentContextOptions, OffloadReference, StreamSink } from './types.ts';

/**
 * Discriminated union of all operation descriptors that a workflow generator
 * can yield to the engine. Each variant corresponds to one durable operation.
 *
 * @example
 * ```ts
 * import { activity, Engine, type ContextOperationRequest } from 'weft';
 * import type { Context, WorkflowContext } from 'weft';
 *
 * const ping = activity({ name: 'ping', execute: async (input: unknown) => input });
 * const engine = new Engine();
 *
 * engine.register('demo', async function* (ctx: WorkflowContext) {
 *   const generator = (ctx as Context).run(ping, 'hello');
 *   const first = generator.next();
 *   const request: ContextOperationRequest | undefined = first.done ? undefined : first.value;
 *   void request;
 * });
 * ```
 */
export type ContextOperationRequest =
  | {
      type: 'activity';
      operationId: string;
      activityName: string;
      fn: (...args: unknown[]) => unknown;
      args: unknown[];
      callerStack?: string;
      options?: Record<string, unknown>;
      /** Serialized interceptor headers (Map entries) for remote worker propagation. */
      headers?: [string, string][];
    }
  | {
      type: 'sleep';
      operationId: string;
      duration: number;
      scheduledFireAt: number;
      callerStack?: string;
    }
  | {
      type: 'wait-signal';
      operationId: string;
      signalName: string;
      callerStack?: string;
    }
  | {
      type: 'wait-update';
      operationId: string;
      updateName: string;
      callerStack?: string;
    }
  | {
      type: 'parallel';
      operationId: string;
      operations: ContextOperationRequest[];
      callerStack?: string;
    }
  | {
      type: 'race';
      operationId: string;
      operations: ContextOperationRequest[];
      callerStack?: string;
    }
  | {
      type: 'memo';
      operationId: string;
      key: string;
      fn: () => unknown;
      callerStack?: string;
    }
  | {
      type: 'child-workflow';
      operationId: string;
      workflowType: string;
      input: unknown;
      callerStack?: string;
      options?: ChildWorkflowOptions;
    }
  | {
      type: 'offload';
      operationId: string;
      key: string;
      fn: () => Promise<unknown>;
      callerStack?: string;
    }
  | {
      type: 'load';
      operationId: string;
      reference: OffloadReference;
      callerStack?: string;
    }
  | {
      type: 'archive';
      operationId: string;
      key: string;
      data: unknown;
      callerStack?: string;
    }
  | {
      type: 'run-all';
      operationId: string;
      branches: Record<string, [Function, ...unknown[]]>;
      callerStack?: string;
    }
  | {
      type: 'agent';
      operationId: string;
      stepIndex: number;
      options: AgentContextOptions;
      callerStack?: string;
    }
  | {
      type: 'speculate';
      operationId: string;
      execute: (
        context: Context,
      ) =>
        | Generator<ContextOperationRequest, unknown, unknown>
        | AsyncGenerator<unknown, unknown, unknown>;
      callerStack?: string;
    }
  | {
      type: 'stream';
      operationId: string;
      key: string;
      fn: (sink: StreamSink) => AsyncGenerator<unknown, void, unknown>;
      callerStack?: string;
    }
  | {
      type: 'wait-review';
      operationId: string;
      reviewOptions: HumanReviewOptions;
      callerStack?: string;
    }
  | {
      type: 'handoff';
      operationId: string;
      options: HandoffOptions;
      callerStack?: string;
    }
  | {
      type: 'debate';
      operationId: string;
      options: DebateOptions;
      callerStack?: string;
    }
  | {
      type: 'supervise';
      operationId: string;
      options: SuperviseOptions;
      callerStack?: string;
    };
