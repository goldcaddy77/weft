import type { Message } from '../../ai/agent/index.ts';

/**
 * Per-turn aggregate built from agent events. Held in `workflow-detail-agent.svelte`
 * as a durable `$state` object that survives event-buffer eviction.
 */
export interface AgentTurnData {
  turnIndex: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: Array<{ name: string; input: unknown; output: unknown }>;
  response: string;
  /**
   * Cumulative conversation snapshot at the moment this turn completed,
   * truncated per the caps in `src/ai/event-message-snapshot.ts`. Empty for
   * legacy events that pre-date the snapshot field.
   */
  messages: Message[];
  /**
   * Provider reasoning/thinking trace for this turn. Empty string if the turn
   * did not produce a trace or the provider did not surface one.
   */
  reasoningTrace: string;
}
