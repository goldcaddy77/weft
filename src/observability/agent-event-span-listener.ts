import {
  AgentToolCalledEvent,
  AgentToolReturnedEvent,
  AgentTurnCompletedEvent,
  AgentTurnStartedEvent,
} from '../ai/events/index.ts';
import type { OpenTelemetrySpan } from './no-op-telemetry';
import type { ObservabilityState } from './types';

export class AgentEventSpanListener implements EventListenerObject {
  readonly #workflowId: string;
  readonly #state: ObservabilityState;
  readonly #agentContext: unknown;
  readonly #turnSpans = new Map<number, OpenTelemetrySpan>();
  readonly #toolSpans = new Map<string, OpenTelemetrySpan>();

  constructor(workflowId: string, state: ObservabilityState, agentContext: unknown) {
    this.#workflowId = workflowId;
    this.#state = state;
    this.#agentContext = agentContext;
  }

  handleEvent(event: Event): void {
    if (event instanceof AgentTurnStartedEvent) {
      this.#handleTurnStarted(event);
      return;
    }
    if (event instanceof AgentTurnCompletedEvent) {
      this.#handleTurnCompleted(event);
      return;
    }
    if (event instanceof AgentToolCalledEvent) {
      this.#handleToolCalled(event);
      return;
    }
    if (event instanceof AgentToolReturnedEvent) {
      this.#handleToolReturned(event);
    }
  }

  #handleTurnStarted(event: AgentTurnStartedEvent): void {
    if (event.workflowId !== this.#workflowId) return;
    const turnSpan = this.#state.tracer.startSpan(
      `agent:turn:${event.turnIndex}`,
      {
        attributes: {
          'weft.agent.turn_index': event.turnIndex,
          'weft.agent.model': event.model,
        },
      },
      this.#agentContext,
    );
    this.#turnSpans.set(event.turnIndex, turnSpan);
  }

  #handleTurnCompleted(event: AgentTurnCompletedEvent): void {
    if (event.workflowId !== this.#workflowId) return;
    const turnSpan = this.#turnSpans.get(event.turnIndex);
    if (!turnSpan) return;

    turnSpan.setAttribute('weft.agent.input_tokens', event.inputTokens);
    turnSpan.setAttribute('weft.agent.output_tokens', event.outputTokens);
    turnSpan.setStatus({ code: this.#state.SpanStatusCode.OK });
    turnSpan.end();
    this.#turnSpans.delete(event.turnIndex);
  }

  #handleToolCalled(event: AgentToolCalledEvent): void {
    if (event.workflowId !== this.#workflowId) return;
    const parentTurnSpan = this.#turnSpans.get(event.turnIndex);
    const toolParentContext = parentTurnSpan
      ? this.#state.trace.setSpan(this.#state.api.context.ROOT_CONTEXT, parentTurnSpan)
      : this.#agentContext;
    const toolSpan = this.#state.tracer.startSpan(
      `agent:tool:${event.toolName}`,
      {
        attributes: {
          'weft.agent.tool_name': event.toolName,
        },
      },
      toolParentContext,
    );
    this.#toolSpans.set(event.operationId, toolSpan);
  }

  #handleToolReturned(event: AgentToolReturnedEvent): void {
    if (event.workflowId !== this.#workflowId) return;

    const toolSpan = this.#toolSpans.get(event.operationId);
    if (!toolSpan) return;

    toolSpan.setAttribute('weft.agent.tool_duration', event.duration);
    toolSpan.setAttribute('weft.agent.tool_success', event.success);
    toolSpan.setStatus({
      code: event.success ? this.#state.SpanStatusCode.OK : this.#state.SpanStatusCode.ERROR,
    });
    toolSpan.end();
    this.#toolSpans.delete(event.operationId);
  }

  endOrphanedSpans(): void {
    for (const orphanedTool of this.#toolSpans.values()) {
      orphanedTool.setStatus({ code: this.#state.SpanStatusCode.ERROR });
      orphanedTool.end();
    }
    for (const orphanedTurn of this.#turnSpans.values()) {
      orphanedTurn.setStatus({ code: this.#state.SpanStatusCode.ERROR });
      orphanedTurn.end();
    }
  }
}
