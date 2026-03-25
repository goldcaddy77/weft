import { describe, expect, it } from 'bun:test';

import { parseCliArguments } from './cli.ts';

describe('CLI argument parsing', () => {
  it('parses --port flag', () => {
    const result = parseCliArguments(['--port', '8080']);
    expect(result.port).toBe('8080');
  });

  it('parses -p short flag for port', () => {
    const result = parseCliArguments(['-p', '9999']);
    expect(result.port).toBe('9999');
  });

  it('defaults port to 7233', () => {
    const result = parseCliArguments([]);
    expect(result.port).toBe('7233');
  });

  it('parses --data flag', () => {
    const result = parseCliArguments(['--data', '/tmp/test.db']);
    expect(result.data).toBe('/tmp/test.db');
  });

  it('parses -d short flag for data', () => {
    const result = parseCliArguments(['-d', '/tmp/other.db']);
    expect(result.data).toBe('/tmp/other.db');
  });

  it('defaults data to ./weft.db', () => {
    const result = parseCliArguments([]);
    expect(result.data).toBe('./weft.db');
  });

  it('parses --help flag', () => {
    const result = parseCliArguments(['--help']);
    expect(result.help).toBe(true);
  });

  it('defaults help to false', () => {
    const result = parseCliArguments([]);
    expect(result.help).toBe(false);
  });

  it('parses multiple flags together', () => {
    const result = parseCliArguments(['--port', '3000', '--data', '/var/weft.db']);
    expect(result.port).toBe('3000');
    expect(result.data).toBe('/var/weft.db');
  });
});
