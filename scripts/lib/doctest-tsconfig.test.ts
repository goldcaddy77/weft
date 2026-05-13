import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import {
  createDoctestTsconfig,
  formatDoctestTsconfig,
  writeDoctestTsconfig,
} from './doctest-tsconfig.ts';

describe('doctest tsconfig generation', () => {
  const publicEntryPoints = {
    weft: 'src/index.ts',
    'weft/storage/memory': 'src/storage/memory.ts',
  };

  const expectedTsconfig = {
    extends: '../../tsconfig.json',
    compilerOptions: {
      noEmit: true,
      noUnusedLocals: false,
      noUnusedParameters: false,
      baseUrl: '.',
      paths: {
        weft: ['../../src/index'],
        'weft/storage/memory': ['../../src/storage/memory'],
      },
    },
    include: ['./**/*.ts'],
    exclude: [],
  };

  it('creates the shared doctest tsconfig shape', () => {
    expect(createDoctestTsconfig(publicEntryPoints)).toEqual(expectedTsconfig);
  });

  it('formats the tsconfig with one trailing newline', () => {
    const formatted = formatDoctestTsconfig(publicEntryPoints);

    expect(formatted).toBe(`${JSON.stringify(expectedTsconfig, null, 2)}\n`);
    expect(formatted.endsWith('\n')).toBe(true);
    expect(formatted.endsWith('\n\n')).toBe(false);
  });

  it('rejects doctest source paths outside the repository', () => {
    expect(() =>
      createDoctestTsconfig({
        weft: '../outside.ts',
      }),
    ).toThrow('Invalid doctest source path for weft');
    expect(() =>
      createDoctestTsconfig({
        weft: '/tmp/outside.ts',
      }),
    ).toThrow('Invalid doctest source path for weft');
  });

  it('rejects doctest source paths that are not TypeScript source files', () => {
    expect(() =>
      createDoctestTsconfig({
        weft: 'src/index.js',
      }),
    ).toThrow('Invalid doctest source path for weft');
  });

  it('writes tsconfig.json into the provided doctest directory', () => {
    const directory = mkdtempSync(join(tmpdir(), 'weft-doctest-tsconfig-'));

    try {
      writeDoctestTsconfig(directory, publicEntryPoints);

      expect(readFileSync(join(directory, 'tsconfig.json'), 'utf8')).toBe(
        `${JSON.stringify(expectedTsconfig, null, 2)}\n`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
