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

/**
 * Extract the origin (scheme + host) from a `Request` object.
 * Falls back to `https` when the `X-Forwarded-Proto` header is absent.
 */
export function originFromRequest(request: Request): string {
  const host = request.headers.get('host') ?? 'localhost';
  const proto = request.headers.get('x-forwarded-proto') ?? 'https';
  return `${proto}://${host}`;
}
