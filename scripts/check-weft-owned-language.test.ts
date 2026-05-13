import { describe, expect, it } from 'bun:test';

const repositoryRoot = new URL('../', import.meta.url).pathname;
const textDecoder = new TextDecoder();
const permittedHistoricalSymbol = ['Agent', 'Bureau', 'ConversationHistory'].join('');

const disallowedTerms = [
  ['agent', ' bureau'],
  ['agent', '-bureau'],
  ['agent', '.bureau'],
  ['agent', 'bureau'],
  ['arm', 'orer'],
  ['convers', 'ationalist'],
].map((parts) => parts.join('').toLowerCase());

function trackedFiles(): string[] {
  const result = Bun.spawnSync({
    cmd: ['git', '-C', repositoryRoot, 'ls-files', '-z', '--', '*.ts', '*.md', '*.json', '*.toml'],
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (result.exitCode !== 0) {
    throw new Error(textDecoder.decode(result.stderr));
  }

  return textDecoder
    .decode(result.stdout)
    .split('\0')
    .filter((path) => path.length > 0);
}

function contentForCheck(relativePath: string, content: string): string {
  if (relativePath === 'CHANGELOG.md') {
    return content.replaceAll(permittedHistoricalSymbol, '');
  }

  return content;
}

describe('Weft-owned language', () => {
  it('does not name downstream projects in tracked runtime source, tests, or documentation', async () => {
    const matches: string[] = [];

    for (const relativePath of trackedFiles()) {
      const checkedContent = contentForCheck(
        relativePath,
        await Bun.file(new URL(relativePath, `file://${repositoryRoot}/`)).text(),
      ).toLowerCase();

      for (const term of disallowedTerms) {
        if (checkedContent.includes(term)) {
          matches.push(`${relativePath}: ${term}`);
        }
      }
    }

    expect(matches).toEqual([]);
  });
});
