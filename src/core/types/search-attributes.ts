// ---------------------------------------------------------------------------
// Search attributes
// ---------------------------------------------------------------------------

/**
 * Union of scalar types accepted as search attribute values. Pass when calling
 * `engine.setAttributes` or in {@link StartOptions.searchAttributes}. The
 * engine indexes values of these types so callers can filter via
 * `engine.list({ attributes: [...] })`.
 *
 * @example
 * ```ts
 * import { Engine, type SearchAttributeValue } from 'weft';
 *
 * const engine = new Engine();
 * engine.register('order', async function* () { return 'shipped'; });
 * const handle = await engine.start('order', null, {
 *   searchAttributes: { region: 'us-east' as SearchAttributeValue },
 * });
 * void handle;
 * ```
 */
export type SearchAttributeValue = string | number | boolean | Date | string[];

export type JsonSchemaPrimitiveType =
  | 'array'
  | 'boolean'
  | 'integer'
  | 'number'
  | 'object'
  | 'string';

/**
 * JSON Schema fragment accepted by the search attribute registry. The engine
 * supports the scalar and string-array shapes it can index today while keeping
 * definitions compatible with future schema tooling.
 *
 * @example
 * ```ts
 * import type { SearchAttributeDefinition } from 'weft';
 *
 * const createdAt: SearchAttributeDefinition = { type: 'string', format: 'date-time' };
 * const tags: SearchAttributeDefinition = {
 *   type: 'array',
 *   items: { type: 'string' },
 * };
 * void createdAt;
 * void tags;
 * ```
 */
export interface SearchAttributeDefinition {
  type: JsonSchemaPrimitiveType;
  format?: string;
  items?: SearchAttributeDefinition;
  properties?: Record<string, SearchAttributeDefinition>;
  required?: string[];
}

/**
 * Named search attribute handle returned by {@link searchAttribute}. The
 * runtime value carries `name` and a JSON Schema fragment.
 *
 * @example
 * ```ts
 * const customerId = searchAttribute('customerId', 'string');
 * ctx.setAttribute(customerId, 'cust_123');
 * ```
 */
export interface SearchAttributeHandle<
  TValue extends SearchAttributeValue = SearchAttributeValue,
> extends SearchAttributeDefinition {
  name: string;
  readonly _value?: () => TValue;
}

/**
 * Registry of named search attribute definitions for a workflow type. Each key
 * is an attribute name; each value is a `SearchAttributeDefinition` describing
 * the expected type. Pass via {@link WorkflowRegistration.searchAttributes} so
 * the engine validates and indexes attributes at runtime.
 *
 * @example
 * ```ts
 * import { Engine, type SearchAttributeSchema } from 'weft';
 *
 * const schema: SearchAttributeSchema = {
 *   customerId: { type: 'string' },
 *   orderValue:  { type: 'number' },
 *   isPriority:  { type: 'boolean' },
 * };
 * const engine = new Engine();
 * engine.register('order', { handler: async function* () { return 'ok'; }, searchAttributes: schema });
 * void engine;
 * ```
 */
export type SearchAttributeSchema = Record<string, SearchAttributeDefinition>;

/**
 * Create a named search attribute definition.
 *
 * @example
 * ```ts
 * const createdAt = searchAttribute('createdAt', { type: 'string', format: 'date-time' });
 * ```
 */
export function searchAttribute<TValue extends SearchAttributeValue = SearchAttributeValue>(
  name: string,
  type: JsonSchemaPrimitiveType | SearchAttributeDefinition,
): SearchAttributeHandle<TValue> {
  const definition = typeof type === 'string' ? { type } : type;
  return { name, ...definition } as SearchAttributeHandle<TValue>;
}

export function searchAttributeName(attribute: string | { readonly name: string }): string {
  return typeof attribute === 'string' ? attribute : attribute.name;
}
