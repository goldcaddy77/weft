# Installation

Weft runs on Bun. If you don't have it yet, the install is a one-liner:

```bash
curl -fsSL https://bun.sh/install | bash
```

You'll need Bun 1.2 or later. Verify with `bun --version`.

## Library Mode

Most projects should start here. Add Weft as a dependency and use the engine directly in your code.

```bash
bun add weft
```

That's it. No Docker, no separate server process, no gRPC. You import `Engine` and `MemoryStorage` (or `BunSQLiteStorage`) and start writing workflows.

```typescript
import { Engine, MemoryStorage } from 'weft';

const engine = new Engine({ storage: new MemoryStorage() });
```

For production, swap in SQLite-backed storage so your checkpoints survive process restarts:

```typescript
import { Engine, BunSQLiteStorage } from 'weft';

const engine = new Engine({
  storage: new BunSQLiteStorage('./weft.db'),
});
```

The database file is created automatically. No migrations to run.

## Server Mode

For larger deployments where you want a standalone Weft server with a REST API, WebSocket worker connections, and a web dashboard, download the prebuilt binary for your platform:

```bash
curl -L https://releases.weft.dev/v1/weft-darwin-arm64 -o weft
chmod +x weft
./weft --port 7233
```

That gives you a running server with SQLite storage and a dashboard at `localhost:7233/ui`. Workers connect over WebSocket and pull tasks from the server.

## Compile Your Own Binary

You can also bake your workflow code directly into a standalone binary. This is useful when you want a single artifact that includes the Weft engine _and_ your application logic---no runtime dependencies, nothing to install on the target machine.

```bash
bun build --compile src/my-app.ts --outfile my-app
```

The resulting binary bundles the Bun runtime, the Weft engine, your workflows, and (if you include the server) the web dashboard. Ship it anywhere.

## Supported Platforms

Weft produces standalone binaries for these targets:

- `darwin-arm64` (macOS Apple Silicon)
- `darwin-x64` (macOS Intel)
- `linux-x64`
- `linux-arm64`
- `windows-x64`

Cross-compilation works from any OS. A single CI pipeline can produce all five binaries:

```bash
bun build --compile --target=bun-darwin-arm64 src/cli.ts --outfile dist/weft-darwin-arm64
bun build --compile --target=bun-linux-x64    src/cli.ts --outfile dist/weft-linux-x64
bun build --compile --target=bun-windows-x64  src/cli.ts --outfile dist/weft-windows-x64.exe
```

## What Ships Inside the Binary

The compiled binary includes the Bun runtime (with SQLite, HTTP server, and WebSocket built in), the Weft engine and server code, the web dashboard, and default configuration. It does _not_ include LMDB native bindings (opt-in via `bun add lmdb`) or your workflow code (unless you compile it in yourself).

## Next Steps

With Weft installed, you're ready to write your first workflow. Head to the [Hello World](hello-world.md) guide.
