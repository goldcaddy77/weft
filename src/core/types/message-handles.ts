// ---------------------------------------------------------------------------
// Message-shaped workflow handles
// ---------------------------------------------------------------------------

/**
 * Typed handle for a workflow signal. The runtime value is only `{ name }`;
 * the generic parameter exists to carry the payload type through call sites.
 *
 * @example
 * ```ts
 * import { signal } from 'weft';
 *
 * const approval = signal<{ approved: boolean }>('approval');
 * await handle.signal(approval, { approved: true });
 * ```
 */
export interface SignalDefinition<TInput = void> {
  readonly name: string;
  readonly _input?: (input: TInput) => void;
}

/**
 * Typed handle for a workflow update. Updates accept an input payload and
 * return a response to the caller.
 *
 * @example
 * ```ts
 * import { update } from 'weft';
 *
 * const approveOrder = update<{ orderId: string }, { status: string }>('approveOrder');
 * const result = await handle.update(approveOrder, { orderId: 'ord_123' });
 * console.log(result.status);
 * ```
 */
export interface UpdateDefinition<TInput = void, TOutput = unknown> {
  readonly name: string;
  readonly _input?: (input: TInput) => void;
  readonly _output?: () => TOutput;
}

/**
 * Typed handle for a workflow query. Queries are read-only accessors and may
 * optionally accept an input payload.
 *
 * @example
 * ```ts
 * import { query } from 'weft';
 *
 * const orderStatus = query<{ orderId: string }, { state: string }>('orderStatus');
 * const status = await handle.query(orderStatus, { orderId: 'ord_123' });
 * console.log(status.state);
 * ```
 */
export interface QueryDefinition<TInput = void, TOutput = unknown> {
  readonly name: string;
  readonly _input?: (input: TInput) => void;
  readonly _output?: () => TOutput;
}

export type MessageDefinition =
  | QueryDefinition<unknown>
  | SignalDefinition<unknown>
  | UpdateDefinition<unknown>;

export type MessageName = string | { readonly name: string };

/**
 * Create a typed workflow signal handle.
 *
 * @example
 * ```ts
 * const approval = signal<{ approved: boolean }>('approval');
 * ```
 */
export function signal<TInput = void>(name: string): SignalDefinition<TInput> {
  return { name } as SignalDefinition<TInput>;
}

/**
 * Create a typed workflow update handle.
 *
 * @example
 * ```ts
 * const approve = update<{ id: string }, { accepted: boolean }>('approve');
 * ```
 */
export function update<TInput = void, TOutput = unknown>(
  name: string,
): UpdateDefinition<TInput, TOutput> {
  return { name } as UpdateDefinition<TInput, TOutput>;
}

/**
 * Create a typed workflow query handle.
 *
 * @example
 * ```ts
 * const status = query<void, { state: string }>('status');
 * ```
 */
export function query<TInput = void, TOutput = unknown>(
  name: string,
): QueryDefinition<TInput, TOutput> {
  return { name } as QueryDefinition<TInput, TOutput>;
}

export function messageName(definition: MessageName): string {
  return typeof definition === 'string' ? definition : definition.name;
}
