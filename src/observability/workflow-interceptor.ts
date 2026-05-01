import type {
  ActivityInterception,
  AgentInterception,
  ChildWorkflowInterception,
  SignalInterception,
  SignalReceivedInterception,
  SleepInterception,
  WorkflowInterceptor,
  WorkflowStartInterception,
} from '../core/interceptor';
import { AgentEventSpanListener } from './agent-event-span-listener';
import type { SpanLink } from './no-op-telemetry';
import { extractTraceParent } from './propagation';
import {
  applyCustomAttributes,
  errorMessage,
  injectSpanContext,
  parentContextForWorkflow,
  serializePayload,
  toError,
} from './span-helpers';
import type { ObservabilityState } from './types';
import { endAndRemoveWorkflowSpan, evictStaleWorkflowSpans } from './workflow-lifecycle';

export function buildWorkflowInterceptor(state: ObservabilityState): WorkflowInterceptor {
  return {
    workflowStart(
      interception: WorkflowStartInterception,
      next: (interception: WorkflowStartInterception) => void,
    ): void {
      evictStaleWorkflowSpans(state);

      const existingEntry = state.workflowSpans.get(interception.workflowId);
      if (existingEntry) {
        existingEntry.span.setStatus({ code: state.SpanStatusCode.OK });
        endAndRemoveWorkflowSpan(state, interception.workflowId);
      }

      const span = state.tracer.startSpan(`workflow:${interception.workflowType}`, {
        attributes: {
          'weft.workflow.id': interception.workflowId,
          'weft.workflow.type': interception.workflowType,
        },
      });

      state.workflowSpans.set(interception.workflowId, { span, createdAt: Date.now() });
      injectSpanContext(span, interception.headers);

      if (state.recordPayloads && interception.input !== undefined) {
        span.setAttribute(
          'weft.payload.input',
          serializePayload(interception.input, state.maxPayloadSize),
        );
      }

      applyCustomAttributes(state, span, interception);
      state.metrics.increment('weft.workflow.started');
      state.metrics.increment('weft.dpmo.operations');

      next(interception);
    },

    *activity(
      interception: ActivityInterception,
      next: (interception: ActivityInterception) => Generator<unknown, unknown, unknown>,
    ): Generator<unknown, unknown, unknown> {
      const span = state.tracer.startSpan(
        `activity:${interception.activityName}`,
        {
          attributes: {
            'weft.activity.name': interception.activityName,
            'weft.activity.attempt': interception.attempt,
          },
        },
        parentContextForWorkflow(state, interception.workflowId),
      );

      injectSpanContext(span, interception.headers);

      if (state.recordPayloads && interception.input !== undefined) {
        span.setAttribute(
          'weft.payload.input',
          serializePayload(interception.input, state.maxPayloadSize),
        );
      }

      applyCustomAttributes(state, span, interception);
      const startTime = Date.now();

      try {
        const result = yield* next(interception);
        span.setStatus({ code: state.SpanStatusCode.OK });
        state.metrics.record('weft.activity.duration', Date.now() - startTime);
        state.metrics.increment('weft.activity.attempts');
        span.end();
        return result;
      } catch (error) {
        span.setStatus({ code: state.SpanStatusCode.ERROR, message: errorMessage(error) });
        span.recordException(toError(error));
        span.end();
        throw error;
      }
    },

    *sleep(
      interception: SleepInterception,
      next: (interception: SleepInterception) => Generator<unknown, void, unknown>,
    ): Generator<unknown, void, unknown> {
      const span = state.tracer.startSpan(
        'sleep',
        {
          attributes: {
            'weft.sleep.duration': interception.duration,
          },
        },
        parentContextForWorkflow(state, interception.workflowId),
      );

      applyCustomAttributes(state, span, interception);

      try {
        yield* next(interception);
        span.setStatus({ code: state.SpanStatusCode.OK });
      } catch (error) {
        span.setStatus({ code: state.SpanStatusCode.ERROR, message: errorMessage(error) });
        span.recordException(toError(error));
        throw error;
      } finally {
        span.end();
      }
    },

    *waitForSignal(
      interception: SignalInterception,
      next: (interception: SignalInterception) => Generator<unknown, unknown, unknown>,
    ): Generator<unknown, unknown, unknown> {
      const span = state.tracer.startSpan(
        'waitForSignal',
        {
          attributes: {
            'weft.signal.name': interception.signalName,
          },
        },
        parentContextForWorkflow(state, interception.workflowId),
      );

      applyCustomAttributes(state, span, interception);

      try {
        const result = yield* next(interception);
        span.setStatus({ code: state.SpanStatusCode.OK });
        span.end();
        return result;
      } catch (error) {
        span.setStatus({ code: state.SpanStatusCode.ERROR, message: errorMessage(error) });
        span.recordException(toError(error));
        span.end();
        throw error;
      }
    },

    *agent(
      interception: AgentInterception,
      next: (interception: AgentInterception) => Generator<unknown, unknown, unknown>,
    ): Generator<unknown, unknown, unknown> {
      const span = state.tracer.startSpan(
        'agent',
        {
          attributes: {
            'weft.agent.model': interception.model,
          },
        },
        parentContextForWorkflow(state, interception.workflowId),
      );

      injectSpanContext(span, interception.headers);

      if (state.recordPayloads && interception.prompt) {
        span.setAttribute(
          'weft.agent.prompt',
          serializePayload(interception.prompt, state.maxPayloadSize),
        );
      }

      applyCustomAttributes(state, span, interception);

      const agentContext = state.trace.setSpan(state.api.context.ROOT_CONTEXT, span);
      const agentEventSpanListener = new AgentEventSpanListener(
        interception.workflowId,
        state,
        agentContext,
      );

      if (state.eventTarget) {
        state.eventTarget.addEventListener('agent:turn:started', agentEventSpanListener);
        state.eventTarget.addEventListener('agent:turn:completed', agentEventSpanListener);
        state.eventTarget.addEventListener('agent:tool:called', agentEventSpanListener);
        state.eventTarget.addEventListener('agent:tool:returned', agentEventSpanListener);
      }

      try {
        const result = yield* next(interception);
        span.setStatus({ code: state.SpanStatusCode.OK });
        span.end();
        return result;
      } catch (error) {
        span.setStatus({ code: state.SpanStatusCode.ERROR, message: errorMessage(error) });
        span.recordException(toError(error));
        span.end();
        throw error;
      } finally {
        if (state.eventTarget) {
          state.eventTarget.removeEventListener('agent:turn:started', agentEventSpanListener);
          state.eventTarget.removeEventListener('agent:turn:completed', agentEventSpanListener);
          state.eventTarget.removeEventListener('agent:tool:called', agentEventSpanListener);
          state.eventTarget.removeEventListener('agent:tool:returned', agentEventSpanListener);
        }

        agentEventSpanListener.endOrphanedSpans();
      }
    },

    async childWorkflow(
      interception: ChildWorkflowInterception,
      next: (interception: ChildWorkflowInterception) => Promise<unknown>,
    ): Promise<unknown> {
      const links: SpanLink[] = [];
      const parentTrace = extractTraceParent(interception.parentHeaders);
      if (parentTrace) {
        links.push({
          context: {
            traceId: parentTrace.traceId,
            spanId: parentTrace.spanId,
            traceFlags: parentTrace.traceFlags,
          },
        });
      }

      const span = state.tracer.startSpan(
        `childWorkflow:${interception.workflowType}`,
        {
          attributes: {
            'weft.child_workflow.type': interception.workflowType,
            'weft.child_workflow.id': interception.childWorkflowId,
            'weft.child_workflow.parent_id': interception.workflowId,
          },
          links,
        },
        state.api.context.ROOT_CONTEXT,
      );

      injectSpanContext(span, interception.headers);

      if (state.recordPayloads && interception.input !== undefined) {
        span.setAttribute(
          'weft.payload.input',
          serializePayload(interception.input, state.maxPayloadSize),
        );
      }

      state.metrics.increment('weft.child_workflow.started');

      try {
        const result = await next(interception);
        span.setStatus({ code: state.SpanStatusCode.OK });
        span.end();
        return result;
      } catch (error) {
        span.setStatus({ code: state.SpanStatusCode.ERROR, message: errorMessage(error) });
        span.recordException(toError(error));
        span.end();
        throw error;
      }
    },

    signalReceived(
      interception: SignalReceivedInterception,
      next: (interception: SignalReceivedInterception) => void,
    ): void {
      const span = state.tracer.startSpan(`signal:received:${interception.signalName}`, {
        attributes: {
          'weft.signal.name': interception.signalName,
          'weft.signal.workflow_id': interception.workflowId,
        },
      });

      applyCustomAttributes(state, span, interception);

      try {
        next(interception);
        span.setStatus({ code: state.SpanStatusCode.OK });
        span.end();
      } catch (error) {
        span.setStatus({ code: state.SpanStatusCode.ERROR, message: errorMessage(error) });
        span.recordException(toError(error));
        span.end();
        throw error;
      }
    },
  };
}
