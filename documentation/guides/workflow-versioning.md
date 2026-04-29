# Workflow Versioning

You've shipped a new version of your order workflow, but there are 200 orders mid-flight using the old code. What happens when they resume? In Temporal, you'd be adding version gates and deterministic code-path branches. In Weft, you write a data migration function and move on.

## Why this is simpler

Weft resumes from checkpoints, not by replaying event histories. The checkpoint captures the complete state at the pause point---local variables, step index, search attributes. When a workflow resumes, it picks up from that snapshot. The only compatibility question is: "Can my new code handle this checkpoint's shape at the step where execution paused?"

No replay means no code-path determinism requirement. No `getVersion()` gates. No patching API. Migration is a pure data transformation.

## Version pinning

When `engine.start()` creates a workflow, it records the version of the currently registered handler in the workflow state. The default version is `'1'` if you don't specify one.

```typescript
// Shorthand: version defaults to '1'
engine.register('order', orderWorkflow);

// Explicit version
engine.register('order', {
  version: '2.0.0',
  handler: orderWorkflowV2,
});
```

The version string is stored alongside the checkpoint. On resume, the engine compares the stored version against the currently registered version.

## The `checkVersionCompatibility()` function

The comparison logic is straightforward:

- **`'compatible'`** --- versions match. Resume normally.
- **`'needs-migration'`** --- versions differ and a migration function is registered. Run the migration first.
- **`'incompatible'`** --- versions differ and no migration function is registered. The engine throws `VersionMismatchError` rather than resuming.

## Writing a migration

The `migrate` function receives the checkpoint data and the version it came from. It returns the transformed checkpoint.

```typescript
engine.register('order', {
  version: '2.0.0',
  handler: orderWorkflowV2,
  migrate(checkpoint, fromVersion) {
    if (fromVersion.startsWith('1.')) {
      // V1 stored `address` as a string; V2 uses an Address object
      return {
        ...checkpoint,
        address: parseAddress(checkpoint.address),
      };
    }
    return checkpoint;
  },
});
```

The `migrateCheckpoint()` utility runs this function internally:

```typescript
const migrated = migrateCheckpoint(
  checkpointData,
  storedVersion,
  registeredVersion,
  migrationFunction,
);
```

After a successful migration, the updated checkpoint and new version are written to storage atomically via `buildVersionUpdateOperations()`. Both the checkpoint bytes and the workflow state blob are updated in a single `batch()` call. No window for inconsistency.

## When migration fails

If your new code can't handle the checkpoint shape and no migration was provided (or the migration throws), the workflow fails with a `VersionMismatchError`. The error includes everything you need to diagnose the problem:

```typescript
try {
  await handle.result();
} catch (error) {
  if (error instanceof VersionMismatchError) {
    console.log(error.workflowId); // 'order-abc-123'
    console.log(error.workflowType); // 'order'
    console.log(error.storedVersion); // '1.0.0'
    console.log(error.registeredVersion); // '2.0.0'
    console.log(error.fieldDiffs); // populated when checkpoint shape drifted
    console.log(error.versionDiff); // workflow/agent/tool version delta
  }
}
```

## Practical patterns

For simple changes where the checkpoint shape didn't change---you only modified logic after the current pause point---skip the migration entirely:

```typescript
engine.register('order', {
  version: '1.1.0',
  handler: orderWorkflowV1WithBugfix,
  // No migrate needed
});
```

For additive changes where you need a new field with a default:

```typescript
engine.register('order', {
  version: '2.0.0',
  handler: orderWorkflowV2,
  migrate(checkpoint, fromVersion) {
    if (fromVersion.startsWith('1.')) {
      return { ...checkpoint, region: 'us-east-1' };
    }
    return checkpoint;
  },
});
```

For breaking changes across multiple major versions, chain the transformations:

```typescript
engine.register('order', {
  version: '3.0.0',
  handler: orderWorkflowV3,
  migrate(checkpoint, fromVersion) {
    let migrated = checkpoint;
    if (fromVersion.startsWith('1.')) {
      migrated = { ...migrated, address: parseAddress(migrated.address) };
    }
    if (fromVersion.startsWith('1.') || fromVersion.startsWith('2.')) {
      migrated = { ...migrated, currency: 'USD' };
    }
    return migrated;
  },
});
```

The beauty of this approach is that you think about data shapes, not execution paths. "What does my checkpoint look like, and what does my new code expect?" is a much simpler question than "Is my new code deterministically compatible with every possible event history?"
