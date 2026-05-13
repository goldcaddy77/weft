<script lang="ts" module>
  export interface DateRangePickerProps {
    id: string;
    label: string;
    gte?: number;
    lte?: number;
    oninput?: () => void;
  }
</script>

<script lang="ts">
  let {
    id,
    label,
    gte = $bindable(),
    lte = $bindable(),
    oninput,
  }: DateRangePickerProps = $props();

  const startInputId = $derived(`${id}-gte`);
  const endInputId = $derived(`${id}-lte`);
  const startValue = $derived(formatDateTimeLocalValue(gte));
  const endValue = $derived(formatDateTimeLocalValue(lte));

  function handleStartInput(event: Event): void {
    gte = parseDateTimeLocalValue(event.currentTarget);
    oninput?.();
  }

  function handleEndInput(event: Event): void {
    lte = parseDateTimeLocalValue(event.currentTarget);
    oninput?.();
  }

  function parseDateTimeLocalValue(target: EventTarget | null): number | undefined {
    if (!(target instanceof HTMLInputElement) || target.value.length === 0) {
      return undefined;
    }

    const timestamp = new Date(target.value).getTime();
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }

  function formatDateTimeLocalValue(timestamp: number | undefined): string {
    if (timestamp === undefined) return '';
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return '';

    const year = date.getFullYear();
    const month = padDatePart(date.getMonth() + 1);
    const day = padDatePart(date.getDate());
    const hours = padDatePart(date.getHours());
    const minutes = padDatePart(date.getMinutes());
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  }

  function padDatePart(value: number): string {
    return value.toString().padStart(2, '0');
  }
</script>

<fieldset class="date-range-picker">
  <legend>{label}</legend>
  <div class="date-range-controls">
    <div class="form-field">
      <label for={startInputId} class="field-label">From</label>
      <input
        id={startInputId}
        class="control"
        type="datetime-local"
        aria-label={`${label} from`}
        value={startValue}
        oninput={handleStartInput}
      />
    </div>
    <div class="form-field">
      <label for={endInputId} class="field-label">To</label>
      <input
        id={endInputId}
        class="control"
        type="datetime-local"
        aria-label={`${label} to`}
        value={endValue}
        oninput={handleEndInput}
      />
    </div>
  </div>
</fieldset>

<style>
  .date-range-picker {
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }

  .date-range-picker legend {
    margin-bottom: var(--space-1-5, 0.375rem);
    padding: 0;
    font-size: var(--text-xs, 0.75rem);
    font-weight: var(--font-medium, 500);
    line-height: 1;
    color: var(--text, #111827);
  }

  .date-range-controls {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-2, 0.5rem);
  }

  .form-field {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: var(--field-gap, var(--space-1-5, 0.375rem));
  }

  .field-label {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1, 0.25rem);
    font-size: var(--text-xs, 0.75rem);
    font-weight: var(--font-medium, 500);
    line-height: 1;
    color: var(--text-muted, #6b7280);
  }

  .control {
    display: block;
    width: 100%;
    min-height: var(--control-height, 2.25rem);
    padding: var(--space-1-5, 0.375rem) var(--space-2, 0.5rem);
    font-size: var(--text-sm, 0.875rem);
    line-height: var(--leading-normal, 1.5);
    color: var(--text, #111827);
    background: var(--control-bg, var(--surface, #fff));
    border: 1px solid var(--control-border, #d1d5db);
    border-radius: var(--radius-md, 0.375rem);
    transition:
      border-color var(--duration-fast, 150ms) var(--ease-standard, ease),
      box-shadow var(--duration-fast, 150ms) var(--ease-standard, ease);
  }

  .control:hover:not(:disabled) {
    border-color: var(--control-border-hover, #9ca3af);
  }

  .control:focus-visible {
    outline: 2px solid transparent;
    box-shadow:
      0 0 0 var(--ring-offset, 2px) var(--ring-offset-color, var(--surface, #fff)),
      0 0 0 calc(var(--ring-offset, 2px) + var(--ring-width, 2px))
        var(--control-ring-color, #6366f1);
  }

  @media (max-width: 520px) {
    .date-range-controls {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
