import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { isRecord, safeDebugStringify } from '../core/debug-output.ts';

function isGlobPattern(value: string): boolean {
  return value.includes('*') || value.includes('?') || value.includes('[');
}

function normalizeGlobPatternPath(entryPath: string): string {
  return entryPath.replaceAll('\\', '/');
}

function shouldIgnoreExpandedGlobPath(entryPath: string): boolean {
  const normalizedEntryPath = normalizeGlobPatternPath(entryPath);
  return (
    normalizedEntryPath.split('/').includes('node_modules') ||
    /\.test\.[cm]?tsx?$/.test(normalizedEntryPath) ||
    /\.spec\.[cm]?tsx?$/.test(normalizedEntryPath)
  );
}

/** Splits a glob entry path into the directory to scan and the pattern to match. */
export function splitGlobPattern(entryPath: string): { scanRoot: string; pattern: string } {
  const normalizedEntryPath = normalizeGlobPatternPath(entryPath);
  const firstGlobIndex = Array.from(normalizedEntryPath).findIndex((character) =>
    ['*', '?', '['].includes(character),
  );

  if (firstGlobIndex === -1) {
    return { scanRoot: '.', pattern: normalizedEntryPath };
  }

  const separatorIndex = normalizedEntryPath.lastIndexOf('/', firstGlobIndex);
  if (separatorIndex === -1) {
    return { scanRoot: '.', pattern: normalizedEntryPath };
  }

  const scanRootCandidate = normalizedEntryPath.slice(0, separatorIndex);
  const scanRoot =
    scanRootCandidate === ''
      ? '/'
      : /^[A-Za-z]:\//.test(normalizedEntryPath) &&
          scanRootCandidate === normalizedEntryPath.slice(0, 2)
        ? `${scanRootCandidate}/`
        : scanRootCandidate;
  const pattern = normalizedEntryPath.slice(separatorIndex + 1);

  return { scanRoot, pattern };
}

export async function expandGlobEntryPaths(entryPaths: string[]): Promise<string[]> {
  const expandedEntryPaths: string[] = [];

  for (const entryPath of entryPaths) {
    if (!isGlobPattern(entryPath)) {
      expandedEntryPaths.push(entryPath);
      continue;
    }

    const { scanRoot, pattern } = splitGlobPattern(entryPath);
    const matchedPaths = await scanGlobMatches(scanRoot, pattern);
    const matches = matchedPaths.map((match) => join(scanRoot, match)).toSorted();
    expandedEntryPaths.push(...(matches.length === 0 ? [entryPath] : matches));
  }

  return Array.from(new Set(expandedEntryPaths));
}

async function scanGlobMatches(scanRoot: string, pattern: string): Promise<string[]> {
  const glob = new Bun.Glob(pattern);
  const matchedPaths: string[] = [];

  await walkGlobScanRoot(scanRoot, '', glob, matchedPaths);

  return matchedPaths;
}

async function walkGlobScanRoot(
  absoluteDirectory: string,
  relativeDirectory: string,
  glob: Bun.Glob,
  matchedPaths: string[],
): Promise<void> {
  const directoryEntries = await readdir(absoluteDirectory, { withFileTypes: true });

  for (const directoryEntry of directoryEntries) {
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${directoryEntry.name}`
      : directoryEntry.name;

    if (shouldIgnoreExpandedGlobPath(relativePath)) {
      continue;
    }

    if (directoryEntry.isDirectory()) {
      await walkGlobScanRoot(
        join(absoluteDirectory, directoryEntry.name),
        relativePath,
        glob,
        matchedPaths,
      );
      continue;
    }

    if (directoryEntry.isFile() && glob.match(relativePath)) {
      matchedPaths.push(relativePath);
    }
  }
}

export function formatValue(value: unknown): string {
  return safeDebugStringify(value, 2);
}

function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Recursively records changed paths between two checkpoint-like values. */
export function collectDiffLines(
  beforeValue: unknown,
  afterValue: unknown,
  path: string,
  lines: string[],
): void {
  if (Object.is(beforeValue, afterValue)) {
    return;
  }

  if (Array.isArray(beforeValue) && Array.isArray(afterValue)) {
    const length = Math.max(beforeValue.length, afterValue.length);
    for (let index = 0; index < length; index++) {
      collectDiffLines(beforeValue[index], afterValue[index], `${path}[${index}]`, lines);
    }
    return;
  }

  if (isPlainObjectRecord(beforeValue) && isPlainObjectRecord(afterValue)) {
    const keys = new Set([...Object.keys(beforeValue), ...Object.keys(afterValue)]);
    for (const key of [...keys].toSorted()) {
      const childPath = path ? `${path}.${key}` : key;
      collectDiffLines(beforeValue[key], afterValue[key], childPath, lines);
    }
    return;
  }

  lines.push(`${path}: ${formatValue(beforeValue)} -> ${formatValue(afterValue)}`);
}
