/**
 * Deterministic JSON-Schema → TypeScript emitter for `weft codegen`.
 *
 * Consumes a {@link RegistrySnapshot} (the same shape served by
 * `GET /v1/registry`) and produces a single `.d.ts` string that
 * augments the public `'weft'` module with typed `WorkflowRegistry`
 * and `ActivityTypes` entries. The output is byte-stable across runs
 * with the same input: keys are sorted with explicit codepoint
 * comparators, property names are uniformly double-quoted via
 * `JSON.stringify`, and there are no timestamps or environment-
 * dependent paths.
 *
 * The JSON Schema subset supported here covers what
 * `definitionSchemaToJsonSchema` actually produces today (Zod via
 * `z.toJSONSchema` and Valibot via `@valibot/to-json-schema`).
 * Anything outside that subset degrades to `unknown` so the emitter
 * never claims a type it cannot justify.
 *
 * @module cli/codegen-emit
 */

import type {
  RegistryActivityEntry,
  RegistrySnapshot,
  RegistryWorkflowEntry,
} from '../core/registry-snapshot.ts';

/** Compare strings by codepoint order; no locale-sensitivity. */
function codepointCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Emit a TypeScript property key as a double-quoted string literal. */
export function emitPropertyKey(name: string): string {
  return JSON.stringify(name);
}

function primitiveTypeFor(typeKeyword: string): string | undefined {
  switch (typeKeyword) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    default:
      return undefined;
  }
}

function tryCombinator(node: Record<string, unknown>): string | undefined {
  if (Array.isArray(node['oneOf'])) return parenUnion(node['oneOf']);
  if (Array.isArray(node['anyOf'])) return parenUnion(node['anyOf']);
  if (Array.isArray(node['allOf'])) return parenIntersection(node['allOf']);
  return undefined;
}

function tryEnumOrConst(node: Record<string, unknown>): string | undefined {
  if ('const' in node) return literalFromValue(node['const']);
  if (Array.isArray(node['enum'])) {
    const literals = node['enum'].map(literalFromValue);
    if (literals.some((literal) => literal === 'unknown')) return 'unknown';
    return `(${literals.join(' | ')})`;
  }
  return undefined;
}

function dispatchByType(node: Record<string, unknown>): string | undefined {
  const typeKeyword = node['type'];

  if (Array.isArray(typeKeyword)) {
    // `type: ['string', 'null']` flattens to a union of the per-type
    // results so callers get `(string | null)` rather than `unknown`.
    const branches = typeKeyword.map((branchType) =>
      jsonSchemaToTypeScript({ ...node, type: branchType }),
    );
    return `(${branches.join(' | ')})`;
  }

  if (typeof typeKeyword === 'string') {
    const primitive = primitiveTypeFor(typeKeyword);
    if (primitive !== undefined) return primitive;
    if (typeKeyword === 'array') return arrayTypeScript(node);
    if (typeKeyword === 'object') return objectTypeScript(node);
  }

  return undefined;
}

function dispatchByShape(node: Record<string, unknown>): string | undefined {
  // `properties` or `additionalProperties` without an explicit
  // `type: 'object'` is still object-shaped (some converters omit
  // `type`). Same for `items`/`prefixItems` → array.
  if ('properties' in node || 'additionalProperties' in node) return objectTypeScript(node);
  if ('items' in node || 'prefixItems' in node) return arrayTypeScript(node);
  return undefined;
}

function normalizeSchema(schema: unknown): Record<string, unknown> | string {
  if (schema === undefined || schema === null) return 'unknown';
  if (schema === true) return 'unknown';
  if (schema === false) return 'never';
  if (typeof schema !== 'object' || Array.isArray(schema)) return 'unknown';
  return schema as Record<string, unknown>;
}

/** Convert a single JSON Schema fragment to a TypeScript type expression. */
export function jsonSchemaToTypeScript(schema: unknown): string {
  const node = normalizeSchema(schema);
  if (typeof node === 'string') return node;
  // Combinators take precedence over `type` because they can apply to
  // any value shape (e.g. `{ allOf: [...] }` with no top-level `type`).
  return (
    tryCombinator(node) ??
    tryEnumOrConst(node) ??
    dispatchByType(node) ??
    dispatchByShape(node) ??
    'unknown'
  );
}

function parenUnion(branches: unknown[]): string {
  if (branches.length === 0) return 'unknown';
  const types = branches.map(jsonSchemaToTypeScript);
  if (types.length === 1) return types[0]!;
  return `(${types.join(' | ')})`;
}

