/**
 * Byzantine Fault Tolerance (BFT) scenario tests for confidence-weighted voting.
 *
 * Verifies that confidence-weighted consensus correctly identifies the honest
 * majority answer even when a minority of agents produce wrong answers.
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
// BFT: 5 agents, 1 byzantine
// ---------------------------------------------------------------------------

describe('BFT: 5 agents, 1 byzantine with confidence-weighted voting', () => {
  beforeEach(() => {
    agentResultQueue.length = 0;
  });

  it('(a) confidence-weighted voting returns the correct answer despite 1 byzantine', async () => {
    // 4 honest agents produce the correct answer with confidence 0.9
    // 1 byzantine agent produces a wrong answer with any confidence
    agentResultQueue.push(
      makeAgentResult('correct answer', 0.9),
      makeAgentResult('correct answer', 0.9),
      makeAgentResult('correct answer', 0.9),
      makeAgentResult('correct answer', 0.9),
      makeAgentResult('wrong answer', 0.95), // byzantine: high confidence, wrong
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

  it('(b) naive consensus returns wrong answer when 3 byzantine agents outnumber 2 honest', async () => {
    // 3 byzantine agents produce the wrong answer
    // 2 honest agents produce the correct answer
    // naive consensus picks the plurality — which is the wrong answer
    agentResultQueue.push(
      makeAgentResult('wrong answer'),
      makeAgentResult('wrong answer'),
      makeAgentResult('wrong answer'),
      makeAgentResult('correct answer'),
      makeAgentResult('correct answer'),
      // supervisor is called because not all agree — returns the wrong answer
      // (simulating a supervisor that goes with the majority)
      makeAgentResult('wrong answer'),
    );

    const result = await supervise({
      workers: [workerAgent, workerAgent, workerAgent, workerAgent, workerAgent],
      supervisor: supervisorAgent,
      input: 'What is the answer?',
      strategy: 'consensus',
      // no voting option — defaults to naive
      provider: stubProvider,
    });

    // Without confidence-weighted voting, naive consensus defers to the
    // supervisor when workers disagree; the supervisor (mocked) returns the
    // wrong answer, representing a failure to identify the honest minority.
    expect(result.finalResult).toBe('wrong answer');
  });
});
