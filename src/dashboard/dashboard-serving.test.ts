import { afterEach, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import { DASHBOARD_PAGE_ROUTES, serve, type WeftServer } from '../server/index.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { DASHBOARD_MOUNT_PATTERNS, ROUTE_TABLE } from './route-table.ts';

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

// Route-sync guard: the server mounts exactly what the SPA route table
// declares. This is the real cross-check — `DASHBOARD_PAGE_ROUTES` is derived
// from `DASHBOARD_MOUNT_PATTERNS`, which is in turn derived from `ROUTE_TABLE`,
// so a new SPA page added without a mount pattern would surface here.
it('keeps the server dashboard mounts in sync with the SPA route table', () => {
  // Every server-mounted route comes from the SPA route table.
  expect([...DASHBOARD_PAGE_ROUTES].toSorted()).toEqual([...DASHBOARD_MOUNT_PATTERNS].toSorted());

  // Every non-error SPA route declares a mount pattern (so a hard reload of it
  // resolves to the shell rather than 404ing).
  for (const definition of ROUTE_TABLE) {
    if (definition.view !== 'not-found') {
      expect(definition.mountPattern).not.toBeNull();
    }
  }

  // Every declared mount pattern is actually served by a configured dashboard.
  for (const pattern of DASHBOARD_MOUNT_PATTERNS) {
    expect(DASHBOARD_PAGE_ROUTES).toContain(pattern);
  }
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
