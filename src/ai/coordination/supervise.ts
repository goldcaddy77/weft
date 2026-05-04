import { executeAgentLoop } from '../agent.ts';
import type { AgentResult } from '../agent/types.ts';
import {
  formatWorkerSummary,
  resolveConsensusWinner,
  resolveWorkers,
} from './supervise-helpers.ts';
import type { SuperviseOptions, SuperviseResult } from './types.ts';

/**
 * Run supervised multi-agent execution with synthesis.
 *
 * @example Run three workers in parallel and merge their answers
 * ```ts
 * import { supervise, defineAgent } from 'weft';
 * import type { LLMProvider } from 'weft';
 *
 * declare const provider: LLMProvider;
 *
 * const worker     = defineAgent({ name: 'worker',     model: 'claude-haiku-3-5' });
 * const supervisor = defineAgent({ name: 'supervisor', model: 'claude-sonnet-4-5' });
 *
 * const { finalResult, workerResults } = await supervise({
 *   workers: [worker, worker, worker],
 *   supervisor,
 *   input: 'List three use cases for durable workflows.',
 *   strategy: 'merge',
 *   provider,
 * });
 *
 * console.log('Merged answer:', finalResult);
 * console.log('Worker responses:', workerResults.length);
 * ```
 */
// oxlint-disable-next-line complexity -- ID:ai-coordination-supervise-complexity
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
          const workerSummary = formatWorkerSummary(workerResults);
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
        const workerSummary = formatWorkerSummary(workerResults);
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
        const workerSummary = formatWorkerSummary(workerResults);
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
    // Detach only if the budget's current signal is the one this call installed.
    // Without this check, two concurrent supervise() calls sharing the same
    // budget would race: the first to finish would overwrite the controller
    // the second is still using.
    if (budget && budget.signal === controller.signal) {
      budget.setAbortController(new AbortController());
    }
  }
}
