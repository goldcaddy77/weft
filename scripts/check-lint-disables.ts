#!/usr/bin/env bun
/**
 * Enforce the oxlint suppression policy for `src/`.
 *
 * Two modes:
 *
 * - **Inventory-matching mode** (default during the oxlint-strict capstone
 *   transition): verify every `oxlint-disable*` directive in `src/` carries an
 *   `ID:<name>` token and that every ID has a matching section in
 *   `documentation/oxlint-disable-inventory.md`. Fails if a directive has no
 *   ID or no inventory entry, or if the inventory has an entry with no
 *   corresponding directive in source.
 * - **Ceiling mode** (`--max <n>`): scan `src/` for `oxlint-disable*`
 *   directives in the supported source-file extensions, exclude tests, and
 *   enforce (1) at most `<n>` directives total and (2) every directive carries
 *   an inline rationale of at least {@link MIN_RATIONALE_LENGTH} characters
 *   after stripping any leading `ID:<token>`.
 *
 * `--emit-snapshot <path>` writes a tab-separated audit artifact of every
 * directive in enforcement scope. The flag is scan-only: it never enforces a
 * ceiling or rationale length, regardless of `--max`. Use it to capture
 * pre-/post-refactor inventories without blocking the audit on legacy state.
 *
 * `--root <path>` sets the directory the scanner walks. Defaults to the
 * repository root (the script's parent directory). Used by the script's own
 * tests to point at fixture trees instead of the live repo.
 */

import { Glob, file, write } from 'bun';
import { join } from 'node:path';

export const MAX_DISABLES = 5;
export const MIN_RATIONALE_LENGTH = 40;

/** Inclusion glob for files in enforcement scope. */
export const SOURCE_FILE_GLOB = 'src/**/*.{ts,tsx,mts,cts}';

/** Path patterns excluded from enforcement scope (test and spec files). */
export const TEST_FILE_EXCLUSION_GLOBS = [
  '*.test.{ts,tsx,mts,cts}',
  '*.spec.{ts,tsx,mts,cts}',
  '**/test/**',
  '**/__tests__/**',
] as const;

type Directive = {
  file: string;
  line: number;
  rationale: string;
  rawId: string | null;
  matchedFullId: boolean;
};

type CliArguments = {
  root: string;
  max: number | null;
  emitSnapshot: string | null;
};

const directiveWithIdRegex =
  /(?:\/\*|\/\/)\s*(?:eslint|oxlint)-disable(?:-(?:next-)?line)?\s+([a-zA-Z0-9/_(),-]+(?:\s*,\s*[a-zA-Z0-9/_(),-]+)*)?\s*--\s*ID:([a-zA-Z0-9_-]+)/g;
const directiveWithoutIdRegex =
  /(?:\/\*|\/\/)\s*(?:eslint|oxlint)-disable(?:-(?:next-)?line)?\s+(?:complexity|max-lines|eslint\(complexity\)|eslint\(max-lines\))\b/g;

/**
 * Matches any `oxlint-disable*` directive (block or line, with or without
 * specific rules). Used by the ceiling-mode scanner to find every directive
 * regardless of rule list, and to extract the rationale text.
 */
const oxlintDirectiveRegex =
  /(\/\*|\/\/)\s*oxlint-disable(?:-(?:next-)?line)?\b([^*\n]*?)(?:\*\/|$)/g;

function parseArguments(argv: readonly string[]): CliArguments {
  let root: string | null = null;
  let max: number | null = null;
  let emitSnapshot: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      root = argv[index + 1] ?? null;
      index += 1;
    } else if (arg === '--max') {
      const value = argv[index + 1];
      if (value === undefined || !/^\d+$/.test(value)) {
        throw new Error(`--max expects a non-negative integer, got: ${value ?? '<missing>'}`);
      }
      max = Number.parseInt(value, 10);
      index += 1;
    } else if (arg === '--emit-snapshot') {
      emitSnapshot = argv[index + 1] ?? null;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    root: root ?? join(import.meta.dir, '..'),
    max,
    emitSnapshot,
  };
}

