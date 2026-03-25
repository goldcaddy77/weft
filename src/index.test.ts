import { describe, expect, it } from 'bun:test';

import { VERSION } from './index';

describe('weft', () => {
  it('exports a version string', () => {
    expect(VERSION).toBe('0.0.1');
  });
});
