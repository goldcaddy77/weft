import type {
  DebateOptions,
  DebateResult,
  HandoffOptions,
  HandoffResult,
  SuperviseOptions,
  SuperviseResult,
} from '../../ai/coordination/index.ts';
import type { Context } from './index.ts';
import type { ContextInternals } from './internals.ts';
import type { ContextOperationRequest } from './operation-request.ts';
import type { AgentContextOptions } from './types.ts';
import { captureCallerStack } from './validation.ts';

export function* agent(
  context: Context,
  internals: ContextInternals,
  options: AgentContextOptions,
): Generator<ContextOperationRequest, unknown, unknown> {
  const step = internals.stepIndex++;

  if (internals.accumulatedResults?.has(step)) {
    if (internals.explainMode) {
      console.log(
        `[weft] ctx.agent(model="${options.model}") → Returning cached result from step ${step}`,
      );
    }
    return internals.accumulatedResults.get(step);
  }

  if (internals.explainMode) {
    const toolCount = options.tools?.length ?? 0;
    const maxTurns = options.maxTurns ?? 'default';
    console.log(`[weft] ctx.agent(model="${options.model}")`);
    console.log(`  → Creating checkpoint at step ${step}`);
    console.log(`  → Starting agent loop with ${toolCount} tool(s), maxTurns=${maxTurns}`);
  }

  const operationId = crypto.randomUUID();
  const callerStack = captureCallerStack();
  const result = yield {
    type: 'agent' as const,
    operationId,
    stepIndex: step,
    options,
    callerStack,
  };

  context.accumulatedResults.set(step, result);
  return result;
}

export function* speculate<TResult>(
  context: Context,
  internals: ContextInternals,
  execute: (
    context: Context,
  ) =>
    | Generator<ContextOperationRequest, TResult, unknown>
    | AsyncGenerator<unknown, TResult, unknown>,
): Generator<ContextOperationRequest, TResult, unknown> {
  const step = internals.stepIndex++;

  if (internals.accumulatedResults?.has(step)) {
    return internals.accumulatedResults.get(step) as TResult;
  }

  const operationId = crypto.randomUUID();
  const callerStack = captureCallerStack();
  const result = yield {
    type: 'speculate' as const,
    operationId,
    execute,
    callerStack,
  };

  context.accumulatedResults.set(step, result);
  return result as TResult;
}

export function* handoff(
  context: Context,
  internals: ContextInternals,
  options: HandoffOptions,
): Generator<ContextOperationRequest, HandoffResult, unknown> {
  const step = internals.stepIndex++;

  if (internals.accumulatedResults?.has(step)) {
    return internals.accumulatedResults.get(step) as HandoffResult;
  }

  if (internals.explainMode) {
    console.log(`[weft] ctx.handoff("${options.agent.name}")`);
    console.log(`  → Creating checkpoint at step ${step}`);
    console.log(
      `  → Handing off to agent "${options.agent.name}" with context=${options.forwardContext ?? 'none'}`,
    );
  }

  const operationId = crypto.randomUUID();
  const callerStack = captureCallerStack();
  const result = yield {
    type: 'handoff' as const,
    operationId,
    options,
    callerStack,
  };

  context.accumulatedResults.set(step, result);
  return result as HandoffResult;
}

export function* debate(
  context: Context,
  internals: ContextInternals,
  options: DebateOptions,
): Generator<ContextOperationRequest, DebateResult, unknown> {
  const step = internals.stepIndex++;

  if (internals.accumulatedResults?.has(step)) {
    return internals.accumulatedResults.get(step) as DebateResult;
  }

  if (internals.explainMode) {
    console.log(`[weft] ctx.debate("${options.topic}")`);
    console.log(`  → Creating checkpoint at step ${step}`);
    console.log(`  → Running ${options.rounds} debate rounds`);
  }

  const operationId = crypto.randomUUID();
  const callerStack = captureCallerStack();
  const result = yield {
    type: 'debate' as const,
    operationId,
    options,
    callerStack,
  };

  context.accumulatedResults.set(step, result);
  return result as DebateResult;
}

export function* supervise(
  context: Context,
  internals: ContextInternals,
  options: SuperviseOptions,
): Generator<ContextOperationRequest, SuperviseResult, unknown> {
  const step = internals.stepIndex++;

  if (internals.accumulatedResults?.has(step)) {
    return internals.accumulatedResults.get(step) as SuperviseResult;
  }

  if (internals.explainMode) {
    console.log(`[weft] ctx.supervise("${options.strategy}")`);
    console.log(`  → Creating checkpoint at step ${step}`);
    console.log(
      `  → Running ${options.workers.length} workers with "${options.strategy}" strategy`,
    );
  }

  const operationId = crypto.randomUUID();
  const callerStack = captureCallerStack();
  const result = yield {
    type: 'supervise' as const,
    operationId,
    options,
    callerStack,
  };

  context.accumulatedResults.set(step, result);
  return result as SuperviseResult;
}
