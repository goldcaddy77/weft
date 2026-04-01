/**
 * Convert human-readable size strings (e.g. '8 GB', '500 MB') to bytes.
 *
 * @module alerting/parse-size
 */

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
};

/** Parse a human-readable size string to bytes. */
export function parseSize(size: string): number {
  const match = size.trim().match(/^([\d.]+)\s*(b|kb|mb|gb|tb)$/i);
  if (!match || !match[1] || !match[2]) throw new Error(`Invalid size string: "${size}"`);
  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = SIZE_UNITS[unit];
  if (multiplier === undefined) throw new Error(`Invalid size string: "${size}"`);
  return Math.floor(value * multiplier);
}
