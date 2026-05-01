import { normalizeStorageTimestamp } from '../scheduler.ts';
import {
  getDefaultTimeZone,
  getZonedParts,
  localDateTimeToTimestamp,
  matchesDay,
  selectNextValue,
  shiftLocalDateTime,
} from './cron-formatter.ts';
import { parseCronExpression } from './cron-parser.ts';
import type { CronOccurrenceOptions, ParsedCronExpression } from './cron-types.ts';

// oxlint-disable-next-line complexity -- ID:core-schedule-get-next-cron-occurrence-complexity
export function getNextCronOccurrence(
  expression: string | ParsedCronExpression,
  afterTimestamp: number,
  options?: CronOccurrenceOptions,
): number {
  const parsedExpression =
    typeof expression === 'string' ? parseCronExpression(expression) : expression;
  const timeZone = options?.timeZone ?? getDefaultTimeZone();
  let candidate = normalizeStorageTimestamp(
    Math.floor(afterTimestamp / 1000) * 1000 + 1000,
    'Cron occurrence candidate',
  );

  for (let iteration = 0; iteration < 100_000; iteration += 1) {
    const parts = getZonedParts(candidate, timeZone);

    if (!parsedExpression.months.values.includes(parts.month)) {
      const nextMonth = selectNextValue(parsedExpression.months.values, parts.month);
      const monthCandidate = localDateTimeToTimestamp(
        {
          year: parts.year + (nextMonth.wrapped ? 1 : 0),
          month: nextMonth.value,
          day: 1,
          hour: 0,
          minute: 0,
          second: 0,
        },
        timeZone,
        candidate + 1000,
      );
      candidate = monthCandidate ?? candidate + 86_400_000;
      continue;
    }

    if (!matchesDay(parts, parsedExpression)) {
      const nextDayCandidate = localDateTimeToTimestamp(
        shiftLocalDateTime(
          {
            year: parts.year,
            month: parts.month,
            day: parts.day,
            hour: 0,
            minute: 0,
            second: 0,
          },
          { days: 1 },
        ),
        timeZone,
        candidate + 1000,
      );
      candidate = nextDayCandidate ?? candidate + 86_400_000;
      continue;
    }

    if (!parsedExpression.hours.values.includes(parts.hour)) {
      const nextHour = selectNextValue(parsedExpression.hours.values, parts.hour);
      const hourCandidate = localDateTimeToTimestamp(
        {
          year: parts.year,
          month: parts.month,
          day: parts.day,
          hour: nextHour.value,
          minute: 0,
          second: 0,
        },
        timeZone,
        candidate + 1000,
      );
      if (hourCandidate !== null) {
        candidate = hourCandidate;
        continue;
      }

      const nextDayCandidate = localDateTimeToTimestamp(
        shiftLocalDateTime(
          {
            year: parts.year,
            month: parts.month,
            day: parts.day,
            hour: 0,
            minute: 0,
            second: 0,
          },
          { days: 1 },
        ),
        timeZone,
        candidate + 1000,
      );
      candidate = nextDayCandidate ?? candidate + 86_400_000;
      continue;
    }

    if (!parsedExpression.minutes.values.includes(parts.minute)) {
      const nextMinute = selectNextValue(parsedExpression.minutes.values, parts.minute);
      const minuteCandidate = localDateTimeToTimestamp(
        {
          year: parts.year,
          month: parts.month,
          day: parts.day,
          hour: parts.hour,
          minute: nextMinute.value,
          second: 0,
        },
        timeZone,
        candidate + 1000,
      );
      if (minuteCandidate !== null) {
        candidate = minuteCandidate;
        continue;
      }

      const nextHourBoundary = localDateTimeToTimestamp(
        shiftLocalDateTime(
          {
            year: parts.year,
            month: parts.month,
            day: parts.day,
            hour: parts.hour,
            minute: 0,
            second: 0,
          },
          { hours: 1 },
        ),
        timeZone,
        candidate + 1000,
      );
      candidate = nextHourBoundary ?? candidate + 3_600_000;
      continue;
    }

    if (!parsedExpression.seconds.values.includes(parts.second)) {
      const nextSecond = selectNextValue(parsedExpression.seconds.values, parts.second);
      const secondCandidate = localDateTimeToTimestamp(
        {
          year: parts.year,
          month: parts.month,
          day: parts.day,
          hour: parts.hour,
          minute: parts.minute,
          second: nextSecond.value,
        },
        timeZone,
        candidate + 1000,
      );
      if (secondCandidate !== null) {
        candidate = secondCandidate;
        continue;
      }

      const nextMinuteBoundary = localDateTimeToTimestamp(
        shiftLocalDateTime(
          {
            year: parts.year,
            month: parts.month,
            day: parts.day,
            hour: parts.hour,
            minute: parts.minute,
            second: 0,
          },
          { minutes: 1 },
        ),
        timeZone,
        candidate + 1000,
      );
      candidate = nextMinuteBoundary ?? candidate + 60_000;
      continue;
    }

    return candidate;
  }

  throw new Error(`Could not find the next cron occurrence for "${parsedExpression.expression}"`);
}

export function collectDueCronOccurrences(
  expression: string | ParsedCronExpression,
  firstDueAt: number,
  throughTimestamp: number,
  options?: CronOccurrenceOptions,
): number[] {
  const parsedExpression =
    typeof expression === 'string' ? parseCronExpression(expression) : expression;
  const dueOccurrences: number[] = [];
  const requestedMaxOccurrences = options?.maxOccurrences;
  if (
    requestedMaxOccurrences !== undefined &&
    (!Number.isSafeInteger(requestedMaxOccurrences) || requestedMaxOccurrences <= 0)
  ) {
    throw new Error('Cron occurrence maxOccurrences must be a positive safe integer');
  }
  const maximumOccurrences = requestedMaxOccurrences ?? Number.POSITIVE_INFINITY;
  let nextOccurrence = firstDueAt;

  while (nextOccurrence <= throughTimestamp && dueOccurrences.length < maximumOccurrences) {
    dueOccurrences.push(nextOccurrence);
    nextOccurrence = getNextCronOccurrence(parsedExpression, nextOccurrence, options);
  }

  return dueOccurrences;
}
