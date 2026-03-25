import { describe, expect, it } from 'bun:test';

import { Engine, MemoryStorage, VERSION } from './index';

describe('weft', () => {
  it('exports a version string', () => {
    expect(VERSION).toBe('0.0.1');
  });

  it('exports Engine class', () => {
    expect(Engine).toBeDefined();
  });

  it('exports MemoryStorage class', () => {
    expect(MemoryStorage).toBeDefined();
  });
});
