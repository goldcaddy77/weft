# Roadmap to 1.0

Weft is launching as `0.2.0` while the final correctness and compatibility contracts settle. A `1.0` release should mean a durable, documented support promise for the stable tier, not just a larger version number.

## What 1.0 Means for Adopters

Version 1.0 means teams can build on the stable tier with a clear compatibility contract:

- Stable-tier APIs follow semver, with migration notes for any breaking change.
- Supported deployment topology is explicit, including the Bun server runtime and the stable storage adapters.
- Stable-tier storage and recovery guarantees are documented at the point of use.
- Public error codes and REST response shapes in the stable tier carry a compatibility commitment.
- Experimental surfaces remain available, but their contracts are labeled separately until they graduate.

## What 1.0 Covers

The 1.0 compatibility promise applies to surfaces that graduate into the stable tier:

- Engine core workflow execution and recovery.
- `TestEngine`.
- [Bun SQLite and SQLite via Node compatibility APIs](reference/api-storage.md#sqlitestorage), plus [LMDB](reference/api-storage.md#lmdbstorage) storage adapters.
- `RemoteWorker`.
- `serve()` and the `/v1` REST surface.
- Exported public error codes.

Experimental surfaces can continue changing before they graduate. That includes the browser runtime, MCP, IndexedDB, WebExtension, HTTP and compressed storage, [Turso](reference/api-storage.md#tursostorage) until conformance proof is complete, CLI commands beyond `serve` and `doctor`, OpenTelemetry metric names, the dashboard, and `ctx.step()` sugar.

## Required Before 1.0

- Tier-0 behavioral contracts are implemented and verified for activity result reconciliation, signal idempotency, resume ownership guarantees for concurrent in-progress workflows, storage durability claims, and persisted-format compatibility.
- The stable-tier list is updated from provisional to final after the Tier-0 work lands.
- Breaking-change and deprecation policy is published.
- Security disclosure process is published.
- Getting-started documentation uses only commands and APIs shipped in the package.
- Launch-blocking regression tests are either passing or replaced by explicit tracked work with owner sign-off.

## Release Posture

Use the pre-1.0 public MVP line for launch. Breaking changes are still possible before 1.0, but they should be documented in release notes with migration guidance. Use `1.0.0` only when the stable tier can carry the compatibility promise above.
