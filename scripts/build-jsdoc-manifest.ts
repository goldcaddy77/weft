/**
 * Builds reference/jsdoc-manifest.json — the deterministic denominator for the
 * "every public API export carries JSDoc" verification gates.
 *
 * Two-pass walker:
 *   Pass 1 (public-face discovery): walks every public entry point listed in
 *     package.json `exports`, resolves the source .ts file backing each, and
 *     records every reachable (importPath, exportName, kind) public face.
 *   Pass 2 (source enumeration): walks every contributing source file and
 *     emits manifest entries with `publicFaces: []` for declarations not
 *     reached in Pass 1 — surfaces "not-public" candidates for review.
 *
 * Identity key: (sourceFile, sourceName, kind) where kind ∈ {value,type,namespace}.
 * Public-face key: (importPath, exportName, kind) per element of publicFaces.
 *
 * `classification` is always written as "unclassified". The manual classification
 * pass (step 3 of the JSDoc plan) sets it to example-required | prose-only | not-public.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = resolve(import.meta.dir, '..');
const PACKAGE_JSON = resolve(REPO_ROOT, 'package.json');
const MANIFEST_PATH = resolve(REPO_ROOT, 'reference/jsdoc-manifest.json');

type SymbolKind = 'value' | 'type' | 'namespace';

type PublicFace = {
  importPath: string;
  exportName: string;
  kind: SymbolKind;
};

type CurrentState = 'no-jsdoc' | 'prose-only' | 'has-example';

type ManifestEntry = {
  sourceFile: string;
  sourceName: string;
  kind: SymbolKind;
  subKind: string;
  publicFaces: PublicFace[];
  classification: 'unclassified' | 'example-required' | 'prose-only' | 'not-public';
  currentState: CurrentState;
  classificationRationale: string | null;
  batch: string | null;
};

type Manifest = {
  publicEntryPoints: Record<string, string>;
  entries: ManifestEntry[];
};

type PersistedManifestEntry = Pick<
  ManifestEntry,
  'sourceFile' | 'sourceName' | 'kind' | 'subKind' | 'publicFaces' | 'classification'
>;

// ---------------------------------------------------------------------------
// Read package.json `exports` and resolve each public specifier to a source file.
// `dist/foo/bar.d.ts` -> `src/foo/bar.ts`. Source-side authoritative lookup.
// ---------------------------------------------------------------------------

function distToSource(distRelative: string): string {
  // distRelative looks like "./dist/storage/memory.d.ts" or "./dist/index.d.ts".
  const stripped = distRelative
    .replace(/^\.\//, '')
    .replace(/^dist\//, 'src/')
    .replace(/\.d\.ts$/, '.ts');
  return stripped;
}

function pickTypesField(value: unknown): string | null {
  // A plain-string export (e.g. "./foo.js") points at runtime JS only and
  // carries no type information — return null to match the audit + check
  // scripts' behavior.
  if (typeof value === 'string') return null;
  if (value === null || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj['types'] === 'string') return obj['types'];
  // Conditional shape with platform-specific types in nested fields like
  // { bun: { types: ... } } or { node: { types: ... } }. We return null
  // here — `splitConditionalTypes` is the proper way to enumerate per-platform
  // sources separately (see `buildPublicEntryPoints`). Returning a single
  // first-match types field would silently drop the other platform's source.
  for (const key of ['bun', 'node', 'import', 'default'] as const) {
    const inner = obj[key];
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      const innerTypes = (inner as Record<string, unknown>)['types'];
      if (typeof innerTypes === 'string') return null;
    }
  }
  return null;
}

/**
 * For conditional exports without a top-level `types` field but with nested
 * platform conditions, return the per-platform source paths so the manifest
 * tracks each platform's source independently. Skips when a top-level `types`
 * field exists (handled by `pickTypesField`).
 */
