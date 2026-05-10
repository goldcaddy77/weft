export const HELP_TEXT = `
weft - Bun-native durable execution engine

Usage: weft [command] [options]

Commands:
  serve           Start the Weft server (default)
  doctor          Run diagnostics on the Weft database
  conformance     Run RemoteWorker protocol conformance checks
  schedule        Manage recurring schedules
  timeline        Inspect workflow timeline and replay history
  version:check   Check workflow version compatibility
  validate        Lint workflow registrations for design-time anti-patterns

Serve Options:
  -p, --port <port>           Server port (default: 7233)
  -d, --database <path>       Database file path (default: ./weft.db)
  -s, --storage <backend>     Storage backend: sqlite, lmdb, memory (default: sqlite)
      --no-ui                 Disable the dashboard UI
  -h, --help                  Show this help message
`;

export const CONFORMANCE_HELP_TEXT = `
weft conformance - Run RemoteWorker protocol conformance checks

Usage: weft conformance [options] -- <worker-command> [args...]

The worker command receives:
  WEFT_WORKER_URL
  WEFT_WORKER_QUEUE
  WEFT_WORKER_ACTIVITIES
  WEFT_WORKER_PROTOCOL_VERSION

Options:
      --timeout <ms>       Per-check timeout in milliseconds (default: 15000)
  -j, --json               Output results as JSON
  -h, --help               Show this help message
`;

export const DOCTOR_HELP_TEXT = `
weft doctor - Run diagnostics on the Weft database

Usage: weft doctor [options]

Options:
  -d, --database <path>   Database file path (default: ./weft.db)
  -j, --json              Output results as JSON
  -h, --help              Show this help message
`;

export const VERSION_CHECK_HELP_TEXT = `
weft version:check - Check workflow version compatibility

Usage: weft version:check [options]

Options:
  -d, --database <path>     Database file path (default: ./weft.db)
  -w, --workflows <path>    Path to workflows module
  -j, --json                Output results as JSON
  -h, --help                Show this help message
`;

export const TIMELINE_HELP_TEXT = `
weft timeline - Inspect workflow timeline and replay history

Usage:
  weft timeline <workflowId> [options]
  weft timeline <workflowId> --diff <fromStep> <toStep> [options]

Options:
  -d, --database <path>     Database file path (default: ./weft.db)
      --step <step>         Show replay details for one checkpoint step
      --diff                Diff two checkpoint steps (requires two positional step numbers)
  -h, --help                Show this help message
`;

export const SCHEDULE_HELP_TEXT = `
weft schedule - Manage recurring schedules

Usage:
  weft schedule list [options]
  weft schedule create <workflowType> <cronExpression> [options]
  weft schedule pause <scheduleId> [options]
  weft schedule resume <scheduleId> [options]
  weft schedule cancel <scheduleId> [options]

Options:
  -d, --database <path>     Database file path (default: ./weft.db)
  -s, --storage <backend>   Storage backend: sqlite, lmdb (default: sqlite)
  -w, --workflows <path>    Path to workflow registrations module (required for create)
      --input <json>        JSON input payload for create (default: null)
      --id <id>             Custom schedule id for create
      --overlap <policy>    Overlap policy: skip, queue, cancel-running, allow
      --backfill            Run missed ticks on recovery
  -j, --json                Output results as JSON
  -h, --help                Show this help message
`;

export const VALIDATE_HELP_TEXT = `
weft validate - Lint workflow registrations for design-time anti-patterns

Usage: weft validate <entry.ts>... [options]

Arguments:
  <entry.ts>...           One or more TypeScript modules or glob patterns that
                          resolve to workflow registrations and/or activity
                          definitions.

Options:
  -j, --json              Output results as JSON
  -h, --help              Show this help message

Exit codes:
  0   No errors (warnings may be present)
  1   One or more errors detected
  2   Entry file could not be loaded (takes precedence over validation errors)

JSON output:
  { entries, valid, hasLoadErrors, hasValidationErrors }

Checks performed:
  unbounded-retry               Activity retry.maxAttempts is Infinity
  stateful-without-compensator  Non-idempotent activity has no compensate fn
`;
