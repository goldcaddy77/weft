/**
 * Shared `DiscoveryInfo` type and helper for applying it to API discovery documents.
 *
 * @module server/discovery-info
 */

/** Operator-supplied metadata applied uniformly to all three discovery documents. */
export type DiscoveryInfo = {
  description?: string;
  contact?: { name?: string; url?: string; email?: string };
  license?: { name: string; url?: string };
  externalDocs?: { description?: string; url: string };
};

/**
 * Merge `DiscoveryInfo` fields into a document's `info` object (or top-level
 * for AsyncAPI 3.0 `externalDocs`).
 *
 * Returns a shallow copy of `target` with the discovery info fields applied.
 * Fields absent from `info` are omitted from the output.
 */
export function applyDiscoveryInfo(
  target: Record<string, unknown>,
  info: DiscoveryInfo | undefined,
): Record<string, unknown> {
  if (info === undefined) return target;
  const result = { ...target };
  if (info.description !== undefined) result['description'] = info.description;
  if (info.contact !== undefined) result['contact'] = { ...info.contact };
  if (info.license !== undefined) result['license'] = { ...info.license };
  // externalDocs is applied at the call site (document top-level for AsyncAPI,
  // inside info for OpenAPI/OpenRPC)
  return result;
}
