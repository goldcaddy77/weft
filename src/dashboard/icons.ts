/**
 * Inline SVG icon paths for the dashboard.
 * Each function returns an SVG string at the given size.
 * Icon paths sourced from Lucide (https://lucide.dev).
 */

function svg(size: number, paths: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

// Workflow status icons
export const play = (size = 16) => svg(size, '<polygon points="6 3 20 12 6 21 6 3"/>');

export const checkCircle = (size = 16) =>
  svg(
    size,
    '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  );

export const xCircle = (size = 16) =>
  svg(
    size,
    '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
  );

export const clock = (size = 16) =>
  svg(size, '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>');

export const alertTriangle = (size = 16) =>
  svg(
    size,
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  );

export const pause = (size = 16) =>
  svg(
    size,
    '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  );

export const ban = (size = 16) =>
  svg(size, '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>');

// Navigation icons
export const chevronLeft = (size = 16) => svg(size, '<polyline points="15 18 9 12 15 6"/>');

export const chevronRight = (size = 16) => svg(size, '<polyline points="9 18 15 12 9 6"/>');

export const externalLink = (size = 16) =>
  svg(
    size,
    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  );

export const search = (size = 16) =>
  svg(size, '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>');

export const filter = (size = 16) =>
  svg(size, '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>');

export const refreshCw = (size = 16) =>
  svg(
    size,
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>',
  );

export const x = (size = 16) =>
  svg(size, '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>');

// Agent icons
export const bot = (size = 16) =>
  svg(
    size,
    '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  );

export const messageSquare = (size = 16) =>
  svg(size, '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>');

export const dollarSign = (size = 16) =>
  svg(
    size,
    '<line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  );

// UI icons
export const sun = (size = 16) =>
  svg(
    size,
    '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>',
  );

export const moon = (size = 16) =>
  svg(size, '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>');

export const copy = (size = 16) =>
  svg(
    size,
    '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  );

export const check = (size = 16) => svg(size, '<polyline points="20 6 9 17 4 12"/>');

export const inbox = (size = 16) =>
  svg(
    size,
    '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  );

export const activity = (size = 16) =>
  svg(size, '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>');
