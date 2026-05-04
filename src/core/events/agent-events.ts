/**
 * Fired on the {@link Engine} for each token streamed from an LLM during an
 * agent workflow. Read `e.workflowId`, `e.token`, and `e.model` to stream
 * tokens to clients in real time.
 *
 * @example
 * ```ts
 * import { Engine, TokenEvent } from 'weft';
 *
 * const engine = new Engine();
 * engine.addEventListener('agent:token', (e: Event) => {
 *   const ev = e as TokenEvent;
 *   console.log(ev.token);
 * });
 * ```
 */
export class TokenEvent extends Event {
  static readonly type = 'agent:token' as const;
  readonly workflowId: string;
  readonly token: string;
  readonly model: string;

  constructor(workflowId: string, token: string, model: string) {
    super(TokenEvent.type);
    this.workflowId = workflowId;
    this.token = token;
    this.model = model;
  }
}
