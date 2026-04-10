import { describe, expect, it } from 'bun:test';

import type { CounterMetric } from '../observability/metrics';
import { MetricsCollector } from '../observability/metrics';
import { PROMPT_CACHE_HIT_METRIC, PROMPT_CACHE_MISS_METRIC, PromptCache } from './prompt-cache';
import type { Message } from './providers/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function msg(role: Message['role'], content: string): Message {
  return { role, content };
}

const SYSTEM = msg('system', 'You are a helpful assistant.');
const TOOL_HINT = msg('user', 'Available tools: search, summarize.');
const TURN_1_USER = msg('user', 'Hello, who are you?');
const TURN_1_ASST = msg('assistant', 'I am a helpful assistant.');
const TURN_2_USER = msg('user', 'What can you do?');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PromptCache', () => {
  describe('empty cache → miss', () => {
    it('returns hit=false on first call', () => {
      const cache = new PromptCache();
      const { hit } = cache.annotate([SYSTEM, TURN_1_USER]);
      expect(hit).toBe(false);
    });

    it('does not add cache_control markers on a miss', () => {
      const cache = new PromptCache();
      const { messages } = cache.annotate([SYSTEM, TURN_1_USER]);
      for (const message of messages) {
        expect(message.providerMetadata).toBeUndefined();
      }
    });
  });

  describe('same messages twice → second call is a hit', () => {
    it('hit=true on the second identical call', () => {
      const cache = new PromptCache();
      const messages = [SYSTEM, TURN_1_USER, TURN_1_ASST];
      cache.annotate(messages);
      const { hit } = cache.annotate(messages);
      expect(hit).toBe(true);
    });

    it('cache_control marker appears on the last message of the sequence', () => {
      const cache = new PromptCache();
      const messages = [SYSTEM, TURN_1_USER, TURN_1_ASST];
      cache.annotate(messages);
      const { messages: annotated } = cache.annotate(messages);
      const last = annotated[annotated.length - 1];
      expect(last?.providerMetadata?.anthropic?.cacheControl.type).toBe('ephemeral');
    });
  });

  describe('shared prefix, different tail', () => {
    it('hit=true when the stable prefix was seen before', () => {
      const cache = new PromptCache();
      const prefix = [SYSTEM, TOOL_HINT];
      // First call — inserts the prefix
      cache.annotate([...prefix, TURN_1_USER]);
      // Second call with same prefix but different tail
      const { hit } = cache.annotate([...prefix, TURN_2_USER]);
      expect(hit).toBe(true);
    });

    it('cache_control marker is on the last message of the shared prefix', () => {
      const cache = new PromptCache();
      const prefix = [SYSTEM, TOOL_HINT];
      cache.annotate([...prefix, TURN_1_USER]);
      const { messages: annotated } = cache.annotate([...prefix, TURN_2_USER]);

      // The marker should be on TOOL_HINT (index 1), which is the end of the
      // shared prefix.
      expect(annotated[1]?.providerMetadata?.anthropic?.cacheControl.type).toBe('ephemeral');
      // The tail message (TURN_2_USER, index 2) must NOT carry a marker.
      expect(annotated[2]?.providerMetadata).toBeUndefined();
    });

    it('does not mutate the original message objects', () => {
      const cache = new PromptCache();
      const prefix = [SYSTEM, TOOL_HINT];
      cache.annotate([...prefix, TURN_1_USER]);
      cache.annotate([...prefix, TURN_2_USER]);
      // The original message object must be unchanged.
      expect((TOOL_HINT as { providerMetadata?: unknown }).providerMetadata).toBeUndefined();
    });
  });

  describe('cache eviction at maxEntries', () => {
    it('size never exceeds maxEntries', () => {
      const cache = new PromptCache({ maxEntries: 3 });

      for (let i = 0; i < 10; i++) {
        cache.annotate([msg('user', `unique message ${i}`), msg('assistant', `reply ${i}`)]);
      }

      expect(cache.size).toBeLessThanOrEqual(3);
    });

    it('cache continues to function after eviction', () => {
      const cache = new PromptCache({ maxEntries: 2 });

      // Fill the cache to the cap.
      cache.annotate([SYSTEM, TURN_1_USER]);
      cache.annotate([SYSTEM, TURN_2_USER]);

      // Trigger eviction by inserting a third unique sequence.
      cache.annotate([msg('user', 'overflow message'), msg('assistant', 'overflow reply')]);

      // Cache size is within cap.
      expect(cache.size).toBeLessThanOrEqual(2);

      // The oldest entry ([SYSTEM, TURN_1_USER], sequence 1) was evicted.
      // Re-inserting it is a miss (cold), but the second call is a hit.
      const { hit: firstHit } = cache.annotate([SYSTEM, TURN_1_USER]);
      expect(firstHit).toBe(false); // evicted — cold miss on re-insert
      const { hit: secondHit } = cache.annotate([SYSTEM, TURN_1_USER]);
      expect(secondHit).toBe(true); // now present again
    });

    it('evicted prefix does not produce false hit on a different tail', () => {
      // Regression: orphaned intermediate nodes left after eviction must NOT
      // cause a hit when a query shares a prefix with the evicted sequence.
      //
      // Insert [SYSTEM, TURN_1_USER, TURN_1_ASST] — terminal at depth 3.
      // Evict it (fill beyond maxEntries). Now SYSTEM and TURN_1_USER are
      // orphaned intermediates. A query [SYSTEM, TURN_1_USER, TURN_2_USER]
      // must NOT hit on [SYSTEM, TURN_1_USER] because that prefix belongs to
      // an evicted sequence, not a live one.
      const cache = new PromptCache({ maxEntries: 1 });

      cache.annotate([SYSTEM, TURN_1_USER, TURN_1_ASST]);
      // Trigger eviction of the first sequence.
      cache.annotate([msg('user', 'unrelated A'), msg('assistant', 'unrelated B')]);

      // The evicted prefix must not produce a false hit.
      const { hit } = cache.annotate([SYSTEM, TURN_1_USER, TURN_2_USER]);
      expect(hit).toBe(false);
    });

    it('LRU: re-accessing an entry refreshes its eviction priority', () => {
      // Scenario: insert A (seq=1), insert B (seq=2), re-access A (seq→3).
      // Insert C to trigger eviction. B has the smallest sequence (2) so B
      // must be evicted, not A.
      const cache = new PromptCache({ maxEntries: 2 });

      const seqA = [SYSTEM, TURN_1_USER];
      const seqB = [SYSTEM, TURN_2_USER];
      const seqC = [msg('user', 'unique C1'), msg('assistant', 'unique C2')];

      cache.annotate(seqA); // miss — inserts A (sequence=1)
      cache.annotate(seqB); // miss — inserts B (sequence=2)
      cache.annotate(seqA); // hit  — refreshes A's sequence to 3

      // Insert C: triggers eviction. B (sequence=2) is the oldest; it evicts.
      cache.annotate(seqC); // miss — inserts C (sequence=4), evicts B

      expect(cache.size).toBeLessThanOrEqual(2);

      // A must still be live: second call is a hit.
      const { hit: aHit } = cache.annotate(seqA);
      expect(aHit).toBe(true);

      // B was evicted: first call after eviction is a miss.
      const { hit: bFirstHit } = cache.annotate(seqB);
      expect(bFirstHit).toBe(false);

      // After re-inserting B above, a second call for B must hit.
      const { hit: bSecondHit } = cache.annotate(seqB);
      expect(bSecondHit).toBe(true);
    });

    it('evicted ancestors are pruned — size reflects only live sequences', () => {
      // Regression: after eviction, orphaned ancestor nodes must be removed
      // so trie memory doesn't grow without bound.
      // With maxEntries=1 and 3 unique sequences inserted, we evict twice.
      // After eviction the size must still be 1 (only the live sequence).
      const cache = new PromptCache({ maxEntries: 1 });

      cache.annotate([SYSTEM, TURN_1_USER, TURN_1_ASST]);
      cache.annotate([msg('user', 'seq B1'), msg('assistant', 'seq B2')]);
      cache.annotate([msg('user', 'seq C1'), msg('assistant', 'seq C2')]);

      expect(cache.size).toBe(1);
    });
  });

  describe('hit/miss counters', () => {
    it('increments misses on first call', () => {
      const cache = new PromptCache();
      cache.annotate([SYSTEM, TURN_1_USER]);
      expect(cache.misses).toBe(1);
      expect(cache.hits).toBe(0);
    });

    it('increments hits on second identical call', () => {
      const cache = new PromptCache();
      const messages = [SYSTEM, TURN_1_USER];
      cache.annotate(messages);
      cache.annotate(messages);
      expect(cache.hits).toBe(1);
      expect(cache.misses).toBe(1);
    });

    it('multiple misses then multiple hits', () => {
      const cache = new PromptCache();
      const messages = [SYSTEM, TOOL_HINT, TURN_1_USER];
      // 3 first calls → 3 misses (first time each sequence is unique after tail)
      cache.annotate([SYSTEM, TURN_1_USER]);
      cache.annotate([...messages]);
      cache.annotate([SYSTEM, TURN_2_USER]);

      // Now hit the prefix [SYSTEM, TOOL_HINT] from messages
      cache.annotate([...messages]);
      cache.annotate([...messages]);

      expect(cache.hits).toBeGreaterThanOrEqual(1);
    });

    it('propagates increments to MetricsCollector when provided', () => {
      const collector = new MetricsCollector();
      const cache = new PromptCache({ metrics: collector });

      const messages = [SYSTEM, TURN_1_USER];
      cache.annotate(messages); // miss
      cache.annotate(messages); // hit

      const snapshot = collector.snapshot();
      const hitEntry = snapshot[PROMPT_CACHE_HIT_METRIC] as CounterMetric | undefined;
      expect(hitEntry?.type).toBe('counter');
      expect(hitEntry?.value).toBe(1);
      const missEntry = snapshot[PROMPT_CACHE_MISS_METRIC] as CounterMetric | undefined;
      expect(missEntry?.type).toBe('counter');
      expect(missEntry?.value).toBe(1);
    });

    it('does not throw when no MetricsCollector is provided', () => {
      const cache = new PromptCache();
      expect(() => {
        cache.annotate([SYSTEM, TURN_1_USER]);
        cache.annotate([SYSTEM, TURN_1_USER]);
      }).not.toThrow();
    });
  });

  describe('annotate() adds cache_control markers on hits', () => {
    it('the prefix boundary message carries anthropic cacheControl metadata', () => {
      const cache = new PromptCache();
      const prefix = [SYSTEM, TOOL_HINT];
      cache.annotate([...prefix, TURN_1_USER]);

      const { messages, hit } = cache.annotate([...prefix, TURN_2_USER]);
      expect(hit).toBe(true);
      expect(messages[1]?.providerMetadata?.anthropic?.cacheControl).toEqual({
        type: 'ephemeral',
      });
    });

    it('messages beyond the prefix boundary carry no marker', () => {
      const cache = new PromptCache();
      const prefix = [SYSTEM, TOOL_HINT];
      cache.annotate([...prefix, TURN_1_USER]);

      const { messages } = cache.annotate([...prefix, TURN_2_USER]);
      expect(messages[2]?.providerMetadata).toBeUndefined();
    });

    it('returns original message references for non-boundary messages', () => {
      const cache = new PromptCache();
      const prefix = [SYSTEM, TOOL_HINT];
      cache.annotate([...prefix, TURN_1_USER]);

      const tail = msg('user', 'custom tail');
      const { messages } = cache.annotate([...prefix, tail]);
      // SYSTEM (index 0) should be the original reference.
      expect(messages[0]).toBe(SYSTEM);
      // Tail (index 2) should be the original reference.
      expect(messages[2]).toBe(tail);
    });

    it('single-message input always returns miss (too short for a useful boundary)', () => {
      const cache = new PromptCache();
      const single = [SYSTEM];
      cache.annotate(single);
      const { hit } = cache.annotate(single);
      expect(hit).toBe(false);
    });

    it('empty input always returns miss', () => {
      const cache = new PromptCache();
      const { hit } = cache.annotate([]);
      expect(hit).toBe(false);
    });
  });

  describe('size tracking', () => {
    it('starts at zero', () => {
      const cache = new PromptCache();
      expect(cache.size).toBe(0);
    });

    it('increments with each unique sequence', () => {
      const cache = new PromptCache();
      cache.annotate([SYSTEM, TURN_1_USER]);
      expect(cache.size).toBe(1);
      cache.annotate([SYSTEM, TURN_2_USER]);
      expect(cache.size).toBe(2);
    });

    it('does not double-count the same sequence', () => {
      const cache = new PromptCache();
      const messages = [SYSTEM, TURN_1_USER];
      cache.annotate(messages);
      cache.annotate(messages);
      expect(cache.size).toBe(1);
    });
  });
});
