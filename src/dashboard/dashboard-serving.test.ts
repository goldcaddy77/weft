import { afterEach, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import { serve, type WeftServer } from '../server/index.ts';
import { MemoryStorage } from '../storage/memory.ts';

// Asset smoke test for the real dashboard HTMLBundle (Bun bundles the
// `<script>`/`<link>` references at serve time). This guards the root mount:
// serving the shell at `/` must still deliver working, non-HTML JS/CSS assets.
//
// Bun resolves the bundled asset URLs relative to the working directory, so
// this test is meaningful only when run from the repository root (the CI
// condition); the example smoke test, which runs from its own cwd, deliberately
// does not assert asset reachability.

let server: WeftServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

it('serves the dashboard shell and its bundled assets from the origin root', async () => {
  const dashboardModule = await import('./index.html');
  const dashboard = dashboardModule.default;
  using storage = new MemoryStorage();
  await using engine = new Engine({ storage });
  server = serve({ engine, dashboard, port: 0, hostname: '127.0.0.1' });

  const shell = await fetch(new URL('/', server.url));
  expect(shell.status).toBe(200);
  const html = await shell.text();
  expect(html).toContain('<div id="application">');

  const assetUrls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1]!)
    .filter((href) => href.endsWith('.js') || href.endsWith('.css'));
  expect(assetUrls.length).toBeGreaterThan(0);

  for (const href of assetUrls) {
    const assetResponse = await fetch(new URL(href, server.url));
    expect(assetResponse.ok).toBe(true);
    expect(assetResponse.headers.get('content-type')).not.toContain('text/html');
  }
});

it('serves the dashboard shell on a deep-link reload of a known page route', async () => {
  const dashboardModule = await import('./index.html');
  const dashboard = dashboardModule.default;
  using storage = new MemoryStorage();
  await using engine = new Engine({ storage });
  server = serve({ engine, dashboard, port: 0, hostname: '127.0.0.1' });

  // Hard reload of a workflow detail deep link (matched by the `/workflows/*`
  // page route) must return the SPA shell, not a 404.
  const response = await fetch(new URL('/workflows/some-workflow-id', server.url));
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('<div id="application">');
});
