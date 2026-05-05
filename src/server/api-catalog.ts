/**
 * Generator for the `/.well-known/api-catalog` RFC 9264 linkset document.
 *
 * @module server/api-catalog
 */

export type ApiCatalogOptions = {
  /** Absolute server origin, e.g. `https://api.example.com` */
  readonly origin: string;
};

type LinksetLink = {
  href: string;
  type: string;
};

type LinksetEntry = {
  anchor: string;
  'service-desc': LinksetLink[];
};

type LinksetDocument = {
  linkset: LinksetEntry[];
};

/**
 * Generate an RFC 9264 linkset document describing the API discovery endpoints.
 *
 * All hrefs are absolute URLs built from `options.origin`. Links are sorted
 * alphabetically by href for deterministic output.
 */
export function generateApiCatalog(options: ApiCatalogOptions): LinksetDocument {
  const { origin } = options;

  const links: LinksetLink[] = [
    { href: `${origin}/asyncapi.json`, type: 'application/asyncapi+json' },
    { href: `${origin}/openapi.json`, type: 'application/openapi+json' },
    { href: `${origin}/openrpc.json`, type: 'application/json' },
  ].toSorted((a, b) => (a.href < b.href ? -1 : a.href > b.href ? 1 : 0));

  return {
    linkset: [
      {
        anchor: origin,
        'service-desc': links,
      },
    ],
  };
}

const ALLOWED_FORWARDED_PROTOCOLS: ReadonlySet<string> = new Set(['http', 'https']);

// Conservative `Host`-header allow-list. Matches RFC 3986 reg-name and
// IPv4-literal forms with optional port, plus IPv6-literal forms (`[::1]`,
// `[::1]:8080`). Anything else (control characters, embedded slashes,
// `javascript:` schemes, the `@` userinfo trick, etc.) is rejected.
const HOST_HEADER_PATTERN = /^(?:[A-Za-z0-9._-]+(?::\d+)?|\[[0-9A-Fa-f:.]+\](?::\d+)?)$/;

/**
 * Extract the origin (scheme + host) from a `Request` object, validating
 * each header before trusting it.
 *
 * **Security note.** Both `Host` and `X-Forwarded-Proto` are
 * client-controllable (the latter via a misconfigured reverse proxy).
 * Without validation, an attacker can poison `/.well-known/api-catalog`
 * service-desc URLs by injecting a malicious `Host: evil.example` or a
 * non-network protocol (`X-Forwarded-Proto: javascript`).
 *
 * Operators in production are strongly encouraged to set
 * `serve({ publicOrigin: 'https://api.example.com' })` so this header path
 * is never used. When `publicOrigin` is unset, this function falls back to
 * the request URL's origin (which is the actual incoming connection's
 * scheme/host pair as Bun resolved them, not header-derived) and only
 * upgrades to header-derived values when the request URL does not include
 * an authoritative origin (e.g. unit tests using relative URLs).
 *
 * Validation rules:
 *   - `X-Forwarded-Proto` must be exactly `http` or `https`; anything else
 *     is dropped.
 *   - `Host` must match a conservative reg-name / IP-literal pattern with
 *     optional port; anything else is dropped.
 *   - When neither header is trustworthy, falls back to `localhost` over
 *     `https` so the function never returns an attacker-controlled value.
 */
export function originFromRequest(request: Request): string {
  // Prefer the request URL's origin — it reflects the actual connection
  // scheme/host as the runtime resolved them, not arbitrary header text.
  try {
    const requestUrl = new URL(request.url);
    if (requestUrl.protocol === 'https:' || requestUrl.protocol === 'http:') {
      // request.url for a Bun.serve() request always includes the bound
      // scheme/host pair, so prefer it over header-derived values.
      return `${requestUrl.protocol}//${requestUrl.host}`;
    }
  } catch {
    // Fall through to header-based derivation.
  }

  const rawHost = request.headers.get('host');
  const rawProto = request.headers.get('x-forwarded-proto');

  const proto =
    rawProto !== null && ALLOWED_FORWARDED_PROTOCOLS.has(rawProto.toLowerCase())
      ? rawProto.toLowerCase()
      : 'https';

  const host = rawHost !== null && HOST_HEADER_PATTERN.test(rawHost) ? rawHost : 'localhost';

  return `${proto}://${host}`;
}
