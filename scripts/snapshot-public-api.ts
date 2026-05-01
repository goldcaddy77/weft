/**
 * Snapshots the public API surface emitted by package export declaration files.
 *
 * The script walks exported declaration files with the TypeScript compiler API,
 * canonicalizes each exported symbol to one line, and either updates or checks
 * `documentation/public-api.snapshot.txt`.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = resolve(import.meta.dir, '..');
const PACKAGE_JSON_PATH = resolve(REPO_ROOT, 'package.json');
const SNAPSHOT_PATH = resolve(REPO_ROOT, 'documentation/public-api.snapshot.txt');
const HEADER = '# Public API surface snapshot — see scripts/snapshot-public-api.ts';
const TYPE_FORMAT_FLAGS =
  ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;
const IMPLEMENTATION_SPECIFIC_EXPORTS = new Set([
  './storage/bun-sqlite',
  './storage/sqlite/bun',
  './storage/sqlite/node',
]);

type ProgramBuild = { program: ts.Program; checker: ts.TypeChecker; sourceFile: ts.SourceFile };
type CommandMode = 'check' | 'update';
type PackageEntrypoint = { subpath: string; dtsPath: string };

function readPackageExports(): PackageEntrypoint[] {
  const parsedPackageJson: unknown = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'));

  if (!isRecord(parsedPackageJson) || !isRecord(parsedPackageJson.exports)) {
    throw new Error('package.json must define an exports map.');
  }

  return Object.entries(parsedPackageJson.exports)
    .flatMap(([subpath, exportValue]) => {
      if (!isRecord(exportValue)) return [];
      if (IMPLEMENTATION_SPECIFIC_EXPORTS.has(subpath)) return [];

      const typesPath = exportValue.types;
      if (typeof typesPath !== 'string') return [];

      return [{ subpath, dtsPath: resolve(REPO_ROOT, typesPath) }];
    })
    .toSorted((left, right) =>
      left.subpath < right.subpath ? -1 : left.subpath > right.subpath ? 1 : 0,
    );
}

function buildProgram(entryPath: string): ProgramBuild {
  const program = ts.createProgram([entryPath], {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    allowJs: false,
  });
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(entryPath);
  if (!sourceFile) {
    console.error(`Error: unable to load ${entryPath}.`);
    process.exit(1);
  }
  return { program, checker, sourceFile };
}

function extractExportLines(
  program: ts.Program,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  visited: Set<string> = new Set(),
): string[] {
  if (visited.has(sourceFile.fileName)) return [];
  visited.add(sourceFile.fileName);

  const lines: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      lines.push(...exportDeclarationLines(statement, program, checker, sourceFile, visited));
      continue;
    }
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const line = variableDeclarationLine(declaration, checker);
        if (line) lines.push(line);
      }
      continue;
    }
    if (hasExportModifier(statement)) {
      const line = namedDeclarationLine(statement, checker);
      if (line) lines.push(line);
    }
  }
  return lines;
}

function exportDeclarationLines(
  declaration: ts.ExportDeclaration,
  program: ts.Program,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  visited: Set<string>,
): string[] {
  const moduleSpecifier = stringModuleSpecifier(declaration.moduleSpecifier);
  if (!declaration.exportClause) {
    if (!moduleSpecifier) return [];
    const exportedSourceFile = resolveExportedSourceFile(program, sourceFile, moduleSpecifier);
    if (!exportedSourceFile) return [];
    return extractExportLines(program, checker, exportedSourceFile, visited);
  }

  if (!ts.isNamedExports(declaration.exportClause)) return [];

  if (!moduleSpecifier) {
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) return [];
    const moduleExports = checker.getExportsOfModule(moduleSymbol);
    return declaration.exportClause.elements
      .map((element) => lineForExportSpecifier(element, checker, moduleExports))
      .filter(isString);
  }

  const exportedSourceFile = resolveExportedSourceFile(program, sourceFile, moduleSpecifier);
  if (!exportedSourceFile) return [];
  const moduleSymbol = checker.getSymbolAtLocation(exportedSourceFile);
  if (!moduleSymbol) return [];
  const moduleExports = checker.getExportsOfModule(moduleSymbol);
  return declaration.exportClause.elements
    .map((element) => lineForExportSpecifier(element, checker, moduleExports))
    .filter(isString);
}

function lineForExportSpecifier(
  element: ts.ExportSpecifier,
  checker: ts.TypeChecker,
  moduleExports: ts.Symbol[],
): string | null {
  const exportedName = element.name.text;
  const localName = element.propertyName?.text ?? exportedName;
  const symbol = moduleExports.find((candidate) => candidate.getName() === localName);
  if (!symbol) return null;
  return symbolLine(symbol, checker, exportedName);
}

function resolveExportedSourceFile(
  program: ts.Program,
  sourceFile: ts.SourceFile,
  moduleSpecifier: string,
): ts.SourceFile | null {
  const resolvedModule = ts.resolveModuleName(
    moduleSpecifier,
    sourceFile.fileName,
    program.getCompilerOptions(),
    ts.sys,
  ).resolvedModule;

  if (resolvedModule) {
    const resolvedSourceFile = program.getSourceFile(resolvedModule.resolvedFileName);
    if (resolvedSourceFile) return resolvedSourceFile;
  }

  const basePath = resolve(dirname(sourceFile.fileName), moduleSpecifier);
  const declarationPath = declarationPathFor(basePath);
  return program.getSourceFile(declarationPath) ?? null;
}

function declarationPathFor(basePath: string): string {
  if (basePath.endsWith('.d.ts')) return basePath;
  if (basePath.endsWith('.js')) return `${basePath.slice(0, -'.js'.length)}.d.ts`;
  return `${basePath}.d.ts`;
}

function stringModuleSpecifier(moduleSpecifier: ts.Expression | undefined): string | null {
  if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) return null;
  return moduleSpecifier.text;
}

function namedDeclarationLine(declaration: ts.Statement, checker: ts.TypeChecker): string | null {
  if (
    ts.isTypeAliasDeclaration(declaration) ||
    ts.isInterfaceDeclaration(declaration) ||
    ts.isClassDeclaration(declaration) ||
    ts.isFunctionDeclaration(declaration)
  ) {
    if (!declaration.name) return null;
    const symbol = checker.getSymbolAtLocation(declaration.name);
    if (!symbol) return null;
    return symbolLine(symbol, checker, declaration.name.text);
  }
  return null;
}

function symbolLine(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  exportedName: string = symbol.getName(),
): string | null {
  const resolvedSymbol = resolveAlias(symbol, checker);
  const declarations = resolvedSymbol.declarations ?? [];
  const classDeclaration = declarations.find(ts.isClassDeclaration);
  if (classDeclaration) return classLine(classDeclaration, checker, exportedName);

  const interfaceDeclaration = declarations.find(ts.isInterfaceDeclaration);
  if (interfaceDeclaration) return interfaceLine(interfaceDeclaration, checker, exportedName);

  const typeAliasDeclaration = declarations.find(ts.isTypeAliasDeclaration);
  if (typeAliasDeclaration) return typeAliasLine(typeAliasDeclaration, checker, exportedName);

  const functionDeclaration = declarations.find(ts.isFunctionDeclaration);
  if (functionDeclaration) return functionLine(functionDeclaration, checker, exportedName);

  const variableDeclaration = declarations.find(ts.isVariableDeclaration);
  if (variableDeclaration)
    return variableDeclarationLine(variableDeclaration, checker, exportedName);

  return null;
}

function resolveAlias(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  let current = symbol;
  const seen = new Set<ts.Symbol>();
  while (current.flags & ts.SymbolFlags.Alias) {
    if (seen.has(current)) return current;
    seen.add(current);
    const next = checker.getAliasedSymbol(current);
    if (next === current) return current;
    current = next;
  }
  return current;
}

function typeAliasLine(
  declaration: ts.TypeAliasDeclaration,
  checker: ts.TypeChecker,
  exportedName: string,
): string {
  const type = checker.getTypeFromTypeNode(declaration.type);
  return `type ${exportedName} = ${typeAliasString(checker, type, declaration.type)}`;
}

function interfaceLine(
  declaration: ts.InterfaceDeclaration,
  checker: ts.TypeChecker,
  exportedName: string,
): string {
  const members = sortedMemberSignatures(declaration.members, checker);
  return `interface ${exportedName} { ${members.join('; ')} }`;
}

function classLine(
  declaration: ts.ClassDeclaration,
  checker: ts.TypeChecker,
  exportedName: string,
): string {
  const members = sortedMemberSignatures(declaration.members, checker);
  return `class ${exportedName} { ${members.join('; ')} }`;
}

function functionLine(
  declaration: ts.FunctionDeclaration,
  checker: ts.TypeChecker,
  exportedName: string,
): string {
  const typeParameters = typeParameterSignature(declaration.typeParameters);
  return `function ${exportedName}${typeParameters}(${parameterSignatures(
    declaration.parameters,
    checker,
  ).join(', ')}): ${returnTypeSignature(declaration, checker)}`;
}

function variableDeclarationLine(
  declaration: ts.VariableDeclaration,
  checker: ts.TypeChecker,
  exportedName?: string,
): string | null {
  if (!ts.isIdentifier(declaration.name)) return null;
  const name = exportedName ?? declaration.name.text;
  const symbol = checker.getSymbolAtLocation(declaration.name);
  if (!symbol) return null;
  const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
  return `const ${name}: ${typeString(checker, type, declaration)}`;
}

function sortedMemberSignatures(
  members: ts.NodeArray<ts.TypeElement> | ts.NodeArray<ts.ClassElement>,
  checker: ts.TypeChecker,
): string[] {
  return members
    .map((member) => memberSignature(member, checker))
    .filter(isString)
    .toSorted((left, right) => {
      const leftName = memberSortName(left);
      const rightName = memberSortName(right);
      if (leftName !== rightName) return leftName < rightName ? -1 : 1;
      return left < right ? -1 : left > right ? 1 : 0;
    });
}

function memberSignature(
  member: ts.TypeElement | ts.ClassElement,
  checker: ts.TypeChecker,
): string | null {
  if (isNonPublicMember(member)) return null;

  if (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) {
    const name = memberName(member.name);
    if (!name) return null;
    const type = memberType(member, checker);
    if (!type) return null;
    return `${memberPrefixes(member)}${name}${optionalMarker(member)}: ${type}`;
  }

  if (ts.isMethodSignature(member) || ts.isMethodDeclaration(member)) {
    const name = memberName(member.name);
    if (!name) return null;
    const typeParameters = typeParameterSignature(member.typeParameters);
    return `${memberPrefixes(member)}${name}${optionalMarker(member)}${typeParameters}(${parameterSignatures(
      member.parameters,
      checker,
    ).join(', ')}): ${returnTypeSignature(member, checker)}`;
  }

  if (ts.isGetAccessorDeclaration(member)) {
    const name = memberName(member.name);
    if (!name) return null;
    return `${memberPrefixes(member)}${name}: ${returnTypeSignature(member, checker)}`;
  }

  if (ts.isSetAccessorDeclaration(member)) {
    const name = memberName(member.name);
    if (!name) return null;
    const parameter = member.parameters[0];
    if (!parameter) return null;
    return `${memberPrefixes(member)}${name}: ${parameterTypeSignature(parameter, checker)}`;
  }

  return null;
}

function memberPrefixes(member: ts.TypeElement | ts.ClassElement): string {
  const prefixes: string[] = [];
  if (hasModifierKind(member, ts.SyntaxKind.StaticKeyword)) prefixes.push('static');
  if (hasModifierKind(member, ts.SyntaxKind.AbstractKeyword)) prefixes.push('abstract');
  if (hasModifierKind(member, ts.SyntaxKind.ReadonlyKeyword)) prefixes.push('readonly');
  return prefixes.length > 0 ? `${prefixes.join(' ')} ` : '';
}

function memberSortName(signature: string): string {
  let rest = signature;
  for (const prefix of ['static ', 'abstract ', 'readonly ']) {
    if (rest.startsWith(prefix)) {
      rest = rest.slice(prefix.length);
    }
  }
  const delimiterIndexes = ['?', ':', '(']
    .map((delimiter) => rest.indexOf(delimiter))
    .filter((index) => index >= 0);
  if (delimiterIndexes.length === 0) return rest;
  return rest.slice(0, Math.min(...delimiterIndexes));
}

function isNonPublicMember(member: ts.TypeElement | ts.ClassElement): boolean {
  if (ts.isPropertyDeclaration(member) && ts.isPrivateIdentifier(member.name)) return true;
  if (ts.isMethodDeclaration(member) && ts.isPrivateIdentifier(member.name)) return true;
  if (ts.isGetAccessorDeclaration(member) && ts.isPrivateIdentifier(member.name)) return true;
  if (ts.isSetAccessorDeclaration(member) && ts.isPrivateIdentifier(member.name)) return true;
  return (
    hasModifierKind(member, ts.SyntaxKind.PrivateKeyword) ||
    hasModifierKind(member, ts.SyntaxKind.ProtectedKeyword)
  );
}

function hasExportModifier(node: ts.Node): boolean {
  return hasModifierKind(node, ts.SyntaxKind.ExportKeyword);
}

function hasModifierKind(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false;
}

function memberName(name: ts.PropertyName | undefined): string | null {
  if (!name || ts.isPrivateIdentifier(name)) return null;
  return normalizeSignatureText(name.getText());
}

function optionalMarker(
  member: ts.MethodSignature | ts.MethodDeclaration | ts.PropertySignature | ts.PropertyDeclaration,
): string {
  return member.questionToken ? '?' : '';
}

function memberType(
  member: ts.PropertySignature | ts.PropertyDeclaration,
  checker: ts.TypeChecker,
): string | null {
  const symbol = checker.getSymbolAtLocation(member.name);
  if (symbol) {
    return typeString(checker, checker.getTypeOfSymbolAtLocation(symbol, member), member);
  }
  if (member.type) return typeString(checker, checker.getTypeFromTypeNode(member.type), member);
  return null;
}

function parameterSignatures(
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
  checker: ts.TypeChecker,
): string[] {
  return parameters.map((parameter) => parameterSignature(parameter, checker));
}

function parameterSignature(parameter: ts.ParameterDeclaration, checker: ts.TypeChecker): string {
  const restPrefix = parameter.dotDotDotToken ? '...' : '';
  const optional = parameter.questionToken ? '?' : '';
  const name = normalizeSignatureText(parameter.name.getText());
  return `${restPrefix}${name}${optional}: ${parameterTypeSignature(parameter, checker)}`;
}

function parameterTypeSignature(
  parameter: ts.ParameterDeclaration,
  checker: ts.TypeChecker,
): string {
  if (parameter.type)
    return typeString(checker, checker.getTypeFromTypeNode(parameter.type), parameter);
  const symbol = checker.getSymbolAtLocation(parameter.name);
  if (!symbol) return 'unknown';
  return typeString(checker, checker.getTypeOfSymbolAtLocation(symbol, parameter), parameter);
}

function returnTypeSignature(
  declaration: ts.SignatureDeclaration,
  checker: ts.TypeChecker,
): string {
  const signature = checker.getSignatureFromDeclaration(declaration);
  if (signature) return typeString(checker, signature.getReturnType(), declaration);
  if (declaration.type)
    return typeString(checker, checker.getTypeFromTypeNode(declaration.type), declaration);
  return 'void';
}

function typeParameterSignature(
  typeParameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
): string {
  if (!typeParameters || typeParameters.length === 0) return '';
  return `<${typeParameters.map((typeParameter) => normalizeSignatureText(typeParameter.getText())).join(', ')}>`;
}

function typeString(checker: ts.TypeChecker, type: ts.Type, location: ts.Node): string {
  return normalizeSignatureText(checker.typeToString(type, location, TYPE_FORMAT_FLAGS));
}

function typeAliasString(checker: ts.TypeChecker, type: ts.Type, location: ts.Node): string {
  return normalizeSignatureText(
    checker.typeToString(type, location, TYPE_FORMAT_FLAGS | ts.TypeFormatFlags.InTypeAlias),
  );
}

function normalizeSignatureText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function buildEntrypointSection(subpath: string, lines: string[]): string {
  const sortedLines = Array.from(new Set(lines)).toSorted((left, right) => {
    const nameLeft = symbolName(left);
    const nameRight = symbolName(right);
    if (nameLeft !== nameRight) return nameLeft < nameRight ? -1 : 1;
    return left < right ? -1 : left > right ? 1 : 0;
  });

  return [`# Entrypoint: ${subpath}`, ...sortedLines].join('\n');
}

function buildMultiEntrypointSnapshot(sections: readonly string[]): string {
  return `${HEADER}\n\n${sections.join('\n\n')}\n`;
}

function symbolName(line: string): string {
  const firstSpace = line.indexOf(' ');
  if (firstSpace < 0) return line;
  const rest = line.slice(firstSpace + 1).trimStart();
  const delimiterIndexes = [' ', '<', '(', '{', ':', '=']
    .map((delimiter) => rest.indexOf(delimiter))
    .filter((index) => index >= 0);
  if (delimiterIndexes.length === 0) return rest;
  return rest.slice(0, Math.min(...delimiterIndexes));
}

function diffLines(expected: string, actual: string): string {
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const lineCount = Math.max(expectedLines.length, actualLines.length);
  const diff: string[] = ['--- documentation/public-api.snapshot.txt', '+++ generated snapshot'];

  for (let index = 0; index < lineCount; index += 1) {
    const expectedLine = expectedLines[index];
    const actualLine = actualLines[index];
    if (expectedLine === actualLine) continue;
    if (expectedLine !== undefined) diff.push(`-${expectedLine}`);
    if (actualLine !== undefined) diff.push(`+${actualLine}`);
  }

  return diff.join('\n');
}

function parseMode(arguments_: string[]): CommandMode {
  const firstArgument = arguments_[0];
  if (!firstArgument || firstArgument === '--check') return 'check';
  if (firstArgument === '--update') return 'update';
  console.error('Usage: bun run scripts/snapshot-public-api.ts [--check|--update]');
  process.exit(1);
}

function isString(value: string | null): value is string {
  return value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function main(): void {
  const entrypoints = readPackageExports();
  const missingEntrypoint = entrypoints.find((entrypoint) => !existsSync(entrypoint.dtsPath));
  if (missingEntrypoint) {
    console.error(
      `Error: ${missingEntrypoint.dtsPath} not found for ${missingEntrypoint.subpath}. Run \`bun run build\` first.`,
    );
    process.exit(1);
  }

  const mode = parseMode(process.argv.slice(2));
  const sections = entrypoints.map(({ subpath, dtsPath }) => {
    const { program, checker, sourceFile } = buildProgram(dtsPath);
    return buildEntrypointSection(subpath, extractExportLines(program, checker, sourceFile));
  });
  const snapshot = buildMultiEntrypointSnapshot(sections);

  if (mode === 'update') {
    writeFileSync(SNAPSHOT_PATH, snapshot);
    console.log('Snapshot updated.');
    return;
  }

  const expected = existsSync(SNAPSHOT_PATH) ? readFileSync(SNAPSHOT_PATH, 'utf8') : '';
  if (expected !== snapshot) {
    console.error(diffLines(expected, snapshot));
    process.exit(1);
  }

  console.log('API surface unchanged.');
}

main();
