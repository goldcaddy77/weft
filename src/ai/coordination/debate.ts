import { executeAgentLoop } from '../agent.ts';
import type { DebateOptions, DebateResult, DebateRound } from './types.ts';

/**
 * Run adversarial multi-agent debate.
 *
 * @example Two-round debate between an advocate and a critic, judged by a third agent
 * ```ts
 * import { debate, defineAgent } from 'weft';
 * import type { LLMProvider } from 'weft';
 *
 * declare const provider: LLMProvider;
 *
 * const advocate = defineAgent({ name: 'advocate', model: 'claude-sonnet-4-5', systemPrompt: 'Argue for.' });
 * const critic   = defineAgent({ name: 'critic',   model: 'claude-sonnet-4-5', systemPrompt: 'Argue against.' });
 * const judge    = defineAgent({ name: 'judge',    model: 'claude-sonnet-4-5', systemPrompt: 'Render a verdict.' });
 *
 * const { verdict, rounds } = await debate({ advocate, critic, judge, topic: 'AI is beneficial', rounds: 2, provider });
 * console.log('Verdict:', verdict);
 * console.log('Rounds completed:', rounds.length);
 * ```
 */
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
