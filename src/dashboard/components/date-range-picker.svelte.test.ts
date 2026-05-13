import { afterEach, describe, expect, it } from 'bun:test';

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { BunPlugin } from 'bun';
import { JSDOM } from 'jsdom';

type DateRangeHarnessModule = {
  flushSync: () => void;
  mountDateRangePicker: (target: Element) => unknown;
  rangeValues: () => { gte: number | undefined; lte: number | undefined };
  setRangeValues: (values: { gte?: number; lte?: number }) => void;
  unmountDateRangePicker: (component: unknown) => void | Promise<void>;
};

const COMPONENT_DIRECTORY = new URL('.', import.meta.url).pathname;
const generatedFiles: string[] = [];
const generatedDirectories: string[] = [];
let flushSvelte = (): void => {};

afterEach(() => {
  for (const generatedFile of generatedFiles.splice(0)) {
    rmSync(generatedFile, { force: true });
  }
  for (const generatedDirectory of generatedDirectories.splice(0)) {
    rmSync(generatedDirectory, { force: true, recursive: true });
  }
});

async function loadDateRangeHarnessModule(): Promise<DateRangeHarnessModule> {
  const harnessPath = join(
    COMPONENT_DIRECTORY,
    `.date-range-picker-harness.${crypto.randomUUID()}.svelte.ts`,
  );
  const source = `
    import { flushSync, mount, unmount } from 'svelte';
    import DateRangePicker from './date-range-picker.svelte';

    let gte = $state<number | undefined>(undefined);
    let lte = $state<number | undefined>(undefined);

    export { flushSync };

    export function mountDateRangePicker(target: Element): unknown {
      return mount(DateRangePicker, {
        target,
        props: {
          id: 'created-at',
          label: 'Created At',
          get gte() {
            return gte;
          },
          set gte(value: number | undefined) {
            gte = value;
          },
          get lte() {
            return lte;
          },
          set lte(value: number | undefined) {
            lte = value;
          },
        },
      });
    }

    export function rangeValues(): { gte: number | undefined; lte: number | undefined } {
      return { gte, lte };
    }

    export function setRangeValues(values: { gte?: number; lte?: number }): void {
      gte = values.gte;
      lte = values.lte;
    }

    export function unmountDateRangePicker(component: unknown): void | Promise<void> {
      return unmount(component);
    }
  `;
  await Bun.write(harnessPath, source);
  generatedFiles.push(harnessPath);

  const sveltePluginSpecifier = 'bun-plugin-svelte';
  const sveltePluginModule = (await import(sveltePluginSpecifier)) as {
    SveltePlugin: (options: { forceSide: 'client'; development: boolean }) => BunPlugin;
  };
  const outputDirectory = join(
    COMPONENT_DIRECTORY,
    `.date-range-picker-harness.${crypto.randomUUID()}.compiled`,
  );
  generatedDirectories.push(outputDirectory);

  const result = await Bun.build({
    entrypoints: [harnessPath],
    target: 'browser',
    format: 'esm',
    outdir: outputDirectory,
    plugins: [sveltePluginModule.SveltePlugin({ forceSide: 'client', development: false })],
  });

  expect(result.success).toBe(true);
  const outputPath = result.outputs[0]?.path;
  expect(outputPath).toBeString();
  if (outputPath === undefined) {
    throw new Error('Svelte component build did not produce an output file');
  }

  return (await import(pathToFileURL(outputPath).href)) as DateRangeHarnessModule;
}

function installDom(): () => void {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
  });
  const replacements: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    SVGElement: dom.window.SVGElement,
    Text: dom.window.Text,
    Comment: dom.window.Comment,
    Document: dom.window.Document,
    DocumentFragment: dom.window.DocumentFragment,
    Event: dom.window.Event,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    navigator: dom.window.navigator,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback): number =>
      setTimeout(() => callback(Date.now()), 0) as unknown as number,
    cancelAnimationFrame: (handle: number): void => clearTimeout(handle),
  };
  const previousDescriptors = new Map<string, PropertyDescriptor | undefined>();

  for (const [key, value] of Object.entries(replacements)) {
    previousDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  return () => {
    for (const [key, descriptor] of previousDescriptors) {
      if (descriptor === undefined) {
        Reflect.deleteProperty(globalThis, key);
      } else {
        Object.defineProperty(globalThis, key, descriptor);
      }
    }
    dom.window.close();
  };
}

async function mountDateRangePicker(): Promise<{
  harnessModule: DateRangeHarnessModule;
  cleanup: () => Promise<void>;
}> {
  const cleanupDom = installDom();
  const harnessModule = await loadDateRangeHarnessModule();
  flushSvelte = harnessModule.flushSync;
  const mounted = harnessModule.mountDateRangePicker(document.body);
  flushSvelte();
  await settle();

  return {
    harnessModule,
    cleanup: async () => {
      await harnessModule.unmountDateRangePicker(mounted);
      flushSvelte = (): void => {};
      cleanupDom();
    },
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  flushSvelte();
}

function inputById(id: string): HTMLInputElement {
  const input = document.getElementById(id);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Expected input ${id}`);
  }
  return input;
}

async function changeInputValue(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
}

describe('DateRangePicker', () => {
  it('binds datetime-local inputs to millisecond gte and lte bounds', async () => {
    const { harnessModule, cleanup } = await mountDateRangePicker();
    try {
      const start = inputById('created-at-gte');
      const end = inputById('created-at-lte');

      expect(document.body.querySelector('legend')?.textContent).toBe('Created At');
      expect(start.getAttribute('aria-label')).toBe('Created At from');
      expect(end.getAttribute('aria-label')).toBe('Created At to');

      await changeInputValue(start, '2026-05-13T09:30');
      await changeInputValue(end, '2026-05-13T11:45');

      expect(harnessModule.rangeValues()).toEqual({
        gte: new Date('2026-05-13T09:30').getTime(),
        lte: new Date('2026-05-13T11:45').getTime(),
      });

      harnessModule.setRangeValues({ gte: new Date('2026-05-14T08:15').getTime() });
      await settle();

      expect(start.value).toBe('2026-05-14T08:15');
      expect(end.value).toBe('');

      await changeInputValue(start, '');

      expect(harnessModule.rangeValues()).toEqual({
        gte: undefined,
        lte: undefined,
      });
    } finally {
      await cleanup();
    }
  });
});
