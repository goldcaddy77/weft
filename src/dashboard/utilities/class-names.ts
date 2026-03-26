type ClassValue = string | false | null | undefined | 0;

/** Merge class names, filtering out falsy values. */
export function cn(...inputs: ClassValue[]): string {
  return inputs.filter(Boolean).join(' ');
}
