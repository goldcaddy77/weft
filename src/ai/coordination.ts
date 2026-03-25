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
import type { AgentDefinition } from './declaration';
import type { LLMProvider } from './providers/interface';
import type { Message } from './providers/types';

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
}

export interface DebateOptions {
  advocate: AgentDefinition;
  critic: AgentDefinition;
  judge: AgentDefinition;
  topic: string;
  /** Number of advocate-critic rounds before the judge renders a verdict. */
  rounds: number;
  provider: LLMProvider;
}

export interface SuperviseOptions {
  workers: AgentDefinition[];
  supervisor: AgentDefinition;
  input: string;
  strategy: 'consensus' | 'best-of-n' | 'merge';
  provider: LLMProvider;
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
  const { agent, input, provider, forwardContext = 'none', parentConversation = [] } = options;

  let effectiveInput: string;

  switch (forwardContext) {
    case 'full': {
      const transcript = parentConversation
        .map((message) => `${message.role}: ${message.content}`)
        .join('\n');
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
  const { advocate, critic, judge, topic, rounds: roundCount, provider } = options;

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
// supervise
// ---------------------------------------------------------------------------

/** Run supervised multi-agent execution with synthesis. */
export async function supervise(options: SuperviseOptions): Promise<SuperviseResult> {
  const { workers, supervisor, input, strategy, provider } = options;

  // Run all workers in parallel
  const workerResults = await Promise.all(
    workers.map((worker) =>
      executeAgentLoop(
        {
          model: worker.model,
          provider,
          systemPrompt: worker.systemPrompt,
          tools: worker.tools,
          maxTurns: worker.maxTurns,
        },
        input,
      ),
    ),
  );

  let finalResult: string;

  switch (strategy) {
    case 'consensus': {
      // Check if all workers produced the same response
      const allResponses = workerResults.map((result) => result.content);
      const allAgree = allResponses.every((response) => response === allResponses[0]);

      if (allAgree) {
        finalResult = allResponses[0]!;
      } else {
        // Workers disagree; ask supervisor to resolve
        const workerSummary = allResponses
          .map((response, index) => `Worker ${index + 1}: ${response}`)
          .join('\n\n');

        const supervisorInput = `The following workers were asked: "${input}"\n\nTheir responses:\n${workerSummary}\n\nThe workers disagree. Please determine the correct answer.`;

        const supervisorResult = await executeAgentLoop(
          {
            model: supervisor.model,
            provider,
            systemPrompt: supervisor.systemPrompt,
            tools: supervisor.tools,
            maxTurns: supervisor.maxTurns,
          },
          supervisorInput,
        );

        finalResult = supervisorResult.content;
      }
      break;
    }

    case 'best-of-n': {
      const workerSummary = workerResults
        .map((result, index) => `Worker ${index + 1}: ${result.content}`)
        .join('\n\n');

      const supervisorInput = `The following workers were asked: "${input}"\n\nTheir responses:\n${workerSummary}\n\nPick the best response and explain why.`;

      const supervisorResult = await executeAgentLoop(
        {
          model: supervisor.model,
          provider,
          systemPrompt: supervisor.systemPrompt,
          tools: supervisor.tools,
          maxTurns: supervisor.maxTurns,
        },
        supervisorInput,
      );

      finalResult = supervisorResult.content;
      break;
    }

    case 'merge': {
      const workerSummary = workerResults
        .map((result, index) => `Worker ${index + 1}: ${result.content}`)
        .join('\n\n');

      const supervisorInput = `The following workers were asked: "${input}"\n\nTheir responses:\n${workerSummary}\n\nMerge these responses into a single comprehensive answer.`;

      const supervisorResult = await executeAgentLoop(
        {
          model: supervisor.model,
          provider,
          systemPrompt: supervisor.systemPrompt,
          tools: supervisor.tools,
          maxTurns: supervisor.maxTurns,
        },
        supervisorInput,
      );

      finalResult = supervisorResult.content;
      break;
    }
  }

  return {
    finalResult,
    workerResults,
    strategy,
  };
}
