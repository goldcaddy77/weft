import type { StartOptions } from '../core/types.ts';

export function setIfDefined(body: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) body[key] = value;
}

export function buildStartBody(
  type: string,
  input: unknown,
  options?: StartOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = { type, input };
  setIfDefined(body, 'id', options?.id);
  setIfDefined(body, 'executionTimeout', options?.executionTimeout);
  setIfDefined(body, 'startAt', options?.startAt);
  setIfDefined(body, 'startAfter', options?.startAfter);
  setIfDefined(body, 'tags', options?.tags);
  return body;
}