function printUsage(): void {
  console.log(
    [
      'Usage: bun scripts/check-lint-disables.ts [--root <path>] [--max <n>] [--emit-snapshot <path>]',
      '',
      'Modes:',
      '  (default)            inventory-matching mode (back-compat)',
      '  --max <n>            ceiling mode: enforce at most <n> directives + rationale length',
      '  --emit-snapshot <p>  write a TSV audit artifact (scan only, no enforcement)',
      '',
      'Defaults:',
      `  MAX_DISABLES         = ${MAX_DISABLES}`,
      `  MIN_RATIONALE_LENGTH = ${MIN_RATIONALE_LENGTH}`,
    ].join('\n'),
  );
}

function isExcludedTestPath(relativePath: string): boolean {
  return (
    /\.test\.(ts|tsx|mts|cts)$/.test(relativePath) ||
    /\.spec\.(ts|tsx|mts|cts)$/.test(relativePath) ||
    relativePath.includes('/test/') ||
    relativePath.includes('/__tests__/')
  );
}

/**
 * Strip a leading `ID:<token>` and trailing comment-close from a rationale
 * candidate so its measured length reflects the actual prose explanation.
 */
function normalizeRationale(rawRationale: string): { rationale: string; rawId: string | null } {
  const withoutTrailingClose = rawRationale.replace(/\s*\*\/\s*$/, '');
  const trimmed = withoutTrailingClose.trim();
  const idMatch = /^ID:([a-zA-Z0-9_-]+)\s*(.*)$/s.exec(trimmed);
  if (idMatch) {
    return { rationale: idMatch[2].trim(), rawId: idMatch[1] };
  }
  return { rationale: trimmed, rawId: null };
}

async function* iterateSourceFiles(root: string): AsyncGenerator<string> {
  const glob = new Glob(SOURCE_FILE_GLOB);
  for await (const relativePath of glob.scan({ cwd: root })) {
    if (isExcludedTestPath(relativePath)) continue;
    yield relativePath;
  }
}

async function scanDirectives(root: string): Promise<Directive[]> {
  const directives: Directive[] = [];
  for await (const relativePath of iterateSourceFiles(root)) {
    const absolutePath = join(root, relativePath);
    const source = await file(absolutePath).text();
    const lines = source.split('\n');
    for (const [index, lineText] of lines.entries()) {
      oxlintDirectiveRegex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = oxlintDirectiveRegex.exec(lineText)) !== null) {
        const rawRationaleSegment = match[2] ?? '';
        const dashIndex = rawRationaleSegment.indexOf('--');
        const rationaleCandidate = dashIndex >= 0 ? rawRationaleSegment.slice(dashIndex + 2) : '';
        const normalized = normalizeRationale(rationaleCandidate);
        directives.push({
          file: relativePath,
          line: index + 1,
          rationale: normalized.rationale,
          rawId: normalized.rawId,
          matchedFullId: dashIndex >= 0,
        });
      }
    }
  }
  return directives;
}

async function runCeilingMode(args: CliArguments, max: number): Promise<number> {
  const directives = await scanDirectives(args.root);
  const offendersMissingRationale = directives.filter(
    (directive) => directive.rationale.length < MIN_RATIONALE_LENGTH,
  );

  let failed = false;

  if (directives.length > max) {
    console.error(
      `Found ${directives.length} oxlint-disable directive(s) in src/, ceiling is ${max}.`,
    );
    for (const directive of directives) {
      console.error(`  ${directive.file}:${directive.line}`);
    }
    failed = true;
  }

  if (offendersMissingRationale.length > 0) {
    console.error(
      `Found ${offendersMissingRationale.length} oxlint-disable directive(s) without a rationale of at least ${MIN_RATIONALE_LENGTH} characters (excluding any leading ID:<token>):`,
    );
    for (const directive of offendersMissingRationale) {
      console.error(
        `  ${directive.file}:${directive.line}  rationale length=${directive.rationale.length}`,
      );
    }
    failed = true;
  }

  if (failed) return 1;

  const source = args.max === null ? 'default' : '--max';
  console.log(
    `OK: ${directives.length}/${max} oxlint-disable directive(s) in src/, all with rationales ≥ ${MIN_RATIONALE_LENGTH} chars. (effective max = ${max} from ${source})`,
  );
  return 0;
}

