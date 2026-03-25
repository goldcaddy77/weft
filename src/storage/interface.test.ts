import { describe, expect, it } from 'bun:test';

import { KEYS } from './interface';

describe('KEYS', () => {
  it('workflow key has correct format', () => {
    expect(KEYS.workflow('abc')).toBe('wf:abc');
  });

  it('checkpoint key has correct format', () => {
    expect(KEYS.checkpoint('abc')).toBe('wf:abc:ckpt');
  });

  it('operation key has correct zero-padded format', () => {
    const key = KEYS.operation('default', 1000, 'op-1');
    expect(key).toBe('op:default:0000000000001000:op-1');
  });

  it('operations sorted by key preserve chronological order', () => {
    const earlier = KEYS.operation('default', 100, 'a');
    const later = KEYS.operation('default', 200, 'b');
    expect(earlier < later).toBe(true);
  });

  it('deadline keys sort chronologically', () => {
    const earlier = KEYS.deadline(1000, 'wf-1');
    const later = KEYS.deadline(2000, 'wf-2');
    expect(earlier < later).toBe(true);
  });

  it('event keys sort by sequence number', () => {
    const first = KEYS.event('wf-1', 1);
    const second = KEYS.event('wf-1', 2);
    const tenth = KEYS.event('wf-1', 10);
    expect(first < second).toBe(true);
    expect(second < tenth).toBe(true);
  });

  it('all KEYS functions return strings', () => {
    const results = [
      KEYS.workflow('id'),
      KEYS.checkpoint('id'),
      KEYS.checkpointHistory('id', 1),
      KEYS.operation('queue', 100, 'id'),
      KEYS.operationInflight('id'),
      KEYS.event('wf', 1),
      KEYS.signal('wf', 'name', 'id'),
      KEYS.deadline(100, 'wf'),
      KEYS.attribute('wf'),
      KEYS.attributeIndex('attr', 'val', 'wf'),
      KEYS.update('wf', 'upd'),
      KEYS.updateResponse('upd'),
      KEYS.updateIdempotency('wf', 'key'),
      KEYS.budget('ns', 'period', 'date'),
      KEYS.review('wf', 'rev'),
      KEYS.archive('wf', 'key'),
      KEYS.sharedState('wf', 'state'),
      KEYS.sharedStateVersion('wf', 'state'),
      KEYS.streamChunk('wf', 'key', 0),
      KEYS.streamMetadata('wf', 'key'),
    ];

    for (const result of results) {
      expect(typeof result).toBe('string');
    }
  });

  it('streamChunk key has correct zero-padded blob format', () => {
    expect(KEYS.streamChunk('wf-1', 'export', 0)).toBe('blob:wf-1:export:chunk:0000000000');
    expect(KEYS.streamChunk('wf-1', 'export', 42)).toBe('blob:wf-1:export:chunk:0000000042');
  });

  it('streamChunk keys sort lexicographically by index', () => {
    const first = KEYS.streamChunk('wf-1', 'export', 1);
    const second = KEYS.streamChunk('wf-1', 'export', 2);
    const hundredth = KEYS.streamChunk('wf-1', 'export', 100);
    expect(first < second).toBe(true);
    expect(second < hundredth).toBe(true);
  });

  it('streamMetadata key has correct format', () => {
    expect(KEYS.streamMetadata('wf-1', 'export')).toBe('blob:wf-1:export:meta');
  });

  it('zero-padding works for very large timestamps', () => {
    const largeTimestamp = 9999999999999;
    const key = KEYS.operation('queue', largeTimestamp, 'id');
    expect(key).toBe('op:queue:0009999999999999:id');

    // Verify the padded portion is exactly 16 characters
    const parts = key.split(':');
    expect(parts[2]).toHaveLength(16);
  });
});
