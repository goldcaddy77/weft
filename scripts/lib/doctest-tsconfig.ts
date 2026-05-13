import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type DoctestPublicEntryPoints = Record<string, string>;

export type DoctestTsconfig = {
  extends: '../../tsconfig.json';
  compilerOptions: {
    noEmit: true;
    noUnusedLocals: false;
    noUnusedParameters: false;
    baseUrl: '.';
    paths: Record<string, string[]>;
  };
  include: ['./**/*.ts'];
  exclude: [];
};

export function createDoctestTsconfig(
  publicEntryPoints: DoctestPublicEntryPoints,
): DoctestTsconfig {
  const paths: Record<string, string[]> = {};
  for (const [importPath, sourceRel] of Object.entries(publicEntryPoints)) {
    paths[importPath] = [
      `../../${validateDoctestSourcePath(importPath, sourceRel).replace(/\.ts$/, '')}`,
    ];
  }
  return {
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
}

function validateDoctestSourcePath(importPath: string, sourceRel: string): string {
  const pathSegments = sourceRel.split(/[\\/]+/);
  if (
    sourceRel.startsWith('/') ||
    sourceRel.includes('\\') ||
    pathSegments.includes('..') ||
    !sourceRel.endsWith('.ts')
  ) {
    throw new Error(
      `Invalid doctest source path for ${importPath}: expected a repository-relative TypeScript path, received ${sourceRel}`,
    );
  }
  return sourceRel;
}

export function formatDoctestTsconfig(publicEntryPoints: DoctestPublicEntryPoints): string {
  return `${JSON.stringify(createDoctestTsconfig(publicEntryPoints), null, 2)}\n`;
}

export function writeDoctestTsconfig(
  doctestsDirectory: string,
  publicEntryPoints: DoctestPublicEntryPoints,
): void {
  writeFileSync(
    resolve(doctestsDirectory, 'tsconfig.json'),
    formatDoctestTsconfig(publicEntryPoints),
    'utf8',
  );
}
