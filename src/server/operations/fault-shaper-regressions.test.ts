import { describe, expect, it } from 'bun:test';

const operationsDirectory = new URL('.', import.meta.url);

async function operationSourceFiles(): Promise<string[]> {
  const glob = new Bun.Glob('*.ts');
  const files: string[] = [];

  for await (const file of glob.scan({
    cwd: operationsDirectory.pathname,
    onlyFiles: true,
  })) {
    if (!file.endsWith('.test.ts')) {
      files.push(file);
    }
  }

  return files.toSorted();
}

describe('REST fault shaper regressions', () => {
  it('routes canonical JSON error envelopes through shared helpers', async () => {
    const allowedCustomEnvelopeFiles = new Set([
      // Recovery conflicts include machine-readable fields in addition to
      // `{ error }`, so that response is intentionally not a canonical envelope.
      'recover-all.ts',
    ]);
    const violatingFiles: string[] = [];

    for (const file of await operationSourceFiles()) {
      if (file === 'operation-helpers.ts' || allowedCustomEnvelopeFiles.has(file)) {
        continue;
      }

      const source = await Bun.file(new URL(file, operationsDirectory)).text();
      if (/new Response\(\s*JSON\.stringify\(\{\s*error:/u.test(source)) {
        violatingFiles.push(file);
      }
    }

    expect(violatingFiles).toEqual([]);
  });

  it('keeps invalid-params fault construction in operation helpers', async () => {
    const source = await Bun.file(new URL('bulk-filter-helpers.ts', operationsDirectory)).text();

    expect(source).toContain("import { invalidParamsFault } from './operation-helpers.ts';");
    expect(source).not.toContain('function invalidParamsFault');
    expect(source).not.toContain('export function invalidParamsFault');
  });
});
