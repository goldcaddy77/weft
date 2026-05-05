const BYTE_STRING_CHUNK_SIZE = 0x8000;

/**
 * Encode storage bytes as base64 without relying on Node-only Buffer APIs.
 */
export function encodeBytesToBase64(value: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < value.byteLength; offset += BYTE_STRING_CHUNK_SIZE) {
    const end = Math.min(offset + BYTE_STRING_CHUNK_SIZE, value.byteLength);
    for (const byte of value.subarray(offset, end)) {
      binary += String.fromCharCode(byte);
    }
  }
  return btoa(binary);
}

/**
 * Decode base64 storage bytes without relying on Node-only Buffer APIs.
 */
export function decodeBase64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