function parenIntersection(branches: unknown[]): string {
  if (branches.length === 0) return 'unknown';
  const types = branches.map(jsonSchemaToTypeScript);
  if (types.length === 1) return types[0]!;
  return `(${types.join(' & ')})`;
}

function literalFromValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return 'unknown';
}

function arrayTypeScript(node: Record<string, unknown>): string {
  const prefixItems = node['prefixItems'];
  const itemsRaw = node['items'];
  const additionalItemsRaw = node['additionalItems'];

  // Draft-2020-12: `prefixItems` carries the tuple positions, and
  // `items` (a single schema or `false`) controls the rest.
  if (Array.isArray(prefixItems)) {
    const positions = prefixItems.map(jsonSchemaToTypeScript);
    if (itemsRaw === false) {
      return `[${positions.join(', ')}]`;
    }
    if (itemsRaw === undefined) {
      // Draft-2020-12 default is open: rest of `unknown`.
      return `[${[...positions, '...unknown[]'].join(', ')}]`;
    }
    const restType = jsonSchemaToTypeScript(itemsRaw);
    return `[${[...positions, `...${restType}[]`].join(', ')}]`;
  }

  // Legacy draft: `items` may be an array of position schemas, in
  // which case `additionalItems` plays the rest-controller role.
  if (Array.isArray(itemsRaw)) {
    const positions = itemsRaw.map(jsonSchemaToTypeScript);
    if (additionalItemsRaw === false) {
      return `[${positions.join(', ')}]`;
    }
    if (additionalItemsRaw === undefined) {
      return `[${[...positions, '...unknown[]'].join(', ')}]`;
    }
    const restType = jsonSchemaToTypeScript(additionalItemsRaw);
    return `[${[...positions, `...${restType}[]`].join(', ')}]`;
  }

  if (itemsRaw === undefined || itemsRaw === true) {
    return 'Array<unknown>';
  }
  if (itemsRaw === false) {
    return '[]';
  }
  return `Array<${jsonSchemaToTypeScript(itemsRaw)}>`;
}

type ObjectRendering = {
  propertyLines: string[];
  namedValueTypes: string[];
  hasOptionalNamedProperty: boolean;
};

function renderObjectProperties(
  properties: Record<string, unknown> | undefined,
  requiredSet: ReadonlySet<string>,
): ObjectRendering {
  const declaredKeys = properties ? Object.keys(properties) : [];
  const missingRequired = [...requiredSet].filter((key) => !declaredKeys.includes(key));
  const allKeys = [...declaredKeys, ...missingRequired].toSorted(codepointCompare);

  const propertyLines: string[] = [];
  const namedValueTypes: string[] = [];
  let hasOptionalNamedProperty = false;

  for (const key of allKeys) {
    const isRequired = requiredSet.has(key);
    const schemaForKey = properties && key in properties ? properties[key] : undefined;
    const valueType = jsonSchemaToTypeScript(schemaForKey);
    namedValueTypes.push(valueType);
    if (!isRequired) hasOptionalNamedProperty = true;
    propertyLines.push(`${emitPropertyKey(key)}${isRequired ? '' : '?'}: ${valueType};`);
  }

  return { propertyLines, namedValueTypes, hasOptionalNamedProperty };
}

function emptyObjectTypeScript(indexSignature: string | undefined): string {
  if (indexSignature === undefined) {
    // `additionalProperties: false` with no named properties.
    return 'Record<string, never>';
  }
  if (indexSignature === 'unknown') {
    return 'Record<string, unknown>';
  }
  return `{ [index: string]: ${indexSignature} }`;
}

function objectTypeScript(node: Record<string, unknown>): string {
  const propertiesRaw = node['properties'];
  const properties =
    propertiesRaw !== null && typeof propertiesRaw === 'object' && !Array.isArray(propertiesRaw)
      ? (propertiesRaw as Record<string, unknown>)
      : undefined;
  const requiredRaw = node['required'];
  const requiredSet = new Set<string>(
    Array.isArray(requiredRaw)
      ? requiredRaw.filter((entry): entry is string => typeof entry === 'string')
      : [],
  );

  const rendering = renderObjectProperties(properties, requiredSet);
  const indexSignature = indexSignatureForObject(
    node['additionalProperties'],
    rendering.namedValueTypes,
    rendering.hasOptionalNamedProperty,
  );

  if (rendering.propertyLines.length === 0) {
    return emptyObjectTypeScript(indexSignature);
  }

  if (indexSignature === undefined) {
    return `{ ${rendering.propertyLines.join(' ')} }`;
  }
  return `{ ${rendering.propertyLines.join(' ')} [index: string]: ${indexSignature}; }`;
}

