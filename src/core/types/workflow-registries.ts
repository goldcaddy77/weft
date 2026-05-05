/**
 * Module-augmentation target for typed workflow names. Add entries with
 * `input` and `output` fields to make `engine.register`, `engine.start`, and
 * `WorkflowHandle.result()` type-safe for string workflow names.
 *
 * @example
 * ```ts
 * import type { WorkflowRegistry } from 'weft';
 *
 * interface WelcomeInput {
 *   name: string;
 * }
 *
 * interface WelcomeOutput {
 *   greeting: string;
 * }
 *
 * declare module 'weft' {
 *   interface WorkflowRegistry {
 *     welcome: { input: WelcomeInput; output: WelcomeOutput };
 *   }
 * }
 *
 * const welcomeInput: WorkflowRegistry['welcome']['input'] = { name: 'Ada' };
 * void welcomeInput;
 * ```
 */
export interface WorkflowRegistry {}

/**
 * Module-augmentation target for typed activity names. This intentionally uses
 * `ActivityTypes` instead of `ActivityRegistry` so it does not collide with
 * the public runtime {@link ActivityRegistry} class.
 *
 * @example
 * ```ts
 * import type { ActivityTypes } from 'weft';
 *
 * interface FormatGreetingInput {
 *   name: string;
 * }
 *
 * declare module 'weft' {
 *   interface ActivityTypes {
 *     formatGreeting: (input: FormatGreetingInput) => Promise<string>;
 *   }
 * }
 *
 * const formatGreeting: ActivityTypes['formatGreeting'] = async (input) =>
 *   `Hello, ${input.name}`;
 * void formatGreeting;
 * ```
 */
export interface ActivityTypes {}

export type WorkflowRegistryEntry = { input: unknown; output: unknown };

export type WorkflowInput<
  TRegistry extends object,
  TName extends string,
> = TName extends keyof TRegistry
  ? TRegistry[TName] extends { input: infer TInput }
    ? TInput
    : unknown
  : unknown;

export type WorkflowOutput<
  TRegistry extends object,
  TName extends string,
> = TName extends keyof TRegistry
  ? TRegistry[TName] extends { output: infer TOutput }
    ? TOutput
    : unknown
  : unknown;

export type ActivityArguments<
  TActivities extends object,
  TName extends string,
> = TName extends keyof TActivities
  ? TActivities[TName] extends (...arguments_: infer TArguments) => unknown
    ? TArguments
    : unknown[]
  : unknown[];

export type ActivityResult<
  TActivities extends object,
  TName extends string,
> = TName extends keyof TActivities
  ? TActivities[TName] extends (...arguments_: infer _TArguments) => infer TResult
    ? Awaited<TResult>
    : unknown
  : unknown;

export type RegisteredActivityFunction<
  TActivities extends object,
  TName extends string,
> = TName extends keyof TActivities
  ? TActivities[TName] extends (...arguments_: infer TArguments) => infer TResult
    ? (...arguments_: TArguments) => TResult
    : never
  : never;

export type UnregisteredName<TName extends string, TKnownNames extends string> = TName &
  (TName extends TKnownNames ? never : unknown);
