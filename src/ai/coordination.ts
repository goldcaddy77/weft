/**
 * Multi-agent coordination primitives: handoff, debate, and supervise.
 *
 * These functions orchestrate multiple agent executions in patterns such as
 * sequential handoffs, adversarial debates, and supervised parallel work.
 *
 * @module coordination
 */

import type { AgentResult } from './agent';
import { executeAgentLoop } from './agent';
import type { BudgetTracker } from './budget';
import { confidenceWeightedConsensus } from './confidence-voting';
import type { AgentDefinition } from './declaration';
import type { LLMProvider } from './providers/interface';
import type { Message } from './providers/types';

// ---------------------------------------------------------------------------
// Trace context propagation
// ---------------------------------------------------------------------------

/**
 * Create a new headers map for a child agent, preserving trace context from
 * the parent workflow's headers. This ensures OpenTelemetry spans from child
 * agents link back to the parent agent's span.
 */
export function createChildHeaders(parentHeaders?: Map<string, string>): Map<string, string> {
  const childHeaders = new Map<string, string>();
  if (!parentHeaders) return childHeaders;

  // Forward the W3C traceparent header so the child agent's spans
  // participate in the same trace.
  const traceparent = parentHeaders.get('traceparent');
  if (traceparent) {
    childHeaders.set('traceparent', traceparent);
  }

  // Forward tracestate if present (W3C Trace Context Level 2).
  const tracestate = parentHeaders.get('tracestate');
  if (tracestate) {
    childHeaders.set('tracestate', tracestate);
  }

  return childHeaders;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ForwardContext = 'full' | 'summary' | 'none';

export interface HandoffOptions {
  agent: AgentDefinition;
  input: string;
  provider: LLMProvider;
  forwardContext?: ForwardContext;
  parentConversation?: Message[];
  /** Shared budget tracker. Child agent usage accumulates here. */
  budget?: BudgetTracker | undefined;
  /** Abort signal propagated to the child agent. */
  signal?: AbortSignal | undefined;
  /** Trace context headers from the parent workflow, used for OTel propagation. */
  headers?: Map<string, string> | undefined;
}

export interface DebateOptions {
  advocate: AgentDefinition;
  critic: AgentDefinition;
  judge: AgentDefinition;
  topic: string;
  /** Number of advocate-critic rounds before the judge renders a verdict. */
  rounds: number;
  provider: LLMProvider;
  /** Shared budget tracker. All round usage accumulates here. */
  budget?: BudgetTracker | undefined;
  /** Abort signal propagated to all agents. */
  signal?: AbortSignal | undefined;
}

export interface SuperviseOptions {
  workers: AgentDefinition[];
  supervisor: AgentDefinition;
  input: string;
  strategy: 'consensus' | 'best-of-n' | 'merge';
  provider: LLMProvider;
  /** Shared budget tracker. All worker usage accumulates here. */
  budget?: BudgetTracker | undefined;
  /** Abort signal propagated to all workers and supervisor. */
  signal?: AbortSignal | undefined;
  /**
   * Voting algorithm used during the `consensus` strategy.
   * - `'naive'` (default): workers must produce identical strings to agree.
   * - `'confidence-weighted'`: groups by exact content; winner is the group
   *   with the highest total confidence weight.
   */
  voting?: 'naive' | 'confidence-weighted' | undefined;
  /**
   * Override the effective worker count at runtime.
   * - A number: trim or round-robin-replicate `workers` to this length.
   * - A function: called with the input string; return value is used as the count.
   * Clamped to a minimum of 1.
   */
  n?: number | ((input: string) => number) | undefined;
}

export interface HandoffResult {
  result: AgentResult;
  contextForwarded: ForwardContext;
}

export interface DebateResult {
  verdict: string;
  rounds: DebateRound[];
  judgeResult: AgentResult;
}

export interface DebateRound {
  roundIndex: number;
  advocateResponse: string;
  criticResponse: string;
}

export interface SuperviseResult {
  finalResult: string;
  workerResults: AgentResult[];
  strategy: string;
}

// ---------------------------------------------------------------------------
// summarizeConversation
// ---------------------------------------------------------------------------

/** Summarize a conversation to a single string (for context forwarding). */
export function summarizeConversation(messages: Message[]): string {
  if (messages.length === 0) return '';

  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    lines.push(`${message.role}: ${message.content}`);
  }
  return `Conversation summary:\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// handoff
// ---------------------------------------------------------------------------

/** Hand off execution to another agent, optionally forwarding context. */
export async function handoff(options: HandoffOptions): Promise<HandoffResult> {
  const {
    agent,
    input,
    provider,
    forwardContext = 'none',
    parentConversation = [],
    budget,
    signal,
  } = options;

  let effectiveInput: string;

  switch (forwardContext) {
    case 'full': {
      const transcriptLines: string[] = [];
      for (const message of parentConversation) {
        transcriptLines.push(`${message.role}: ${message.content}`);
      }
      const transcript = transcriptLines.join('\n');
      effectiveInput = `Context from previous conversation:\n${transcript}\n\nCurrent task: ${input}`;
      break;
    }
    case 'summary': {
      const summary = summarizeConversation(parentConversation);
      effectiveInput = `Context: ${summary}\n\nCurrent task: ${input}`;
      break;
    }
    case 'none':
    default:
      effectiveInput = input;
      break;
  }

  const result = await executeAgentLoop(
    {
      model: agent.model,
      provider,
      systemPrompt: agent.systemPrompt,
      tools: agent.tools,
      maxTurns: agent.maxTurns,
      budget,
      signal,
    },
    effectiveInput,
  );

  return {
    result,
    contextForwarded: forwardContext,
  };
}

// ---------------------------------------------------------------------------
// debate
// ---------------------------------------------------------------------------

/** Run adversarial multi-agent debate. */
export async function debate(options: DebateOptions): Promise<DebateResult> {
  const { advocate, critic, judge, topic, rounds: roundCount, provider, budget, signal } = options;

  const debateRounds: DebateRound[] = [];
  let transcript = `Topic: ${topic}\n\n`;

  for (let roundIndex = 0; roundIndex < roundCount; roundIndex++) {
    // Build the advocate prompt with context from previous rounds
    const advocateInput =
      roundIndex === 0
        ? `Argue in favor of the following topic:\n\n${topic}`
        : `${transcript}\nContinue arguing in favor of the topic. Address the critic's latest points.`;

    const advocateResult = await executeAgentLoop(
      {
        model: advocate.model,
        provider,
        systemPrompt: advocate.systemPrompt,
        tools: advocate.tools,
        maxTurns: advocate.maxTurns,
        budget,
        signal,
      },
      advocateInput,
    );

    const advocateResponse = advocateResult.content;
    transcript += `Round ${roundIndex + 1} - Advocate: ${advocateResponse}\n\n`;

    // Run critic with the advocate's response
    const criticInput = `${transcript}\nCritique the advocate's argument above. Point out flaws and weaknesses.`;

    const criticResult = await executeAgentLoop(
      {
        model: critic.model,
        provider,
        systemPrompt: critic.systemPrompt,
        tools: critic.tools,
        maxTurns: critic.maxTurns,
        budget,
        signal,
      },
      criticInput,
    );

    const criticResponse = criticResult.content;
    transcript += `Round ${roundIndex + 1} - Critic: ${criticResponse}\n\n`;

    debateRounds.push({
      roundIndex,
      advocateResponse,
      criticResponse,
    });
  }

  // Run judge with full transcript
  const judgeInput = `${transcript}\nBased on the debate above, render your verdict.`;

  const judgeResult = await executeAgentLoop(
    {
      model: judge.model,
      provider,
      systemPrompt: judge.systemPrompt,
      tools: judge.tools,
      maxTurns: judge.maxTurns,
      budget,
      signal,
    },
    judgeInput,
  );

  return {
    verdict: judgeResult.content,
    rounds: debateRounds,
    judgeResult,
  };
}

