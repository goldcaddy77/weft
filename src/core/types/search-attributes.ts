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

export interface SearchAttributeDefinition {
  type: 'string' | 'number' | 'boolean' | 'datetime' | 'keyword_list';
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
