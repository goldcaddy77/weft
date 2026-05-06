import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { verifyDocumentation } from './verify-documentation.ts';

const temporaryRepositories: string[] = [];

const BASE_DOCUMENTATION_FILES: Record<string, string> = {
  'package.json': JSON.stringify({ engines: { bun: '>=1.3.13' } }, null, 2),
  'README.md': [
    '# Weft',
    '',
    'The bun runtime version 1.3.13 or later is required.',
    '',
    'See [Installation](documentation/getting-started/installation.md#installation).',
    '',
  ].join('\n'),
  'documentation/getting-started/installation.md': [
    '# Installation',
    '',
    'You need Bun 1.3.13 or later.',
    '',
  ].join('\n'),
  'documentation/contributing/development-setup.md': [
    '# Development Setup',
    '',
    'The minimum version is 1.3.13.',
    '',
  ].join('\n'),
};

afterEach(() => {
  while (temporaryRepositories.length > 0) {
    const repositoryPath = temporaryRepositories.pop();
    if (repositoryPath) rmSync(repositoryPath, { recursive: true, force: true });
  }
});

async function createFixtureRepository(files: Record<string, string>): Promise<string> {
  const repositoryRoot = join(tmpdir(), `weft-documentation-${crypto.randomUUID()}`);
  temporaryRepositories.push(repositoryRoot);

  for (const [relativePath, contents] of Object.entries({
    ...BASE_DOCUMENTATION_FILES,
    ...files,
  })) {
    const absolutePath = join(repositoryRoot, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    await Bun.write(absolutePath, contents);
  }

  return repositoryRoot;
}

describe('verifyDocumentation', () => {
  it('passes for a minimal repository with required Bun version claims', async () => {
    const repositoryRoot = await createFixtureRepository({});

    const result = verifyDocumentation({ repositoryRoot });

    expect(result.findings).toEqual([]);
    expect(result.filesChecked).toBe(3);
  });

  it('detects broken local links', async () => {
    const repositoryRoot = await createFixtureRepository({
      'documentation/guides/broken-links.md': '# Broken Links\n\n[Missing](missing.md)\n',
    });

    const result = verifyDocumentation({ repositoryRoot });

    expect(result.findings).toContainEqual({
      file: 'documentation/guides/broken-links.md',
      line: 3,
      message: 'Broken local documentation link: missing.md',
    });
  });

  it('validates duplicate heading anchors and ignores links inside fenced code blocks', async () => {
    const repositoryRoot = await createFixtureRepository({
      'README.md': [
        '# Weft',
        '',
        'The bun runtime version 1.3.13 or later is required.',
        '',
        'See [the second heading](documentation/guides/anchors.md#repeat-1).',
        '',
        '```markdown',
        '[This missing link is example text](missing.md)',
        '```',
        '',
      ].join('\n'),
      'documentation/guides/anchors.md': ['# Anchors', '', '## Repeat', '', '## Repeat', ''].join(
        '\n',
      ),
    });

    const result = verifyDocumentation({ repositoryRoot });

    expect(result.findings).toEqual([]);
  });

  it('detects broken reference-style anchors', async () => {
    const repositoryRoot = await createFixtureRepository({
      'README.md': [
        '# Weft',
        '',
        'The bun runtime version 1.3.13 or later is required.',
        '',
        '[Target][target]',
        '',
        '[target]: documentation/getting-started/installation.md#missing-heading',
        '',
      ].join('\n'),
    });

    const result = verifyDocumentation({ repositoryRoot });

    expect(result.findings).toContainEqual({
      file: 'README.md',
      line: 6,
      message:
        'Broken local documentation anchor: documentation/getting-started/installation.md#missing-heading',
    });
  });

  it('detects stale Bun version claims from any lower version', async () => {
    const repositoryRoot = await createFixtureRepository({
      'README.md': '# Weft\n\nThe bun runtime version 1.3.12 or later is required.\n',
    });

    const result = verifyDocumentation({ repositoryRoot });

    expect(result.findings).toContainEqual({
      file: 'README.md',
      line: 3,
      message: 'Stale Bun version claim 1.3.12; package.json requires >=1.3.13.',
    });
  });

  it('detects workflow Bun pins below the package minimum', async () => {
    const repositoryRoot = await createFixtureRepository({
      '.github/workflows/ci.yaml': [
        'name: CI',
        'jobs:',
        '  test:',
        '    steps:',
        '      - uses: oven-sh/setup-bun@v1',
        '        with:',
        '          bun-version: 1.3.2',
        '',
      ].join('\n'),
    });

    const result = verifyDocumentation({ repositoryRoot });

    expect(result.findings).toContainEqual({
      file: '.github/workflows/ci.yaml',
      line: 7,
      message: 'Bun workflow pin 1.3.2 is lower than package.json engines.bun >=1.3.13.',
    });
  });

  it('detects unsupported workflow Bun version formats', async () => {
    const repositoryRoot = await createFixtureRepository({
      '.github/workflows/ci.yaml': [
        'name: CI',
        'jobs:',
        '  test:',
        '    steps:',
        '      - uses: oven-sh/setup-bun@v1',
        '        with:',
        '          bun-version: latest',
        '',
      ].join('\n'),
    });

    const result = verifyDocumentation({ repositoryRoot });

    expect(result.findings).toContainEqual({
      file: '.github/workflows/ci.yaml',
      line: 7,
      message: 'Unsupported bun-version format: latest. Use a concrete semver pin.',
    });
  });
});