// ---------------------------------------------------------------------------
// supervise — helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the effective worker list from a `SuperviseOptions.n` override.
 * - When `n` is a number: trim or round-robin-replicate `workers` to that length.
 * - When `n` is a function: call it with `input` to obtain the count.
 * - Clamped to a minimum of 1.
 */
function resolveWorkers(
  workers: AgentDefinition[],
  n: number | ((input: string) => number) | undefined,
  input: string,
): AgentDefinition[] {
  if (n === undefined) return workers;

  const effectiveCount = Math.max(1, typeof n === 'function' ? n(input) : n);
  if (effectiveCount <= workers.length) {
    return workers.slice(0, effectiveCount);
  }
  // Round-robin replicate to fill up to effectiveCount.
  const expanded: AgentDefinition[] = [];
  for (let index = 0; index < effectiveCount; index++) {
    expanded.push(workers[index % workers.length]!);
  }
  return expanded;
}

/**
 * Determine the consensus winner for the `consensus` strategy.
 * Returns `null` when workers disagree (or there is a confidence tie),
 * signalling that the supervisor should be invoked.
 */
function resolveConsensusWinner(
  results: AgentResult[],
  voting: 'naive' | 'confidence-weighted' | undefined,
): string | null {
  if (voting === 'confidence-weighted') {
    return confidenceWeightedConsensus(results).winner;
  }
  // Naive default: unanimous exact-string agreement required.
  const allAgree = results.every((r) => r.content === results[0]!.content);
  return allAgree ? (results[0]?.content ?? null) : null;
}

// ---------------------------------------------------------------------------
// supervise
// ---------------------------------------------------------------------------

