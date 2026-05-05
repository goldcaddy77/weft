/**
 * Fired immediately before a tool is executed within an agent turn. Carries the
 * tool name, raw input, source ('local'), and a per-operation UUID that
 * correlates with the matching {@link AgentToolReturnedEvent}.
 *
 * @example Audit all tool calls with their inputs
 * ```ts
 * import { AgentToolCalledEvent } from 'weft';
 *
 * const target = new EventTarget();
 *
 * target.addEventListener(AgentToolCalledEvent.type, (e) => {
 *   const event = e as AgentToolCalledEvent;
 *   console.log(`Tool called: ${event.toolName} (source: ${event.source})`, event.toolInput);
 * });
 * ```
 */
export class AgentToolCalledEvent extends Event {
  static readonly type = 'agent:tool:called' as const;
  readonly workflowId: string;
  readonly agentId: string;
  readonly turnIndex: number;
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly source: 'local';
  readonly operationId: string;

  constructor(
    workflowId: string,
    agentId: string,
    turnIndex: number,
    toolName: string,
    toolInput: unknown,
    source: 'local',
    operationId: string,
  ) {
    super(AgentToolCalledEvent.type);
    this.workflowId = workflowId;
    this.agentId = agentId;
    this.turnIndex = turnIndex;
    this.toolName = toolName;
    this.toolInput = toolInput;
    this.source = source;
    this.operationId = operationId;
  }
}

/**
 * Fired after a tool finishes execution, carrying the tool name, wall-clock
 * duration, success flag, and the operation ID that matches the preceding
 * {@link AgentToolCalledEvent}. Use this to measure tool latency and track failures.
 *
 * @example Monitor tool execution duration and failures
 * ```ts
 * import { AgentToolReturnedEvent } from 'weft';
 *
 * const target = new EventTarget();
 *
 * target.addEventListener(AgentToolReturnedEvent.type, (e) => {
 *   const event = e as AgentToolReturnedEvent;
 *   const status = event.success ? 'ok' : 'error';
 *   console.log(`Tool ${event.toolName} [${status}] ${event.duration}ms`);
 * });
 * ```
 */
export class AgentToolReturnedEvent extends Event {
  static readonly type = 'agent:tool:returned' as const;
  readonly workflowId: string;
  readonly agentId: string;
  readonly turnIndex: number;
  readonly toolName: string;
  readonly duration: number;
  readonly success: boolean;
  readonly operationId: string;

  constructor(
    workflowId: string,
    agentId: string,
    turnIndex: number,
    toolName: string,
    duration: number,
    success: boolean,
    operationId: string,
  ) {
    super(AgentToolReturnedEvent.type);
    this.workflowId = workflowId;
    this.agentId = agentId;
    this.turnIndex = turnIndex;
    this.toolName = toolName;
    this.duration = duration;
    this.success = success;
    this.operationId = operationId;
  }
}
