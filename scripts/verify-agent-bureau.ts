#!/usr/bin/env bun
import { $ } from 'bun';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

const repositoryRoot = resolve(import.meta.dir, '..');
const configuredAgentBureauPath = Bun.env.WEFT_AGENT_BUREAU_PATH;
const siblingAgentBureauPath = resolve(repositoryRoot, '..', 'agent-bureau');
const requiredPackages = [
  'armorer',
  'conversationalist',
  'interoperability',
  'lifecycle',
  'storage',
] as const;
const temporaryDirectory = join(repositoryRoot, 'tmp', 'agent-bureau-compatibility');
const tsconfigPath = join(temporaryDirectory, 'tsconfig.json');

async function exists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

async function resolveAgentBureauPath(): Promise<string> {
  if (configuredAgentBureauPath !== undefined) {
    return resolve(configuredAgentBureauPath);
  }

  if (await exists(join(siblingAgentBureauPath, 'package.json'))) {
    return siblingAgentBureauPath;
  }

  console.error(
    [
      'Agent Bureau checkout not found.',
      'Set WEFT_AGENT_BUREAU_PATH to the Agent Bureau checkout path, for example:',
      '  WEFT_AGENT_BUREAU_PATH=/path/to/agent-bureau bun run verify:agent-bureau',
    ].join('\n'),
  );
  process.exit(1);
}

function pathMappingFor(path: string): string {
  const relativePath = relative(repositoryRoot, path).replaceAll(sep, '/');
  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
}

function commonAncestor(paths: readonly string[]): string {
  const [firstPath, ...remainingPaths] = paths.map((path) => resolve(path).split(sep));
  if (firstPath === undefined) return sep;

  const prefix = [...firstPath];
  for (const pathSegments of remainingPaths) {
    while (
      prefix.length > 0 &&
      prefix.join(sep) !== pathSegments.slice(0, prefix.length).join(sep)
    ) {
      prefix.pop();
    }
  }

  const ancestor = prefix.join(sep);
  return ancestor === '' ? sep : ancestor;
}

async function packageDeclaration(agentBureauPath: string, packageName: string): Promise<string> {
  const distDeclaration = join(agentBureauPath, 'packages', packageName, 'dist', 'index.d.ts');
  if (await exists(distDeclaration)) {
    return pathMappingFor(distDeclaration);
  }

  const sourceEntrypoint = join(agentBureauPath, 'packages', packageName, 'src', 'index.ts');
  if (await exists(sourceEntrypoint)) {
    return pathMappingFor(sourceEntrypoint);
  }

  throw new Error(
    [
      `Missing Agent Bureau package entrypoint for "${packageName}".`,
      `Checked: ${distDeclaration}`,
      `Checked: ${sourceEntrypoint}`,
      'Build Agent Bureau or point WEFT_AGENT_BUREAU_PATH at a checkout with package sources.',
    ].join('\n'),
  );
}

const agentBureauPath = await resolveAgentBureauPath();
const packageJson = Bun.file(join(agentBureauPath, 'package.json'));
if (!(await packageJson.exists())) {
  console.error(`Agent Bureau checkout not found at ${agentBureauPath}`);
  process.exit(1);
}

const pathMappings: Record<(typeof requiredPackages)[number], string[]> = {
  armorer: [await packageDeclaration(agentBureauPath, 'armorer')],
  conversationalist: [await packageDeclaration(agentBureauPath, 'conversationalist')],
  interoperability: [await packageDeclaration(agentBureauPath, 'interoperability')],
  lifecycle: [await packageDeclaration(agentBureauPath, 'lifecycle')],
  storage: [await packageDeclaration(agentBureauPath, 'storage')],
};

await mkdir(temporaryDirectory, { recursive: true });

await writeFile(
  tsconfigPath,
  JSON.stringify(
    {
      extends: '../../tsconfig.json',
      compilerOptions: {
        noEmit: true,
        incremental: false,
        rootDir: commonAncestor([repositoryRoot, agentBureauPath]),
        baseUrl: '../..',
        paths: {
          weft: ['./src/index.ts'],
          ...pathMappings,
        },
      },
      include: ['../../tests/agent-bureau-compatibility/**/*.test-d.ts'],
      exclude: ['../../node_modules', '../../coverage', '../../dist', '../../build'],
    },
    null,
    2,
  ),
);

await $`bunx tsc --noEmit -p ${tsconfigPath}`;