/** Run supervised multi-agent execution with synthesis. */
export async function supervise(options: SuperviseOptions): Promise<SuperviseResult> {
  const {
    workers: rawWorkers,
    supervisor,
    input,
    strategy,
    provider,
    budget,
    signal: parentSignal,
    voting,
    n,
  } = options;

  const workers = resolveWorkers(rawWorkers, n, input);

  // Unlike handoff/debate (sequential), supervise runs workers in parallel via
  // Promise.all. A dedicated AbortController lets budget exhaustion in one
  // branch abort all other in-flight branches — something a passthrough signal
  // can't do because the budget tracker needs its own controller to fire abort.
  const controller = new AbortController();
  const onParentAbort = parentSignal ? () => controller.abort(parentSignal.reason) : undefined;

  // Wire budget enforcement: exceeding the budget aborts all parallel branches.
  // Scoped to this call — cleared in finally so a shared BudgetTracker isn't
  // left referencing a stale controller after supervise() returns.
  if (budget) {
    budget.setAbortController(controller);
  }

  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort(parentSignal.reason);
    } else {
      parentSignal.addEventListener('abort', onParentAbort!, { once: true });
    }
  }

  const signal = controller.signal;

  try {
    // Run all workers in parallel
    const workerPromises: Promise<AgentResult>[] = [];
    for (const worker of workers) {
      workerPromises.push(
        executeAgentLoop(
          {
            model: worker.model,
            provider,
            systemPrompt: worker.systemPrompt,
            tools: worker.tools,
            maxTurns: worker.maxTurns,
            budget,
            signal,
          },
          input,
        ),
      );
    }

    const workerResults = await Promise.all(workerPromises);

    // If the budget was exhausted during the worker phase, the signal is
    // already aborted. Throw now rather than silently running the supervisor
    // with a dead signal (which would return empty content).
    signal.throwIfAborted();

    let finalResult: string;

    switch (strategy) {
      case 'consensus': {
        const consensusWinner = resolveConsensusWinner(workerResults, voting);

        if (consensusWinner !== null) {
          finalResult = consensusWinner;
        } else {
          // Workers disagree (or confidence-weighted voting was a tie);
          // ask the supervisor to resolve.
          const workerSummaryLines: string[] = [];
          for (const [index, result] of workerResults.entries()) {
            workerSummaryLines.push(`Worker ${index + 1}: ${result.content}`);
          }
          const workerSummary = workerSummaryLines.join('\n\n');

          const supervisorInput = `The following workers were asked: "${input}"\n\nTheir responses:\n${workerSummary}\n\nThe workers disagree. Please determine the correct answer.`;

          const supervisorResult = await executeAgentLoop(
            {
              model: supervisor.model,
              provider,
              systemPrompt: supervisor.systemPrompt,
              tools: supervisor.tools,
              maxTurns: supervisor.maxTurns,
              budget,
              signal,
            },
            supervisorInput,
          );

          finalResult = supervisorResult.content;
        }
        break;
      }

      case 'best-of-n': {
        const workerSummaryLines: string[] = [];
        for (const [index, result] of workerResults.entries()) {
          workerSummaryLines.push(`Worker ${index + 1}: ${result.content}`);
        }
        const workerSummary = workerSummaryLines.join('\n\n');

        const supervisorInput = `The following workers were asked: "${input}"\n\nTheir responses:\n${workerSummary}\n\nPick the best response and explain why.`;

        const supervisorResult = await executeAgentLoop(
          {
            model: supervisor.model,
            provider,
            systemPrompt: supervisor.systemPrompt,
            tools: supervisor.tools,
            maxTurns: supervisor.maxTurns,
            budget,
            signal,
          },
          supervisorInput,
        );

        finalResult = supervisorResult.content;
        break;
      }

      case 'merge': {
        const workerSummaryLines: string[] = [];
        for (const [index, result] of workerResults.entries()) {
          workerSummaryLines.push(`Worker ${index + 1}: ${result.content}`);
        }
        const workerSummary = workerSummaryLines.join('\n\n');

        const supervisorInput = `The following workers were asked: "${input}"\n\nTheir responses:\n${workerSummary}\n\nMerge these responses into a single comprehensive answer.`;

        const supervisorResult = await executeAgentLoop(
          {
            model: supervisor.model,
            provider,
            systemPrompt: supervisor.systemPrompt,
            tools: supervisor.tools,
            maxTurns: supervisor.maxTurns,
            budget,
            signal,
          },
          supervisorInput,
        );

        finalResult = supervisorResult.content;
        break;
      }

      default:
        throw new Error(`Unknown supervise strategy: ${strategy as string}`);
    }

    return {
      finalResult,
      workerResults,
      strategy,
    };
  } finally {
    if (parentSignal && onParentAbort) {
      parentSignal.removeEventListener('abort', onParentAbort);
    }
    // Detach so a shared BudgetTracker isn't left with a stale controller.
    if (budget) {
      budget.setAbortController(new AbortController());
    }
  }
}
