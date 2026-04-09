/**
 * Byzantine Fault Tolerance (BFT) scenario tests for confidence-weighted voting.
 *
 * Verifies that confidence-weighted consensus correctly identifies the honest
 * minority answer even when a naive plurality would pick the wrong answer.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';

import type { AgentResult } from '../agent';
import { defineAgent } from '../declaration';
import type { LLMProvider } from '../providers/interface';
import type { ChatResponse } from '../providers/types';

// ---------------------------------------------------------------------------
// Module mock: replace executeAgentLoop with a controllable stub.
// Each call pops the next result from a queue set up per test.
// ---------------------------------------------------------------------------

const agentResultQueue: AgentResult[] = [];

mock.module('../agent', () => ({
  executeAgentLoop: async (): Promise<AgentResult> => {
    const next = agentResultQueue.shift();
    if (!next) throw new Error('agentResultQueue is empty — add more results for this test');
    return next;
  },
}));

// Import coordination AFTER mocking so it picks up the mocked executeAgentLoop.
const { supervise } = await import('../coordination');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgentResult(content: string, confidence?: number): AgentResult {
  return {
    content,
    conversation: [],
    totalTokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    totalCost: 0,
    turnCount: 1,
    reasoningTraces: [],
    turnCosts: [],
    confidence,
  };
}

/** Minimal stub provider — never called because executeAgentLoop is mocked. */
const stubProvider: LLMProvider = {
  name: 'stub',
  async chat(): Promise<ChatResponse> {
    throw new Error('stubProvider.chat should not be called in BFT tests');
  },
  async stream() {
    return new ReadableStream();
  },
  async countTokens(): Promise<number> {
    return 0;
  },
};

const workerAgent = defineAgent({ name: 'worker', model: 'test-model' });
const supervisorAgent = defineAgent({ name: 'supervisor', model: 'test-model' });

// ---------------------------------------------------------------------------
// BFT: 5 agents, 3 byzantine (plurality) vs 2 honest (confident minority)
//
// Scenario design:
//   - 3 byzantine agents: wrong answer, low confidence (0.2 each) → total weight 0.6
//   - 2 honest agents:    correct answer, high confidence (0.9 each) → total weight 1.8
//
// Naive plurality: wrong answer wins (3 > 2), so supervise falls through to supervisor
//   which, by majority, also returns the wrong answer.
// Confidence-weighted: correct answer wins (1.8 > 0.6), no supervisor needed.
// ---------------------------------------------------------------------------

describe('BFT: 5 agents, 3 byzantine plurality vs 2 confident honest minority', () => {
  beforeEach(() => {
    agentResultQueue.length = 0;
  });

  it('(a) confidence-weighted voting picks the honest minority over the byzantine plurality', async () => {
    // 3 byzantine: wrong answer, low confidence
    // 2 honest: correct answer, high confidence
    // confidence-weighted: correct (1.8) beats wrong (0.6) → no supervisor
    agentResultQueue.push(
      makeAgentResult('wrong answer', 0.2), // byzantine
      makeAgentResult('wrong answer', 0.2), // byzantine
      makeAgentResult('wrong answer', 0.2), // byzantine
      makeAgentResult('correct answer', 0.9), // honest
      makeAgentResult('correct answer', 0.9), // honest
    );

    const result = await supervise({
      workers: [workerAgent, workerAgent, workerAgent, workerAgent, workerAgent],
      supervisor: supervisorAgent,
      input: 'What is the answer?',
      strategy: 'consensus',
      voting: 'confidence-weighted',
      provider: stubProvider,
    });

    expect(result.finalResult).toBe('correct answer');
  });

  it('(b) naive consensus defers to supervisor when workers disagree, yielding the wrong answer', async () => {
    // Same 3 byzantine vs 2 honest split — naive sees disagreement and asks supervisor.
    // Supervisor (mocked) returns the wrong answer (representing majority-biased supervisor).
    agentResultQueue.push(
      makeAgentResult('wrong answer'), // byzantine
      makeAgentResult('wrong answer'), // byzantine
      makeAgentResult('wrong answer'), // byzantine
      makeAgentResult('correct answer'), // honest
      makeAgentResult('correct answer'), // honest
      makeAgentResult('wrong answer'), // supervisor goes with majority
    );

    const result = await supervise({
      workers: [workerAgent, workerAgent, workerAgent, workerAgent, workerAgent],
      supervisor: supervisorAgent,
      input: 'What is the answer?',
      strategy: 'consensus',
      // no voting option — defaults to naive
      provider: stubProvider,
    });

    // Naive consensus sees disagreement, falls through to supervisor which returns the
    // wrong answer — demonstrating why confidence-weighted voting is necessary.
    expect(result.finalResult).toBe('wrong answer');
  });
});
