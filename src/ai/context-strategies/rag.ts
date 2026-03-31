/**
 * RAG (Retrieval-Augmented Generation) context strategy.
 *
 * Replaces the full conversation history with the system prompt,
 * semantically relevant chunks retrieved from a vector store, and the
 * most recent N messages. This keeps the context focused on what the
 * model actually needs to answer the latest query.
 *
 * @module rag
 */

import type { CompactOptions, ContextStrategy } from '../context-window.ts';
import type { Message } from '../providers/types.ts';

/**
 * Minimal vector store interface for retrieval. Implementations can
 * wrap any embedding database (Pinecone, Chroma, a local HNSW index,
 * etc.).
 */
export interface VectorStore {
  search(query: string, topK: number): Promise<string[]>;
}

export interface RAGStrategyOptions {
  /** Vector store to query for relevant chunks. */
  vectorStore: VectorStore;
  /** Number of top results to retrieve from the vector store. */
  topK: number;
  /** Number of recent non-system messages to preserve verbatim. */
  keepRecent: number;
}

/**
 * Create a context strategy that uses retrieval-augmented generation.
 *
 * The output conversation is structured as:
 * 1. Original system prompt (if present)
 * 2. A system message containing retrieved context chunks
 * 3. The most recent N messages
 */
export function createRAGStrategy(options: RAGStrategyOptions): ContextStrategy {
  const { vectorStore, topK, keepRecent } = options;

  return {
    async *compact(
      messages: Message[],
      _compactOptions: CompactOptions,
    ): AsyncGenerator<Message[], Message[], unknown> {
      if (messages.length === 0) {
        yield messages;
        return messages;
      }

      const hasSystemMessage = messages[0]?.role === 'system';
      const systemMessage = hasSystemMessage ? messages[0]! : null;
      const nonSystemMessages = hasSystemMessage ? messages.slice(1) : messages;

      // Nothing to compact if we have fewer messages than keepRecent
      if (nonSystemMessages.length <= keepRecent) {
        yield messages;
        return messages;
      }

      const recentMessages = nonSystemMessages.slice(-keepRecent);

      // Build query from recent message content
      const query = recentMessages.map((message) => message.content).join('\n');
      const chunks = await vectorStore.search(query, topK);

      const result: Message[] = [];
      if (systemMessage) {
        result.push(systemMessage);
      }

      if (chunks.length > 0) {
        const contextMessage: Message = {
          role: 'system',
          content: `Relevant context from conversation history:\n\n${chunks.join('\n\n')}`,
        };
        result.push(contextMessage);
      }

      result.push(...recentMessages);

      yield result;
      return result;
    },
  };
}
