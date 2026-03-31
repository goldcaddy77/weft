#!/usr/bin/env bun

/**
 * Build a standalone Weft binary using `bun build --compile`.
 *
 * Produces a self-contained executable that bundles the Bun runtime, SQLite,
 * and the Weft server into a single file.
 *
 * Usage:
 *   bun run scripts/build-binary.ts                        # current platform
 *   bun run scripts/build-binary.ts --target darwin-arm64   # specific platform
 *   bun run scripts/build-binary.ts --all                   # all 5 platforms
 *
 * @module build-binary
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** All supported compilation targets. */
const TARGETS = [
  'bun-darwin-arm64',
  'bun-darwin-x64',
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-windows-x64',
] as const;

type BunTarget = (typeof TARGETS)[number];

/** Map from user-facing target names to Bun's internal target identifiers. */
const TARGET_MAP: Record<string, BunTarget> = {
  'darwin-arm64': 'bun-darwin-arm64',
  'darwin-x64': 'bun-darwin-x64',
  'linux-x64': 'bun-linux-x64',
  'linux-arm64': 'bun-linux-arm64',
  'windows-x64': 'bun-windows-x64',
};

/** Derive the output filename for a given target. */
function outputNameForTarget(target: BunTarget): string {
  const suffix = target.replace('bun-', 'weft-');
  if (target.includes('windows')) {
    return `${suffix}.exe`;
  }
  return suffix;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export type BuildBinaryArgs = {
  target: string | undefined;
  all: boolean;
  outdir: string;
  help: boolean;
};

export function parseBuildBinaryArguments(args: string[]): BuildBinaryArgs {
  const { values } = parseArgs({
    args,
    options: {
      target: { type: 'string', short: 't' },
      all: { type: 'boolean', default: false },
      outdir: { type: 'string', short: 'o', default: 'dist' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  return {
    target: values.target,
    all: values.all ?? false,
    outdir: values.outdir ?? 'dist',
    help: values.help ?? false,
  };
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

export const BUILD_BINARY_HELP = `
scripts/build-binary.ts - Compile Weft into a standalone binary

Usage: bun run scripts/build-binary.ts [options]

Options:
  -t, --target <platform>   Target platform (e.g., darwin-arm64, linux-x64)
      --all                 Compile for all supported platforms
  -o, --outdir <path>       Output directory (default: dist)
  -h, --help                Show this help message

Supported targets:
  darwin-arm64   macOS Apple Silicon
  darwin-x64     macOS Intel
  linux-x64      Linux x86_64
  linux-arm64    Linux ARM64
  windows-x64    Windows x86_64
`;

// ---------------------------------------------------------------------------
// Build logic
// ---------------------------------------------------------------------------

export interface BuildResult {
  target: string;
  outputPath: string;
  success: boolean;
  error?: string;
}

/**
 * Compile the CLI entrypoint for a single target using `bun build --compile`.
 *
 * The `--compile` flag is only available via the CLI, not the JS `Bun.build()` API,
 * so we shell out to the `bun` process.
 */
export async function buildForTarget(bunTarget: BunTarget, outdir: string): Promise<BuildResult> {
  const outputName = outputNameForTarget(bunTarget);
  const outputPath = join(outdir, outputName);

  try {
    const proc = Bun.spawn(
      [
        'bun',
        'build',
        '--compile',
        '--target',
        bunTarget,
        '--outfile',
        outputPath,
        '--sourcemap=external',
        '--minify',
        './src/cli.ts',
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      return { target: bunTarget, outputPath, success: false, error: stderr.trim() };
    }

    return { target: bunTarget, outputPath, success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { target: bunTarget, outputPath, success: false, error: message };
  }
}

/** Resolve which targets to build based on CLI args. */
export function resolveTargets(args: BuildBinaryArgs): BunTarget[] {
  if (args.all) {
    return [...TARGETS];
  }

  if (args.target) {
    const mapped = TARGET_MAP[args.target];
    if (!mapped) {
      const valid = Object.keys(TARGET_MAP).join(', ');
      throw new Error(`Unknown target '${args.target}'. Valid targets: ${valid}`);
    }
    return [mapped];
  }

  // Default: current platform
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const supportedArches: Record<string, string> = { arm64: 'arm64', x64: 'x64', x86_64: 'x64' };
  const arch = supportedArches[process.arch];

  if (!arch) {
    throw new Error(
      `Unsupported CPU architecture '${process.arch}'. Supported: ${Object.keys(supportedArches).join(', ')}`,
    );
  }

  const key = `${platform}-${arch}`;
  const mapped = TARGET_MAP[key];

  if (!mapped) {
    throw new Error(`Cannot detect current platform target. Got: ${key}`);
  }

  return [mapped];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const isDirectExecution = typeof Bun !== 'undefined' && Bun.main === import.meta.path;

if (isDirectExecution) {
  const args = parseBuildBinaryArguments(Bun.argv.slice(2));

  if (args.help) {
    console.log(BUILD_BINARY_HELP);
    process.exit(0);
  }

  if (!existsSync(args.outdir)) {
    mkdirSync(args.outdir, { recursive: true });
  }

  const targets = resolveTargets(args);
  console.log(`Building Weft binary for: ${targets.map((t) => t.replace('bun-', '')).join(', ')}`);

  const results: BuildResult[] = [];

  for (const target of targets) {
    console.log(`  Compiling ${target.replace('bun-', '')}...`);
    const result = await buildForTarget(target, args.outdir);
    results.push(result);

    if (result.success) {
      console.log(`  ✓ ${result.outputPath}`);
    } else {
      console.error(`  ✗ ${target}: ${result.error}`);
    }
  }

  const failures = results.filter((r) => !r.success);
  if (failures.length > 0) {
    console.error(`\n${failures.length} target(s) failed.`);
    process.exit(1);
  }

  console.log('\nBinary build complete!');
}
