/** Format a duration in milliseconds to a human-readable string (e.g., "45s", "3m 12s", "2h 15m"). */
type DurationUnit = {
  label: string;
  milliseconds: number;
};

const displayDurationUnits: readonly DurationUnit[] = [
  { label: 'h', milliseconds: 60 * 60 * 1_000 },
  { label: 'm', milliseconds: 60 * 1_000 },
  { label: 's', milliseconds: 1_000 },
];

export function formatDuration(milliseconds: number): string;
export function formatDuration(
  start: Date | string | number | null,
  end: Date | string | number | null,
): string;
export function formatDuration(
  startOrMilliseconds: number | Date | string | null,
  end?: Date | string | number | null,
): string {
  const milliseconds = getDurationMilliseconds(startOrMilliseconds, end);

  if (milliseconds < 0) return '-';
  return formatPositiveDuration(milliseconds);
}

function getDurationMilliseconds(
  startOrMilliseconds: number | Date | string | null,
  end: Date | string | number | null | undefined,
): number {
  if (startOrMilliseconds === null || end === null) return -1;
  if (end === undefined) return typeof startOrMilliseconds === 'number' ? startOrMilliseconds : 0;

  return readTimestamp(end) - readTimestamp(startOrMilliseconds);
}

function readTimestamp(value: Date | string | number): number {
  return typeof value === 'number' ? value : new Date(value).getTime();
}

function formatPositiveDuration(milliseconds: number): string {
  for (const [index, unit] of displayDurationUnits.entries()) {
    if (milliseconds >= unit.milliseconds) return formatDurationFromUnit(milliseconds, index);
  }

  return `${milliseconds}ms`;
}

function formatDurationFromUnit(milliseconds: number, unitIndex: number): string {
  const unit = displayDurationUnits[unitIndex];
  if (unit === undefined) return `${milliseconds}ms`;

  const value = Math.floor(milliseconds / unit.milliseconds);
  const nextUnit = displayDurationUnits[unitIndex + 1];
  if (nextUnit === undefined) return `${value}${unit.label}`;

  const remainder = Math.floor((milliseconds % unit.milliseconds) / nextUnit.milliseconds);
  if (remainder === 0) return `${value}${unit.label}`;

  return `${value}${unit.label} ${remainder}${nextUnit.label}`;
}
