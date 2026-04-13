import { normalizeStorageTimestamp } from './scheduler.ts';

type CronField = {
  values: number[];
  wildcard: boolean;
};

type ParsedCronExpression = {
  expression: string;
  hasSeconds: boolean;
  seconds: CronField;
  minutes: CronField;
  hours: CronField;
  daysOfMonth: CronField;
  months: CronField;
  daysOfWeek: CronField;
};

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dayOfWeek: number;
};

type LocalDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export type CronOccurrenceOptions = {
  timeZone?: string;
  maxOccurrences?: number;
};

const MONTH_NAMES = new Map([
  ['JAN', 1],
  ['FEB', 2],
  ['MAR', 3],
  ['APR', 4],
  ['MAY', 5],
  ['JUN', 6],
  ['JUL', 7],
  ['AUG', 8],
  ['SEP', 9],
  ['OCT', 10],
  ['NOV', 11],
  ['DEC', 12],
]);

const DAY_NAMES = new Map([
  ['SUN', 0],
  ['MON', 1],
  ['TUE', 2],
  ['WED', 3],
  ['THU', 4],
  ['FRI', 5],
  ['SAT', 6],
]);

const WEEKDAY_FROM_PART = new Map([
  ['Sun', 0],
  ['Mon', 1],
  ['Tue', 2],
  ['Wed', 3],
  ['Thu', 4],
  ['Fri', 5],
  ['Sat', 6],
]);

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getDefaultTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) {
    return cached;
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'iso8601',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
    timeZoneName: 'shortOffset',
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

function parseNamedValue(
  token: string,
  names: Map<string, number> | undefined,
  minimum: number,
  maximum: number,
): number {
  const upperToken = token.toUpperCase();
  if (names?.has(upperToken)) {
    return names.get(upperToken)!;
  }

  const numericValue = Number.parseInt(token, 10);
  if (!Number.isInteger(numericValue)) {
    throw new Error(`Invalid cron token "${token}"`);
  }

  const normalizedValue = maximum === 6 && numericValue === 7 ? 0 : numericValue;
  if (normalizedValue < minimum || normalizedValue > maximum) {
    throw new Error(`Cron token "${token}" is outside the allowed range ${minimum}-${maximum}`);
  }

  return normalizedValue;
}

function parseCronField(
  field: string,
  minimum: number,
  maximum: number,
  names?: Map<string, number>,
): CronField {
  const trimmedField = field.trim();
  if (trimmedField === '*' || trimmedField === '?') {
    return {
      values: Array.from({ length: maximum - minimum + 1 }, (_, index) => minimum + index),
      wildcard: true,
    };
  }

  const values = new Set<number>();
  const segments = trimmedField.split(',');

  for (const rawSegment of segments) {
    const segment = rawSegment.trim();
    if (segment.length === 0) {
      throw new Error(`Invalid cron field "${field}"`);
    }

    const [rangePart, stepPart] = segment.split('/');
    if (rangePart === undefined) {
      throw new Error(`Invalid cron segment "${segment}"`);
    }
    const step = stepPart === undefined ? 1 : Number.parseInt(stepPart, 10);
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`Invalid cron step "${segment}"`);
    }

    if (rangePart === '*' || rangePart === '?') {
      for (let value = minimum; value <= maximum; value += step) {
        values.add(value);
      }
      continue;
    }

    const [startToken, endToken] = rangePart.split('-');
    const start = parseNamedValue(startToken!, names, minimum, maximum);
    const end = endToken === undefined ? start : parseNamedValue(endToken, names, minimum, maximum);

    if (start > end) {
      throw new Error(`Invalid cron range "${segment}"`);
    }

    for (let value = start; value <= end; value += step) {
      values.add(maximum === 6 && value === 7 ? 0 : value);
    }
  }

  return {
    values: [...values].toSorted((left, right) => left - right),
    wildcard: false,
  };
}

export function parseCronExpression(expression: string): ParsedCronExpression {
  const fields = expression
    .trim()
    .split(/\s+/)
    .filter((field) => field.length > 0);

  if (fields.length !== 5 && fields.length !== 6) {
    throw new Error('Cron expression must have 5 fields or 6 fields with seconds');
  }

  const hasSeconds = fields.length === 6;
  const [secondField, minuteField, hourField, dayField, monthField, weekdayField] = hasSeconds
    ? fields
    : ['0', ...fields];

  return {
    expression,
    hasSeconds,
    seconds: parseCronField(secondField!, 0, 59),
    minutes: parseCronField(minuteField!, 0, 59),
    hours: parseCronField(hourField!, 0, 23),
    daysOfMonth: parseCronField(dayField!, 1, 31),
    months: parseCronField(monthField!, 1, 12, MONTH_NAMES),
    daysOfWeek: parseCronField(weekdayField!, 0, 6, DAY_NAMES),
  };
}

