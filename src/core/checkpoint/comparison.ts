import type { CheckpointDivergence } from './interfaces.ts';

// oxlint-disable-next-line complexity -- ID:core-checkpoint-compare-values-complexity
export function compareValues(
  original: unknown,
  deserialized: unknown,
  path: string,
  divergences: CheckpointDivergence[],
): void {
  // Same reference or both nullish
  if (original === deserialized) return;

  // Handle null/undefined
  if (
    original === null ||
    original === undefined ||
    deserialized === null ||
    deserialized === undefined
  ) {
    if (original !== deserialized) {
      divergences.push({
        path: path || '(root)',
        original,
        deserialized,
        suggestion: 'Value changed during serialization round-trip.',
      });
    }
    return;
  }

  if (compareDateValues(original, deserialized, path, divergences)) {
    return;
  }

  if (compareRegExpValues(original, deserialized, path, divergences)) {
    return;
  }

  if (compareMapValues(original, deserialized, path, divergences)) {
    return;
  }

  if (compareSetValues(original, deserialized, path, divergences)) {
    return;
  }

  // Type mismatch
  if (typeof original !== typeof deserialized) {
    divergences.push({
      path: path || '(root)',
      original,
      deserialized,
      suggestion: `Type changed from ${typeof original} to ${typeof deserialized} during round-trip.`,
    });
    return;
  }

  // Primitives
  if (typeof original !== 'object') {
    if (original !== deserialized) {
      divergences.push({
        path: path || '(root)',
        original,
        deserialized,
        suggestion: 'Primitive value changed during round-trip.',
      });
    }
    return;
  }

  if (Array.isArray(original) && Array.isArray(deserialized)) {
    compareArrayValues(original, deserialized, path, divergences);
    return;
  }

  compareRecordValues(
    original as Record<string, unknown>,
    deserialized as Record<string, unknown>,
    path,
    divergences,
  );
}

function checkpointPath(path: string): string {
  return path || '(root)';
}

function recordDivergence(
  divergences: CheckpointDivergence[],
  path: string,
  original: unknown,
  deserialized: unknown,
  suggestion: string,
): void {
  divergences.push({
    path: checkpointPath(path),
    original,
    deserialized,
    suggestion,
  });
}

function compareDateValues(
  original: unknown,
  deserialized: unknown,
  path: string,
  divergences: CheckpointDivergence[],
): boolean {
  if (!(original instanceof Date && deserialized instanceof Date)) {
    return false;
  }

  if (original.getTime() !== deserialized.getTime()) {
    recordDivergence(
      divergences,
      path,
      original,
      deserialized,
      'Date value changed during round-trip.',
    );
  }

  return true;
}

function compareRegExpValues(
  original: unknown,
  deserialized: unknown,
  path: string,
  divergences: CheckpointDivergence[],
): boolean {
  if (!(original instanceof RegExp && deserialized instanceof RegExp)) {
    return false;
  }

  if (original.source !== deserialized.source || original.flags !== deserialized.flags) {
    recordDivergence(
      divergences,
      path,
      original,
      deserialized,
      'RegExp value changed during round-trip.',
    );
  }

  return true;
}

function compareMapValues(
  original: unknown,
  deserialized: unknown,
  path: string,
  divergences: CheckpointDivergence[],
): boolean {
  if (!(original instanceof Map && deserialized instanceof Map)) {
    return false;
  }

  for (const [key] of original) {
    const keyPath = path ? `${path}.Map(${String(key)})` : `Map(${String(key)})`;
    if (!deserialized.has(key)) {
      recordDivergence(
        divergences,
        keyPath,
        original.get(key),
        undefined,
        'Map key missing after round-trip.',
      );
      continue;
    }

    compareValues(original.get(key), deserialized.get(key), keyPath, divergences);
  }

  for (const [key] of deserialized) {
    if (original.has(key)) {
      continue;
    }

    const keyPath = path ? `${path}.Map(${String(key)})` : `Map(${String(key)})`;
    recordDivergence(
      divergences,
      keyPath,
      undefined,
      deserialized.get(key),
      'Extra Map key appeared after round-trip.',
    );
  }

  return true;
}

function compareSetValues(
  original: unknown,
  deserialized: unknown,
  path: string,
  divergences: CheckpointDivergence[],
): boolean {
  if (!(original instanceof Set && deserialized instanceof Set)) {
    return false;
  }

  const originalValues = [...original.values()];
  const deserializedValues = [...deserialized.values()];
  if (originalValues.length !== deserializedValues.length) {
    recordDivergence(
      divergences,
      path,
      original,
      deserialized,
      'Set size changed during round-trip.',
    );
    return true;
  }

  for (let index = 0; index < originalValues.length; index++) {
    const elementPath = path ? `${path}.Set[${index}]` : `Set[${index}]`;
    compareValues(originalValues[index], deserializedValues[index], elementPath, divergences);
  }

  return true;
}

function compareArrayValues(
  original: unknown[],
  deserialized: unknown[],
  path: string,
  divergences: CheckpointDivergence[],
): void {
  const maxLength = Math.max(original.length, deserialized.length);
  for (let index = 0; index < maxLength; index++) {
    const elementPath = path ? `${path}[${index}]` : `[${index}]`;
    if (index >= original.length) {
      recordDivergence(
        divergences,
        elementPath,
        undefined,
        deserialized[index],
        'Extra array element appeared after round-trip.',
      );
      continue;
    }

    if (index >= deserialized.length) {
      recordDivergence(
        divergences,
        elementPath,
        original[index],
        undefined,
        'Array element missing after round-trip.',
      );
      continue;
    }

    compareValues(original[index], deserialized[index], elementPath, divergences);
  }
}

function compareRecordValues(
  original: Record<string, unknown>,
  deserialized: Record<string, unknown>,
  path: string,
  divergences: CheckpointDivergence[],
): void {
  const allKeys = new Set([...Object.keys(original), ...Object.keys(deserialized)]);

  for (const key of allKeys) {
    const propertyPath = path ? `${path}.${key}` : key;
    if (!(key in original)) {
      recordDivergence(
        divergences,
        propertyPath,
        undefined,
        deserialized[key],
        'Extra key appeared in deserialized object.',
      );
      continue;
    }

    if (!(key in deserialized)) {
      recordDivergence(
        divergences,
        propertyPath,
        original[key],
        undefined,
        'Key missing from deserialized object.',
      );
      continue;
    }

    compareValues(original[key], deserialized[key], propertyPath, divergences);
  }
}
