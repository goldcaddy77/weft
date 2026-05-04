#!/usr/bin/env bun
/**
 * Verify every `oxlint-disable*` directive in `src/` carries an `ID:<name>` token,
 * and that every ID has a matching section in
 * `documentation/oxlint-disable-inventory.md`.
 *
 * Fails CI if a directive has no ID or no inventory entry, or if the inventory
 * has an entry with no corresponding directive in source.
 */

import { Glob, file } from 'bun';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..');
const inventoryPath = join(repoRoot, 'documentation/oxlint-disable-inventory.md');

const directiveRegex =
  /(?:\/\*|\/\/)\s*(?:eslint|oxlint)-disable(?:-(?:next-)?line)?\s+([a-zA-Z0-9/_(),-]+(?:\s*,\s*[a-zA-Z0-9/_(),-]+)*)?\s*--\s*ID:([a-zA-Z0-9_-]+)/g;
const directiveWithoutIdRegex =
  /(?:\/\*|\/\/)\s*(?:eslint|oxlint)-disable(?:-(?:next-)?line)?\s+(?:complexity|max-lines|eslint\(complexity\)|eslint\(max-lines\))\b/g;

const sourceIds = new Map<string, { file: string; line: number }>();
const orphanDirectives: { file: string; line: number; text: string }[] = [];

const glob = new Glob('src/**/*.ts');
for await (const relPath of glob.scan({ cwd: repoRoot })) {
  if (
    relPath.endsWith('.test.ts') ||
    relPath.endsWith('.spec.ts') ||
    relPath.includes('/test/') ||
    relPath.includes('/__tests__/')
  ) {
    continue;
  }
  const absPath = join(repoRoot, relPath);
  const source = await file(absPath).text();
  const lines = source.split('\n');

  for (const [index, lineText] of lines.entries()) {
    const lineNumber = index + 1;
    // Reset regex state for each line
    directiveRegex.lastIndex = 0;
    directiveWithoutIdRegex.lastIndex = 0;
    let matchedAnyId = false;
    let m: RegExpExecArray | null;
    while ((m = directiveRegex.exec(lineText)) !== null) {
      matchedAnyId = true;
      const id = m[2];
      const existing = sourceIds.get(id);
      if (existing) {
        console.error(
          `Duplicate disable ID '${id}': ${existing.file}:${existing.line} and ${relPath}:${lineNumber}`,
        );
        process.exit(1);
      }
      sourceIds.set(id, { file: relPath, line: lineNumber });
    }
    if (!matchedAnyId && directiveWithoutIdRegex.test(lineText)) {
      orphanDirectives.push({ file: relPath, line: lineNumber, text: lineText.trim() });
    }
  }
}

if (orphanDirectives.length > 0) {
  console.error('Found oxlint-disable directives without an `-- ID:<name>` token:');
  for (const d of orphanDirectives) {
    console.error(`  ${d.file}:${d.line}  ${d.text}`);
  }
  console.error(
    '\nEvery `complexity` or `max-lines` disable in src/ must carry a stable ID and an entry in documentation/oxlint-disable-inventory.md.',
  );
  process.exit(1);
}

const inventoryText = await file(inventoryPath).text();
const inventoryIds = new Set<string>();
const inventoryHeadingRegex = /^##\s+`([a-zA-Z0-9_-]+)`/gm;
let h: RegExpExecArray | null;
while ((h = inventoryHeadingRegex.exec(inventoryText)) !== null) {
  inventoryIds.add(h[1]);
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
  process.exit(1);
}

console.log(
  `OK: ${sourceIds.size} disable directive(s) tracked, all matched to inventory entries.`,
);
