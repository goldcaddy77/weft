import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

type Finding = {
  file: string;
  line: number;
  message: string;
};

const ROOTS = ['README.md', 'documentation', 'src'] as const;
const TEXT_EXTENSIONS = new Set(['.md', '.ts', '.txt']);
const IGNORED_PATH_PARTS = new Set(['.git', 'coverage', 'dist', 'node_modules', 'tmp']);
const IGNORED_FILES = new Set(['documentation/public-api.snapshot.txt']);

function extension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot);
}

function isTestFile(path: string): boolean {
  return /\.test-d\.ts$|\.test\.ts$|\.spec\.ts$/.test(path);
}

async function collectFiles(path: string): Promise<string[]> {
  if (IGNORED_PATH_PARTS.has(path)) return [];
  if (TEXT_EXTENSIONS.has(extension(path))) return [path];

  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (IGNORED_PATH_PARTS.has(entry.name)) continue;
    const childPath = join(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(childPath)));
    } else if (TEXT_EXTENSIONS.has(extension(entry.name))) {
      files.push(childPath);
    }
  }
  return files;
}

function findCallArguments(line: string, receiverPattern: RegExp): string[][] {
  const calls: string[][] = [];
  receiverPattern.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = receiverPattern.exec(line)) !== null) {
    let index = receiverPattern.lastIndex;
    let depth = 1;
    let quote: '"' | "'" | '`' | undefined;
    let escaped = false;
    let source = '';

    while (index < line.length && depth > 0) {
      const character = line[index];

      if (quote !== undefined) {
        source += character;
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === quote) {
          quote = undefined;
        }
        index++;
        continue;
      }

      if (character === '"' || character === "'" || character === '`') {
        quote = character;
        source += character;
        index++;
        continue;
      }

      if (character === '(') depth++;
      if (character === ')') depth--;
      if (depth > 0) source += character;
      index++;
    }

    calls.push(splitTopLevelArguments(source));
  }

  return calls;
}

function splitTopLevelArguments(source: string): string[] {
  const argumentsList: string[] = [];
  let current = '';
  let depth = 0;
  let quote: '"' | "'" | '`' | undefined;
  let escaped = false;

  for (const character of source) {
    if (quote !== undefined) {
      current += character;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      current += character;
      continue;
    }

    if (character === '(' || character === '[' || character === '{') depth++;
    if (character === ')' || character === ']' || character === '}') depth--;

    if (character === ',' && depth === 0) {
      argumentsList.push(current.trim());
      current = '';
      continue;
    }

    current += character;
  }

  if (current.trim().length > 0) argumentsList.push(current.trim());
  return argumentsList;
}

function isAllowedActivityOptionsArgument(argument: string): boolean {
  if (argument.startsWith('{')) return true;
  return /^(activityOptions|callOptions|options)$/.test(argument);
}

function checkLine(file: string, line: string, lineNumber: number): Finding[] {
  const findings: Finding[] = [];
  const testFile = isTestFile(file);

  if (!testFile && line.includes('defineAgent')) {
    findings.push({
      file,
      line: lineNumber,
      message:
        'Use the public agent() helper; defineAgent must not appear in public source or docs.',
    });
  }

  if (!testFile) {
    const runCalls = findCallArguments(line, /\b(?:ctx|context)\.run\s*\(/g);
    for (const argumentsList of runCalls) {
      if (argumentsList.length > 3) {
        findings.push({
          file,
          line: lineNumber,
          message: 'ctx.run() accepts only activity, input?, options?.',
        });
      } else if (
        argumentsList.length === 3 &&
        !isAllowedActivityOptionsArgument(argumentsList[2])
      ) {
        findings.push({
          file,
          line: lineNumber,
          message:
            'The third ctx.run() argument must be ActivityCallOptions, not another activity input.',
        });
      }
    }
  }

  if (
    !testFile &&
    /\b(?:engine|handle|client|httpClient|localClient)\.(?:signal|update|query)\(\s*['"]/.test(line)
  ) {
    findings.push({
      file,
      line: lineNumber,
      message: 'Public examples should use signal(), update(), or query() typed handles.',
    });
  }

  return findings;
}

const filesByRoot = await Promise.all(ROOTS.map((root) => collectFiles(root)));
const files = filesByRoot.flat();
const findings: Finding[] = [];

for (const file of files) {
  if (IGNORED_FILES.has(file)) continue;
  const text = await Bun.file(file).text();
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    findings.push(...checkLine(file, line, index + 1));
  }
}

if (findings.length > 0) {
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}: ${finding.message}`);
  }
  process.exit(1);
}
