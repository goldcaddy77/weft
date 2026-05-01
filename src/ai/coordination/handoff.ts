import { executeAgentLoop } from '../agent.ts';
import { summarizeConversation } from './conversation.ts';
import type { HandoffOptions, HandoffResult } from './types.ts';

/**
 * Hand off execution to another agent, optionally forwarding context.
 *
 * @example Hand off with a conversation summary
 * ```ts
 * import { handoff, defineAgent } from 'weft';
 * import type { LLMProvider } from 'weft';
 *
 * declare const provider: LLMProvider;
 *
 * const summaryAgent = defineAgent({ name: 'summarizer', model: 'claude-haiku-3-5' });
 *
 * const { result } = await handoff({
 *   agent: summaryAgent,
 *   input: 'Summarize the key decisions.',
 *   provider,
 *   forwardContext: 'summary',
 *   parentConversation: [{ role: 'user', content: 'We decided X.' }],
 * });
 *
 * console.log(result.content);
 * ```
 */
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
