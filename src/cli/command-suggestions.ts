export function formatUnknownCommandError(
  command: string,
  knownSubcommands: readonly string[],
): string {
  const suggestion = findNearestSubcommand(command, knownSubcommands);
  return suggestion === undefined
    ? `Unknown command '${command}'`
    : `Unknown command '${command}'. Did you mean '${suggestion}'?`;
}

function findNearestSubcommand(
  command: string,
  knownSubcommands: readonly string[],
): string | undefined {
  let nearest: string | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of knownSubcommands) {
    const distance = editDistance(command, candidate);
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }

  return nearestDistance <= 2 ? nearest : undefined;
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    current[0] = leftIndex;

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex]! + 1,
        current[rightIndex - 1]! + 1,
        previous[rightIndex - 1]! + substitutionCost,
      );
    }

    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length]!;
}
