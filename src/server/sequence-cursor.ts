export interface ParsedSequenceCursor {
  error?: string;
  value?: number;
}

export function parseOptionalSequenceCursor(
  rawValue: string | null | undefined,
  parameterName: string,
): ParsedSequenceCursor {
  if (rawValue === null || rawValue === undefined) {
    return {};
  }

  if (rawValue.trim().length === 0) {
    return {
      error: `Invalid ${parameterName}: ${rawValue}`,
    };
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < -1) {
    return {
      error: `Invalid ${parameterName}: ${rawValue}`,
    };
  }

  return { value };
}