function splitConditionalTypes(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return [];
  const obj = value as Record<string, unknown>;
  if (typeof obj['types'] === 'string') return [];
  const out: string[] = [];
  for (const key of ['bun', 'node', 'import', 'default'] as const) {
    const inner = obj[key];
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      const innerTypes = (inner as Record<string, unknown>)['types'];
      if (typeof innerTypes === 'string') out.push(innerTypes);
    }
  }
  return out;
}

function buildPublicEntryPoints(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
    name: string;
    exports?: Record<string, unknown>;
  };
  if (!pkg.exports) {
    throw new Error('package.json missing `exports` map');
  }
  const out: Record<string, string> = {};
  for (const [subpath, value] of Object.entries(pkg.exports)) {
    const importPath = subpath === '.' ? pkg.name : `${pkg.name}/${subpath.replace(/^\.\//, '')}`;

    const typesPath = pickTypesField(value);
    if (typesPath) {
      const sourcePath = distToSource(typesPath);
      out[importPath] = relative(REPO_ROOT, resolve(REPO_ROOT, sourcePath));
      continue;
    }

    // Conditional export with platform-specific types and no top-level
    // unification (e.g. `./storage/sqlite` whose types differ per bun/node).
    // Skip the unified specifier — both platform-specific sources should be
    // covered by their own explicit subpaths (e.g. `./storage/sqlite/bun`).
    // If neither explicit subpath exists, this is a real coverage gap that
    // should be addressed in package.json by adding a unified types field
    // or splitting the export into explicit per-platform subpaths.
    const platformTypes = splitConditionalTypes(value);
    if (platformTypes.length === 0) continue;
    // Has platform-specific types but no unified top-level `types` field.
    // We deliberately skip the conditional importPath — there is no single
    // source file to map it to, and forcing a pick (e.g. always-bun) would
    // silently drop the other platform's surface from the manifest. The
    // explicit per-platform subpaths (./storage/sqlite/bun, ./storage/sqlite/node)
    // must cover both. Verify package.json if a platform source is unexpectedly
    // absent from the manifest.
  }
  return out;
}

// ---------------------------------------------------------------------------
// TypeScript program shared by Pass 1 and Pass 2.
// ---------------------------------------------------------------------------

function loadProgram(rootFiles: string[]): ts.Program {
  const config = ts.findConfigFile(REPO_ROOT, ts.sys.fileExists.bind(ts.sys), 'tsconfig.json');
  if (!config) throw new Error('tsconfig.json not found');
  const parsed = ts.readConfigFile(config, ts.sys.readFile.bind(ts.sys));
  if (parsed.error)
    throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'));
  const compilerOptions = ts.parseJsonConfigFileContent(
    parsed.config,
    ts.sys,
    dirname(config),
  ).options;
  return ts.createProgram(rootFiles, { ...compilerOptions, noEmit: true });
}

// ---------------------------------------------------------------------------
// Map a TypeScript symbol's flags to our kind/subKind taxonomy.
// ---------------------------------------------------------------------------

function symbolKind(symbol: ts.Symbol): { kind: SymbolKind; subKind: string } {
  const flags = symbol.flags;
  if (flags & ts.SymbolFlags.Class) return { kind: 'value', subKind: 'class' };
  if (flags & ts.SymbolFlags.Enum) return { kind: 'value', subKind: 'enum' };
  if (flags & ts.SymbolFlags.Function) return { kind: 'value', subKind: 'function' };
  if (flags & ts.SymbolFlags.Variable) return { kind: 'value', subKind: 'const' };
  if (flags & ts.SymbolFlags.Interface) return { kind: 'type', subKind: 'interface' };
  if (flags & ts.SymbolFlags.TypeAlias) return { kind: 'type', subKind: 'type-alias' };
  if (flags & ts.SymbolFlags.Module || flags & ts.SymbolFlags.Namespace) {
    return { kind: 'namespace', subKind: 'namespace' };
  }
  if (flags & ts.SymbolFlags.Type) return { kind: 'type', subKind: 'type' };
  if (flags & ts.SymbolFlags.Value) return { kind: 'value', subKind: 'value' };
  return { kind: 'value', subKind: 'unknown' };
}

