/**
 * Extracts every @example block from manifest entries and writes one .ts file
 * per block to tmp/doctests/<batchSlug>/<importPath-slug>__<exportName>__<kind>__<index>.ts.
 * Generates tmp/doctests/tsconfig.json with `paths` resolved from the manifest's
 * publicEntryPoints table so 'weft' and subpaths resolve to source files.
 *
 * The extractor is NOT a coverage tool — it only produces compileable artifacts.
 * Coverage enforcement is audit-jsdoc-manifest.ts's job.
 *
 * Hard requirement on examples: each block must contain at least one
 *   import ... from 'weft'   |   import type ... from 'weft'   |   mixed
 * statement as one of its first non-blank lines. Blocks missing this are
 * reported and the run aborts with a non-zero exit (no silent injection).
 *
 * Usage: bun run scripts/extract-doctests.ts
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = resolve(import.meta.dir, '..');
const MANIFEST_PATH = resolve(REPO_ROOT, 'reference/jsdoc-manifest.json');
const DOCTESTS_DIR = resolve(REPO_ROOT, 'tmp/doctests');

type SymbolKind = 'value' | 'type' | 'namespace';

type PublicFace = { importPath: string; exportName: string; kind: SymbolKind };

type ManifestEntry = {
  sourceFile: string;
  sourceName: string;
  kind: SymbolKind;
  subKind: string;
  publicFaces: PublicFace[];
  classification: 'unclassified' | 'example-required' | 'prose-only' | 'not-public';
  currentState: 'no-jsdoc' | 'prose-only' | 'has-example';
  classificationRationale: string | null;
  batch: string | null;
};

type Manifest = {
  publicEntryPoints: Record<string, string>;
  entries: ManifestEntry[];
};

// ---------------------------------------------------------------------------
// Slugification helpers — keep filenames safe across filesystems.
// ---------------------------------------------------------------------------

function slugify(input: string): string {
  return input.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// Extract @example blocks from a source declaration. Returns the raw block
// content with the surrounding ```ts ... ``` fence stripped.
// ---------------------------------------------------------------------------

function extractExamples(sourceFile: ts.SourceFile, sourceName: string): string[] {
  const examples: string[] = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isVariableStatement(node)) &&
      hasMatchingName(node, sourceName)
    ) {
      const tags = ts.getJSDocTags(node);
      for (const tag of tags) {
        if (tag.tagName.text === 'example') {
          const text = readJSDocComment(tag.comment);
          // Match ```ts (optional language meta) \n (block content) \n ```
          const fence = text.match(/```ts\b[^\n]*\n([\s\S]*?)```/);
          if (fence) {
            examples.push(fence[1]);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return examples;
}

function hasMatchingName(node: ts.Node, sourceName: string): boolean {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node)
  ) {
    return node.name?.getText() === sourceName;
  }
  if (ts.isVariableStatement(node)) {
    for (const decl of node.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === sourceName) return true;
    }
  }
  return false;
}

function readJSDocComment(comment: ts.JSDocTag['comment']): string {
  if (typeof comment === 'string') return comment;
  if (!comment) return '';
  let out = '';
  for (const part of comment) {
    if (part.kind === ts.SyntaxKind.JSDocText) {
      out += part.text;
    } else if ('text' in part && typeof part.text === 'string') {
      out += part.text;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validate that an example block has a `from 'weft'` (or subpath) import.
// Accepts value, type-only, or mixed import forms.
// ---------------------------------------------------------------------------

function hasWeftImport(block: string, weftSpecifiers: Set<string>): boolean {
  // Match `import ... from '<specifier>'` with optional `type` keyword.
  // Only consider the first ~6 non-blank lines for the import.
  const lines = block
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .slice(0, 8);
  const joined = lines.join('\n');
  const importPattern = /import(?:\s+type)?\s+[^;]+\s+from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(joined)) !== null) {
    if (weftSpecifiers.has(match[1])) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Build tmp/doctests/tsconfig.json with `paths` from publicEntryPoints.
// ---------------------------------------------------------------------------

function writeTsconfig(publicEntryPoints: Record<string, string>): void {
  const paths: Record<string, string[]> = {};
  for (const [importPath, sourceRel] of Object.entries(publicEntryPoints)) {
    // tsconfig paths are relative to baseUrl. tmp/doctests/ sits two levels
    // under REPO_ROOT, so paths are written relative to that.
    paths[importPath] = [`../../${sourceRel.replace(/\.ts$/, '')}`];
  }
  // Extend the project tsconfig to inherit lib/target/strictness rules so
  // doctests compile against the same ground truth as project sources. We
  // override `include`, `paths`, `noUnusedLocals`, and `noUnusedParameters`
  // because doctests are minimal snippets that often declare unused locals.
  const tsconfig = {
    extends: '../../tsconfig.json',
    compilerOptions: {
      noEmit: true,
      noUnusedLocals: false,
      noUnusedParameters: false,
      baseUrl: '.',
      paths,
    },
    include: ['./**/*.ts'],
    exclude: [],
  };
  writeFileSync(
    resolve(DOCTESTS_DIR, 'tsconfig.json'),
    JSON.stringify(tsconfig, null, 2) + '\n',
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

function main(): void {
  if (!existsSync(MANIFEST_PATH)) {
    console.error(`extract-doctests: manifest not found at ${MANIFEST_PATH}`);
    process.exit(1);
  }
  const manifest: Manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const weftSpecifiers = new Set(Object.keys(manifest.publicEntryPoints));

  // Reset the doctests directory.
  if (existsSync(DOCTESTS_DIR)) rmSync(DOCTESTS_DIR, { recursive: true, force: true });
  mkdirSync(DOCTESTS_DIR, { recursive: true });

  // Cache parsed source files.
  const sourceCache = new Map<string, ts.SourceFile>();
  function getSource(sourceRel: string): ts.SourceFile | null {
    let cached = sourceCache.get(sourceRel);
    if (cached) return cached;
    const absolute = resolve(REPO_ROOT, sourceRel);
    if (!existsSync(absolute)) return null;
    const text = readFileSync(absolute, 'utf8');
    cached = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true);
    sourceCache.set(sourceRel, cached);
    return cached;
  }

  let totalBlocks = 0;
  const missingImports: string[] = [];

  // Iterate manifest entries; only entries reachable from a public face produce
  // doctests (we want consumer-visible imports to be the source of truth, and
  // not-public entries don't have a public import path to write into the block).
  for (const entry of manifest.entries) {
    if (entry.publicFaces.length === 0) continue;
    const sourceFile = getSource(entry.sourceFile);
    if (!sourceFile) continue;
    const examples = extractExamples(sourceFile, entry.sourceName);
    if (examples.length === 0) continue;
    const batchSlug =
      entry.batch ?? (entry.currentState === 'has-example' ? 'exemplar' : 'unclassified');
    const batchDir = resolve(DOCTESTS_DIR, slugify(batchSlug));
    mkdirSync(batchDir, { recursive: true });

    for (const face of entry.publicFaces) {
      examples.forEach((block, index) => {
        if (!hasWeftImport(block, weftSpecifiers)) {
          missingImports.push(
            `  ${face.importPath}#${face.exportName}#${face.kind} (example ${index + 1}): no 'from \\'${face.importPath}\\'' import in first lines`,
          );
          return;
        }
        const filename = `${slugify(face.importPath)}__${face.exportName}__${face.kind}__${index}.ts`;
        const filePath = resolve(batchDir, filename);
        // Wrap in an IIFE so top-level `await` works without the file becoming
        // a module-scope no-op when the example references unused identifiers.
        const wrapped = `// auto-generated from @example block of ${face.importPath}#${face.exportName}#${face.kind}\n${block}\n`;
        writeFileSync(filePath, wrapped, 'utf8');
        totalBlocks++;
      });
    }
  }

  writeTsconfig(manifest.publicEntryPoints);

  if (missingImports.length > 0) {
    console.error("extract-doctests: examples missing required `from 'weft'` import:");
    for (const line of missingImports) console.error(line);
    process.exit(1);
  }

  console.log(`Wrote ${totalBlocks} doctest files under ${DOCTESTS_DIR}`);
  console.log(`Wrote ${resolve(DOCTESTS_DIR, 'tsconfig.json')}`);
}

main();
