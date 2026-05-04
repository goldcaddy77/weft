/**
 * Fired when the agent loop falls back from one model to another after a
 * provider error. Carries the failed model, failure reason, next model to try,
 * and the fallback attempt index for multi-step fallback chains.
 *
 * @example Alert when model fallbacks occur
 * ```ts
 * import { AgentModelFallbackEvent } from 'weft';
 *
 * const target = new EventTarget();
 *
 * target.addEventListener(AgentModelFallbackEvent.type, (e) => {
 *   const event = e as AgentModelFallbackEvent;
 *   console.warn(`Model fallback: ${event.failedModel} → ${event.nextModel} — ${event.failedReason}`);
 * });
 * ```
 */
export class AgentModelFallbackEvent extends Event {
  static readonly type = 'agent:model:fallback' as const;
  readonly workflowId: string;
  readonly agentId: string;
  readonly turnIndex: number;
  readonly failedModel: string;
  readonly failedReason: string;
  readonly nextModel: string;
  readonly attemptIndex: number;

  constructor(
    workflowId: string,
    agentId: string,
    turnIndex: number,
    failedModel: string,
    failedReason: string,
    nextModel: string,
    attemptIndex: number,
  ) {
    super(AgentModelFallbackEvent.type);
    this.workflowId = workflowId;
    this.agentId = agentId;
    this.turnIndex = turnIndex;
    this.failedModel = failedModel;
    this.failedReason = failedReason;
    this.nextModel = nextModel;
    this.attemptIndex = attemptIndex;
  }
}