// ---------------------------------------------------------------------------
// JSDoc inspection: derive `currentState` from a symbol's source-side JSDoc.
// "has-example" requires both prose description AND at least one @example tag.
// ---------------------------------------------------------------------------

function detectCurrentState(symbol: ts.Symbol): CurrentState {
  // Accumulate hasProse and hasExample across ALL declarations so that
  // overload signatures with split JSDoc (one declaration carries the prose,
  // another carries the @example) aggregate correctly. Returning early on
  // the first declaration would silently misclassify these.
  const declarations = symbol.declarations ?? [];
  let hasProse = false;
  let hasExample = false;
  for (const decl of declarations) {
    const tags = ts.getJSDocTags(decl);
    if (tags.some((tag) => tag.tagName.text === 'example')) hasExample = true;
    const jsdocComments = ts.getJSDocCommentsAndTags(decl);
    let proseText = '';
    for (const node of jsdocComments) {
      if (ts.isJSDoc(node)) {
        const comment = node.comment;
        if (typeof comment === 'string') proseText += comment;
        else if (Array.isArray(comment)) {
          for (const part of comment) {
            if (part.kind === ts.SyntaxKind.JSDocText) {
              proseText += (part as ts.JSDocText).text;
            }
          }
        }
      }
    }
    if (proseText.trim().length > 0) hasProse = true;
  }
  if (hasProse && hasExample) return 'has-example';
  if (hasProse) return 'prose-only';
  return 'no-jsdoc';
}

// ---------------------------------------------------------------------------
// Walk a symbol back to its real declaration (resolving aliases / re-exports).
// Returns { sourceFile, sourceName, kind, subKind } for the underlying symbol.
// ---------------------------------------------------------------------------

function resolveToSourceDeclaration(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): {
  sourceFile: string;
  sourceName: string;
  kind: SymbolKind;
  subKind: string;
  underlying: ts.Symbol;
} | null {
  let current = symbol;
  const seen = new Set<ts.Symbol>();
  while (current.flags & ts.SymbolFlags.Alias) {
    const next = checker.getAliasedSymbol(current);
    if (!next || next === current) break;
    current = next;
  }
  // Bun-barrel workaround: `const exportedX = X; export { exportedX as X }`.
  while (
    current.flags & ts.SymbolFlags.Variable &&
    !seen.has(current) &&
    current.declarations &&
    current.declarations.length > 0
  ) {
    seen.add(current);
    const variableDeclaration = current.declarations.find(ts.isVariableDeclaration);
    if (!variableDeclaration) break;
    const initializer = variableDeclaration.initializer;
    if (initializer === undefined || !ts.isIdentifier(initializer)) break;
    const initializerSymbol = checker.getSymbolAtLocation(initializer);
    if (!initializerSymbol || initializerSymbol === current) break;
    let next = initializerSymbol;
    while (next.flags & ts.SymbolFlags.Alias) {
      const aliased = checker.getAliasedSymbol(next);
      if (!aliased || aliased === next) break;
      next = aliased;
    }
    if (next === current) break;
    current = next;
  }
  const decls = current.declarations ?? [];
  if (decls.length === 0) return null;
  // Prefer non-namespace-export declarations (pick the actual class/function/etc).
  const decl = decls.find((d) => !ts.isExportSpecifier(d) && !ts.isExportAssignment(d)) ?? decls[0];
  const sourceFile = relative(REPO_ROOT, decl.getSourceFile().fileName);
  if (sourceFile.startsWith('..') || sourceFile.includes('node_modules')) return null;
  const { kind, subKind } = symbolKind(current);
  return {
    sourceFile,
    sourceName: current.getName(),
    kind,
    subKind,
    underlying: current,
  };
}

// ---------------------------------------------------------------------------
// Identity-key dedup map for manifest entries.
// ---------------------------------------------------------------------------

function entryKey(sourceFile: string, sourceName: string, kind: SymbolKind): string {
  return `${sourceFile}|${sourceName}|${kind}`;
}