function getOffsetMilliseconds(timestamp: number, timeZone: string): number {
  const parts = getFormatter(timeZone).formatToParts(new Date(timestamp));
  const offsetPart = parts.find((part) => part.type === 'timeZoneName')?.value;
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(offsetPart ?? '');
  if (!match) {
    return 0;
  }

  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number.parseInt(match[2]!, 10);
  const minutes = Number.parseInt(match[3] ?? '0', 10);
  return sign * (hours * 60 + minutes) * 60_000;
}

function getZonedParts(timestamp: number, timeZone: string): ZonedParts {
  const formattedParts = getFormatter(timeZone).formatToParts(new Date(timestamp));
  const record = new Map(formattedParts.map((part) => [part.type, part.value]));
  const weekdayValue = record.get('weekday');
  const dayOfWeek = weekdayValue ? WEEKDAY_FROM_PART.get(weekdayValue) : undefined;

  if (dayOfWeek === undefined) {
    throw new Error(`Unable to resolve weekday for time zone "${timeZone}"`);
  }

  return {
    year: Number.parseInt(record.get('year') ?? '', 10),
    month: Number.parseInt(record.get('month') ?? '', 10),
    day: Number.parseInt(record.get('day') ?? '', 10),
    hour: Number.parseInt(record.get('hour') ?? '', 10),
    minute: Number.parseInt(record.get('minute') ?? '', 10),
    second: Number.parseInt(record.get('second') ?? '', 10),
    dayOfWeek,
  };
}

function sameLocalDateTime(left: LocalDateTime, right: ZonedParts): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second
  );
}

function localDateTimeToTimestamp(
  localDateTime: LocalDateTime,
  timeZone: string,
  minimumTimestamp: number,
): number | null {
  const naiveTimestamp = Date.UTC(
    localDateTime.year,
    localDateTime.month - 1,
    localDateTime.day,
    localDateTime.hour,
    localDateTime.minute,
    localDateTime.second,
  );

  let candidate = naiveTimestamp;
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const offsetMilliseconds = getOffsetMilliseconds(candidate, timeZone);
    const adjustedCandidate = naiveTimestamp - offsetMilliseconds;
    if (adjustedCandidate === candidate) {
      break;
    }
    candidate = adjustedCandidate;
  }

  const candidates = new Set<number>();
  for (let offsetMinutes = -120; offsetMinutes <= 120; offsetMinutes += 15) {
    candidates.add(candidate + offsetMinutes * 60_000);
  }

  const matches = [...candidates]
    .filter((timestamp) => timestamp >= minimumTimestamp)
    .filter((timestamp) => sameLocalDateTime(localDateTime, getZonedParts(timestamp, timeZone)))
    .toSorted((left, right) => left - right);

  return matches[0] ?? null;
}

function shiftLocalDateTime(
  localDateTime: LocalDateTime,
  adjustment: Partial<Record<'days' | 'hours' | 'minutes' | 'seconds', number>>,
): LocalDateTime {
  const date = new Date(
    Date.UTC(
      localDateTime.year,
      localDateTime.month - 1,
      localDateTime.day,
      localDateTime.hour,
      localDateTime.minute,
      localDateTime.second,
    ),
  );

  if (adjustment.days !== undefined) {
    date.setUTCDate(date.getUTCDate() + adjustment.days);
  }
  if (adjustment.hours !== undefined) {
    date.setUTCHours(date.getUTCHours() + adjustment.hours);
  }
  if (adjustment.minutes !== undefined) {
    date.setUTCMinutes(date.getUTCMinutes() + adjustment.minutes);
  }
  if (adjustment.seconds !== undefined) {
    date.setUTCSeconds(date.getUTCSeconds() + adjustment.seconds);
  }

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  };
}

function selectNextValue(
  values: number[],
  currentValue: number,
): { value: number; wrapped: boolean } {
  for (const value of values) {
    if (value > currentValue) {
      return { value, wrapped: false };
    }
  }

  return { value: values[0]!, wrapped: true };
}

function matchesDay(parts: ZonedParts, expression: ParsedCronExpression): boolean {
  const matchesDayOfMonth = expression.daysOfMonth.values.includes(parts.day);
  const matchesDayOfWeek = expression.daysOfWeek.values.includes(parts.dayOfWeek);

  if (expression.daysOfMonth.wildcard && expression.daysOfWeek.wildcard) {
    return true;
  }
  if (expression.daysOfMonth.wildcard) {
    return matchesDayOfWeek;
  }
  if (expression.daysOfWeek.wildcard) {
    return matchesDayOfMonth;
  }

  return matchesDayOfMonth || matchesDayOfWeek;
}

function candidateFromParts(
  parts: LocalDateTime,
  timeZone: string,
  minimumTimestamp: number,
): number | null {
  return localDateTimeToTimestamp(parts, timeZone, minimumTimestamp);
}

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
      const monthCandidate = candidateFromParts(
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
      const nextDayCandidate = candidateFromParts(
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
      const hourCandidate = candidateFromParts(
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

      const nextDayCandidate = candidateFromParts(
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
      const minuteCandidate = candidateFromParts(
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

      const nextHourBoundary = candidateFromParts(
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
      const secondCandidate = candidateFromParts(
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

      const nextMinuteBoundary = candidateFromParts(
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
