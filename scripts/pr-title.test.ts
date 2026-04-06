import { describe, expect, it } from 'bun:test';

import { normalizePullRequestTitle, validatePullRequestTitle } from './pr-title.ts';

describe('normalizePullRequestTitle', () => {
  it('leaves a valid plain title unchanged', () => {
    const result = normalizePullRequestTitle('Add worker heartbeat persistence');

    expect(result.normalizedTitle).toBe('Add worker heartbeat persistence');
    expect(result.changed).toBe(false);
    expect(result.safeToAutofix).toBe(true);
  });

  it('preserves a valid Linear ticket prefix', () => {
    const result = normalizePullRequestTitle('DEP-123: Add worker heartbeat persistence');

    expect(result.normalizedTitle).toBe('DEP-123: Add worker heartbeat persistence');
    expect(result.changed).toBe(false);
  });

  it('normalizes the observed slug-plus-markdown failure mode', () => {
    const result = normalizePullRequestTitle(
      'asyncdisposablestack-used-in-server-setup-all-serv: **`AsyncDisposableStack` used in server setup.** All server resources cleaned up in reverse order on shutdown.',
    );

    expect(result.normalizedTitle).toBe('AsyncDisposableStack used in server setup');
    expect(result.changed).toBe(true);
    expect(result.safeToAutofix).toBe(true);
  });

  it('strips conventional-commit prefixes before validation', () => {
    const result = normalizePullRequestTitle(
      'feat: complete agent cost enforcement with budget tracking',
    );

    expect(result.normalizedTitle).toBe('Complete agent cost enforcement with budget tracking');
    expect(result.safeToAutofix).toBe(true);
  });

  it('keeps the ticket prefix when repairing a malformed title', () => {
    const result = normalizePullRequestTitle(
      'DEP-123: long-poll-fallback-for-non-websocket-environments-: **Long-poll fallback for non-WebSocket environments.** `GET /v1/tasks/:queue` with timeout.',
    );

    expect(result.normalizedTitle).toBe(
      'DEP-123: Long-poll fallback for non-WebSocket environments',
    );
    expect(result.safeToAutofix).toBe(true);
  });

  it('refuses to invent a title from an ambiguous slug-only value', () => {
    const result = normalizePullRequestTitle('ralph-feature-branch:');

    expect(result.normalizedTitle).toBeNull();
    expect(result.changed).toBe(false);
    expect(result.safeToAutofix).toBe(false);
  });

  it('keeps changed aligned with the returned normalized title', () => {
    const result = normalizePullRequestTitle('feat: 1.2.3');

    expect(result.normalizedTitle).toBeNull();
    expect(result.changed).toBe(false);
    expect(result.safeToAutofix).toBe(false);
    expect(result.issues).toContain(
      'PR title must start with an uppercase letter after any optional Linear ticket prefix.',
    );
  });
});

describe('validatePullRequestTitle', () => {
  it('accepts a valid plain title', () => {
    const result = validatePullRequestTitle('Add worker heartbeat persistence');

    expect(result).toEqual({ valid: true, issues: [] });
  });

  it('rejects markdown, branch slugs, and multi-sentence titles', () => {
    const result = validatePullRequestTitle(
      'long-poll-fallback-for-non-websocket-environments-: **Long-poll fallback.** Extra detail.',
    );

    expect(result.valid).toBe(false);
    expect(result.issues).toContain('PR title must not start with a branch-slug prefix.');
    expect(result.issues).toContain('PR title must not contain Markdown emphasis or inline code.');
    expect(result.issues).toContain(
      'PR title must be a single concise sentence fragment, not a multi-sentence dump.',
    );
  });

  it('rejects conventional-commit prefixes', () => {
    const result = validatePullRequestTitle('fix: add worker heartbeat persistence');

    expect(result.valid).toBe(false);
    expect(result.issues).toContain(
      'PR title must not start with a conventional-commit prefix like feat: or fix:.',
    );
  });

  it('rejects lowercase titles after an optional ticket prefix', () => {
    const result = validatePullRequestTitle('DEP-123: add worker heartbeat persistence');

    expect(result.valid).toBe(false);
    expect(result.issues).toContain(
      'PR title must start with an uppercase letter after any optional Linear ticket prefix.',
    );
  });
});