async function runInventoryMode(args: CliArguments): Promise<number> {
  const inventoryPath = join(args.root, 'documentation/oxlint-disable-inventory.md');
  const sourceIds = new Map<string, { file: string; line: number }>();
  const orphanDirectives: { file: string; line: number; text: string }[] = [];

  for await (const relativePath of iterateSourceFiles(args.root)) {
    const absolutePath = join(args.root, relativePath);
    const source = await file(absolutePath).text();
    const lines = source.split('\n');
    for (const [index, lineText] of lines.entries()) {
      const lineNumber = index + 1;
      directiveWithIdRegex.lastIndex = 0;
      directiveWithoutIdRegex.lastIndex = 0;
      let matchedAnyId = false;
      let match: RegExpExecArray | null;
      while ((match = directiveWithIdRegex.exec(lineText)) !== null) {
        matchedAnyId = true;
        const id = match[2];
        const existing = sourceIds.get(id);
        if (existing) {
          console.error(
            `Duplicate disable ID '${id}': ${existing.file}:${existing.line} and ${relativePath}:${lineNumber}`,
          );
          return 1;
        }
        sourceIds.set(id, { file: relativePath, line: lineNumber });
      }
      if (!matchedAnyId && directiveWithoutIdRegex.test(lineText)) {
        orphanDirectives.push({
          file: relativePath,
          line: lineNumber,
          text: lineText.trim(),
        });
      }
    }
  }

  if (orphanDirectives.length > 0) {
    console.error('Found oxlint-disable directives without an `-- ID:<name>` token:');
    for (const directive of orphanDirectives) {
      console.error(`  ${directive.file}:${directive.line}  ${directive.text}`);
    }
    console.error(
      '\nEvery `complexity` or `max-lines` disable in src/ must carry a stable ID and an entry in documentation/oxlint-disable-inventory.md.',
    );
    return 1;
  }

  const inventoryText = await file(inventoryPath).text();
  const inventoryIds = new Set<string>();
  const inventoryHeadingRegex = /^##\s+`([a-zA-Z0-9_-]+)`/gm;
  let headingMatch: RegExpExecArray | null;
  while ((headingMatch = inventoryHeadingRegex.exec(inventoryText)) !== null) {
    inventoryIds.add(headingMatch[1]);
  }

  const missingFromInventory: string[] = [];
  const missingFromSource: string[] = [];
  for (const id of sourceIds.keys()) {
    if (!inventoryIds.has(id)) missingFromInventory.push(id);
  }
  for (const id of inventoryIds) {
    if (!sourceIds.has(id)) missingFromSource.push(id);
  }

  if (missingFromInventory.length > 0) {
    console.error('Disable IDs in source with no inventory entry:');
    for (const id of missingFromInventory.toSorted()) {
      const where = sourceIds.get(id);
      if (where) {
        console.error(`  ${id}  (${where.file}:${where.line})`);
      } else {
        console.error(`  ${id}`);
      }
    }
  }
  if (missingFromSource.length > 0) {
    console.error('\nInventory IDs with no matching directive in source:');
    for (const id of missingFromSource.toSorted()) {
      console.error(`  ${id}`);
    }
  }

  if (missingFromInventory.length > 0 || missingFromSource.length > 0) {
    return 1;
  }

  console.log(
    `OK: ${sourceIds.size} disable directive(s) tracked, all matched to inventory entries.`,
  );
  return 0;
}

async function writeSnapshot(root: string, outputPath: string): Promise<void> {
  const directives = await scanDirectives(root);
  const lines = directives.map((directive) => {
    const id = directive.rawId ?? '';
    return `${id}\t${directive.file}\t${directive.line}`;
  });
  await write(outputPath, lines.join('\n') + (lines.length > 0 ? '\n' : ''));
  console.log(`Wrote snapshot of ${directives.length} directive(s) to ${outputPath}`);
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const args = parseArguments(argv);

  if (args.emitSnapshot !== null) {
    await writeSnapshot(args.root, args.emitSnapshot);
    return 0;
  }

  if (args.max !== null) {
    return await runCeilingMode(args, args.max);
  }

  return await runInventoryMode(args);
}

if (import.meta.main) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exit(exitCode);
}