/**
 * Resolve the index-signature value type for an object schema.
 *
 * - `additionalProperties: false` → closed (return `undefined` so the
 *   caller emits no index signature).
 * - Absent or `true` → open with `unknown` (a supertype of every
 *   named property's value type, so the resulting `.d.ts` always
 *   typechecks under `strict`).
 * - Schema object → typed open. The value type is the union of the
 *   typed schema and every named property's value type, plus
 *   `undefined` when any named property is optional, so TypeScript's
 *   index-signature compatibility rule is satisfied.
 */
function indexSignatureForObject(
  additionalRaw: unknown,
  namedValueTypes: readonly string[],
  hasOptionalNamedProperty: boolean,
): string | undefined {
  if (additionalRaw === false) return undefined;
  if (additionalRaw === undefined || additionalRaw === true) return 'unknown';

  if (
    additionalRaw !== null &&
    typeof additionalRaw === 'object' &&
    !Array.isArray(additionalRaw)
  ) {
    const typedValue = jsonSchemaToTypeScript(additionalRaw);
    const unionMembers = new Set<string>([typedValue, ...namedValueTypes]);
    if (hasOptionalNamedProperty) unionMembers.add('undefined');
    const members = [...unionMembers];
    if (members.length === 1) return members[0]!;
    return members.join(' | ');
  }

  return 'unknown';
}

function sortedWorkflowEntries(
  workflows: Record<string, RegistryWorkflowEntry>,
): Array<[string, RegistryWorkflowEntry]> {
  return Object.entries(workflows).toSorted(([a], [b]) => codepointCompare(a, b));
}

function sortedActivityEntries(
  activities: Record<string, RegistryActivityEntry>,
): Array<[string, RegistryActivityEntry]> {
  return Object.entries(activities).toSorted(([a], [b]) => codepointCompare(a, b));
}

function emitWorkflowEntry(name: string, entry: RegistryWorkflowEntry): string {
  const input = jsonSchemaToTypeScript(entry.inputSchema);
  const output = jsonSchemaToTypeScript(entry.outputSchema);
  return `    ${emitPropertyKey(name)}: { input: ${input}; output: ${output} };`;
}

function emitActivityEntry(name: string, entry: RegistryActivityEntry): string {
  const output = jsonSchemaToTypeScript(entry.outputSchema);
  if (entry.inputSchema === undefined) {
    // No input schema → zero-argument function, matching
    // `ActivityDefinitionFunction<void, ...>` in `workflow-registries.ts`.
    return `    ${emitPropertyKey(name)}: () => Promise<${output}>;`;
  }
  // A schema requiring `null` is a different contract from "no
  // input"; emit `(input: null) => Promise<...>` rather than
  // collapsing to zero args.
  const input = jsonSchemaToTypeScript(entry.inputSchema);
  return `    ${emitPropertyKey(name)}: (input: ${input}) => Promise<${output}>;`;
}

/**
 * Emit the full `.d.ts` declaration string for a registry snapshot.
 *
 * The output is deterministic: keys are sorted by codepoint, property
 * names go through {@link emitPropertyKey}, and unions/intersections
 * are always parenthesized so they compose correctly when nested.
 */
export function emitRegistryDeclaration(snapshot: RegistrySnapshot): string {
  const workflows = sortedWorkflowEntries(snapshot.workflows);
  const activities = sortedActivityEntries(snapshot.activities);

  const workflowLines = workflows.map(([name, entry]) => emitWorkflowEntry(name, entry));
  const activityLines = activities.map(([name, entry]) => emitActivityEntry(name, entry));

  const workflowBlock =
    workflowLines.length === 0
      ? '  interface WorkflowRegistry {}'
      : ['  interface WorkflowRegistry {', ...workflowLines, '  }'].join('\n');
  const activityBlock =
    activityLines.length === 0
      ? '  interface ActivityTypes {}'
      : ['  interface ActivityTypes {', ...activityLines, '  }'].join('\n');

  const lines = [
    '// Generated by `weft codegen`. Do not edit by hand.',
    '/* eslint-disable */',
    '',
    "declare module 'weft' {",
    workflowBlock,
    '',
    activityBlock,
    '}',
    '',
    'export {};',
    '',
  ];

  return lines.join('\n');
}
