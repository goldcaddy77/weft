/** Format a token count for display (e.g., "1.5M", "500K", "999"). */
export function formatTokenCount(count: number | undefined | null): string | null {
  if (count === undefined || count === null) return null;

  if (count >= 1_000_000) {
    const value = count / 1_000_000;
    return value % 1 === 0 ? `${value}M` : `${value.toFixed(1)}M`;
  }

  if (count >= 1_000) {
    const value = count / 1_000;
    return value % 1 === 0 ? `${value}K` : `${value.toFixed(1)}K`;
  }

  return String(count);
}

/** Format a USD cost for display (e.g., "$0.03", "$1.50"). */
export function formatCost(cost: number | undefined | null): string {
  if (cost === undefined || cost === null) return '-';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}