function publicFacesFingerprint(publicFaces: PublicFace[]): string {
  return publicFaces
    .toSorted((a, b) => {
      if (a.importPath !== b.importPath) return a.importPath < b.importPath ? -1 : 1;
      if (a.exportName !== b.exportName) return a.exportName < b.exportName ? -1 : 1;
      return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
    })
    .map((face) => `${face.importPath}#${face.exportName}#${face.kind}`)
    .join('|');
}

function entryFingerprint(entry: Pick<ManifestEntry, 'subKind' | 'publicFaces'>): string {
  return `${entry.subKind}|${publicFacesFingerprint(entry.publicFaces)}`;
}

// ---------------------------------------------------------------------------
// Pass 1 — public-face discovery.
// ---------------------------------------------------------------------------

function runPass1(
  publicEntryPoints: Record<string, string>,
  program: ts.Program,
): Map<string, ManifestEntry> {
  const checker = program.getTypeChecker();
  const entries = new Map<string, ManifestEntry>();

  for (const [importPath, sourceRelative] of Object.entries(publicEntryPoints)) {
    const absoluteEntry = resolve(REPO_ROOT, sourceRelative);
    const entrySourceFile = program.getSourceFile(absoluteEntry);
    if (!entrySourceFile) {
      console.warn(`Pass 1: entry point ${importPath} → ${sourceRelative} not in program`);
      continue;
    }
    const moduleSymbol = checker.getSymbolAtLocation(entrySourceFile);
    if (!moduleSymbol) {
      console.warn(`Pass 1: no module symbol for ${importPath}`);
      continue;
    }
    const exports = checker.getExportsOfModule(moduleSymbol);
    for (const exportSymbol of exports) {
      const exportName = exportSymbol.getName();
      const resolved = resolveToSourceDeclaration(exportSymbol, checker);
      if (!resolved) continue;
      const key = entryKey(resolved.sourceFile, resolved.sourceName, resolved.kind);
      let entry = entries.get(key);
      if (!entry) {
        entry = {
          sourceFile: resolved.sourceFile,
          sourceName: resolved.sourceName,
          kind: resolved.kind,
          subKind: resolved.subKind,
          publicFaces: [],
          classification: 'unclassified',
          currentState: detectCurrentState(resolved.underlying),
          classificationRationale: null,
          batch: null,
        };
        entries.set(key, entry);
      }
      // Add public face — kind comes from the resolved underlying symbol so
      // type-only re-exports (interfaces, type aliases) are correctly classified.
      const faceKind = resolved.kind;
      const faceTuple: PublicFace = { importPath, exportName, kind: faceKind };
      const dup = entry.publicFaces.some(
        (f) => f.importPath === importPath && f.exportName === exportName && f.kind === faceKind,
      );
      if (!dup) entry.publicFaces.push(faceTuple);
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Pass 2 — source enumeration. Adds entries with publicFaces:[] for any
// exported declaration not already seen.
// ---------------------------------------------------------------------------

function runPass2(entries: Map<string, ManifestEntry>, program: ts.Program): void {
  const checker = program.getTypeChecker();
  const sourceFiles = new Set<string>();
  for (const entry of entries.values()) sourceFiles.add(entry.sourceFile);

  for (const sourceRelative of sourceFiles) {
    const absoluteSource = resolve(REPO_ROOT, sourceRelative);
    const sourceFile = program.getSourceFile(absoluteSource);
    if (!sourceFile) continue;
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) continue;
    const exports = checker.getExportsOfModule(moduleSymbol);
    for (const exportSymbol of exports) {
      const resolved = resolveToSourceDeclaration(exportSymbol, checker);
      if (!resolved) continue;
      // Pass 2 only emits entries whose source declaration lives in this same
      // file — otherwise we double-count re-exports across files.
      if (resolved.sourceFile !== sourceRelative) continue;
      const key = entryKey(resolved.sourceFile, resolved.sourceName, resolved.kind);
      if (entries.has(key)) continue;
      entries.set(key, {
        sourceFile: resolved.sourceFile,
        sourceName: resolved.sourceName,
        kind: resolved.kind,
        subKind: resolved.subKind,
        publicFaces: [],
        classification: 'unclassified',
        currentState: detectCurrentState(resolved.underlying),
        classificationRationale: null,
        batch: null,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

function main(): void {
  const publicEntryPoints = buildPublicEntryPoints();
  const rootFiles = Object.values(publicEntryPoints).map((p) => resolve(REPO_ROOT, p));
  const program = loadProgram(rootFiles);

  const entries = runPass1(publicEntryPoints, program);
  runPass2(entries, program);

  // Preserve existing classifications from a prior committed manifest only
  // when the structural fingerprint is unchanged. This keeps manual
  // classifications stable across rebuilds while forcing review when a symbol
  // becomes public, changes public faces, or changes declaration shape.
  if (existsSync(MANIFEST_PATH)) {
    const prior = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
      entries?: PersistedManifestEntry[];
    };
    const priorByKey = new Map<
      string,
      { classification: ManifestEntry['classification']; fingerprint: string }
    >();
    for (const e of prior.entries ?? []) {
      if (e.classification && e.classification !== 'unclassified') {
        priorByKey.set(entryKey(e.sourceFile, e.sourceName, e.kind), {
          classification: e.classification,
          fingerprint: entryFingerprint(e),
        });
      }
    }
    for (const entry of entries.values()) {
      const key = entryKey(entry.sourceFile, entry.sourceName, entry.kind);
      const priorEntry = priorByKey.get(key);
      if (priorEntry && priorEntry.fingerprint === entryFingerprint(entry)) {
        entry.classification = priorEntry.classification;
      }
    }
  }

  // Sort entries deterministically for stable diffs.
  const sorted = [...entries.values()].toSorted((a, b) => {
    if (a.sourceFile !== b.sourceFile) return a.sourceFile < b.sourceFile ? -1 : 1;
    if (a.sourceName !== b.sourceName) return a.sourceName < b.sourceName ? -1 : 1;
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
  });

  // Sort each entry's publicFaces deterministically.
  for (const entry of sorted) {
    entry.publicFaces = entry.publicFaces.toSorted((a, b) => {
      if (a.importPath !== b.importPath) return a.importPath < b.importPath ? -1 : 1;
      if (a.exportName !== b.exportName) return a.exportName < b.exportName ? -1 : 1;
      return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
    });
  }

  // The committed manifest only stores fields that are NOT cheaply re-derivable
  // from source: classification (semantic decisions made by humans/classifier)
  // and the structural shape (sourceFile/sourceName/kind/subKind/publicFaces,
  // plus publicEntryPoints). `currentState`, `classificationRationale`, and
  // `batch` are regenerated on every run by the build/classify scripts and
  // would only add noise to the diff. Consumers (audit, check-declaration)
  // re-derive currentState from source on each run.
  const persistedEntries = sorted.map((entry) => ({
    sourceFile: entry.sourceFile,
    sourceName: entry.sourceName,
    kind: entry.kind,
    subKind: entry.subKind,
    publicFaces: entry.publicFaces,
    classification: entry.classification,
  }));
  const manifest = { publicEntryPoints, entries: persistedEntries };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const total = sorted.length;
  const reachable = sorted.filter((e) => e.publicFaces.length > 0).length;
  const orphaned = total - reachable;
  const hasExample = sorted.filter((e) => e.currentState === 'has-example').length;
  const proseOnly = sorted.filter((e) => e.currentState === 'prose-only').length;
  const noJsdoc = sorted.filter((e) => e.currentState === 'no-jsdoc').length;
  console.log(`Wrote ${MANIFEST_PATH}`);
  console.log(`  ${total} total entries`);
  console.log(`  ${reachable} reachable from a public entry point`);
  console.log(`  ${orphaned} not-public candidates (publicFaces: [])`);
  console.log(
    `  currentState: has-example=${hasExample} prose-only=${proseOnly} no-jsdoc=${noJsdoc}`,
  );
}

main();
