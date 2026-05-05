import type { AgentResult, LLMProvider, Message } from '../agent/types.ts';
import type { AgentDefinition } from '../declaration.ts';

export type ForwardContext = 'full' | 'summary' | 'none';

export interface HandoffOptions {
  agent: AgentDefinition;
  input: string;
  provider: LLMProvider;
  forwardContext?: ForwardContext;
  parentConversation?: Message[];
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
  /** Abort signal propagated to all agents. */
  signal?: AbortSignal | undefined;
}

export interface SuperviseOptions {
  workers: AgentDefinition[];
  supervisor: AgentDefinition;
  input: string;
  strategy: 'consensus' | 'best-of-n' | 'merge';
  provider: LLMProvider;
  /** Abort signal propagated to all workers and supervisor. */
  signal?: AbortSignal | undefined;
  /**
   * Voting algorithm used during the `consensus` strategy.
   * The shrunken agent result no longer carries confidence, so both options
   * currently require exact-string agreement.
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
