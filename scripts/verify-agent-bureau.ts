#!/usr/bin/env bun
import { $ } from 'bun';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const repositoryRoot = join(import.meta.dir, '..');
const agentBureauPath =
  Bun.env.WEFT_AGENT_BUREAU_PATH ?? '/Users/stevekinney/Developer/agent-bureau';
const temporaryDirectory = join(repositoryRoot, 'tmp', 'agent-bureau-compatibility');
const tsconfigPath = join(temporaryDirectory, 'tsconfig.json');

function packageDeclaration(packageName: string): string {
  return relative(
    repositoryRoot,
    join(agentBureauPath, 'packages', packageName, 'dist', 'index.d.ts'),
  );
}

const packageJson = Bun.file(join(agentBureauPath, 'package.json'));
if (!(await packageJson.exists())) {
  console.error(`Agent Bureau checkout not found at ${agentBureauPath}`);
  process.exit(1);
}

await mkdir(temporaryDirectory, { recursive: true });

await writeFile(
  tsconfigPath,
  JSON.stringify(
    {
      extends: '../../tsconfig.json',
      compilerOptions: {
        noEmit: true,
        incremental: false,
        rootDir: '/Users/stevekinney',
        baseUrl: '../..',
        paths: {
          weft: ['./src/index.ts'],
          armorer: [packageDeclaration('armorer')],
          conversationalist: [packageDeclaration('conversationalist')],
          interoperability: [packageDeclaration('interoperability')],
          lifecycle: [packageDeclaration('lifecycle')],
          storage: [packageDeclaration('storage')],
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
