# Engine field initialization order

This document lists the instance fields of `Engine` (formerly `#private`) in
the order they were declared in the pre-PR-8 `src/core/engine.ts`. The
`initializeInternals(engine)` function in
`src/core/engine/internals.ts` creates an empty skeleton; the Engine
constructor body then populates these fields in the same order via
`getInternals(this).fieldName = expr`.

Preserving this ordering is load-bearing for replay determinism: any code
that runs during construction (e.g., `createExecutionStrategyBundle` calling
back into `getRegistration: getInternals(this).registrations.get.bind(...)`)
expects fields to be assigned in this sequence.

| #   | Field                             | Kind                                       |
| --- | --------------------------------- | ------------------------------------------ |
| 1   | `storage`                         | data                                       |
| 2   | `registrations`                   | data                                       |
| 3   | `workflowTypesByHandler`          | data                                       |
| 4   | `abortController`                 | data                                       |
| 5   | `scheduler`                       | data                                       |
| 6   | `options`                         | data                                       |
| 7   | `strategy`                        | data                                       |
| 8   | `inlineStrategy`                  | data (nullable)                            |
| 9   | `handleCache`                     | data                                       |
| 10  | `finalizationRegistry`            | data                                       |
| 11  | `resultResolvers`                 | data                                       |
| 12  | `signalWaiters`                   | data                                       |
| 13  | `signalWaitersByWorkflow`         | data                                       |
| 14  | `updateWaiters`                   | data                                       |
| 15  | `updateWaitersByWorkflow`         | data                                       |
| 16  | `sleepResolvers`                  | data                                       |
| 17  | `sleepResolversByWorkflow`        | data                                       |
| 18  | `interceptors`                    | data                                       |
| 19  | `composedWorkflowInterceptor`     | data (nullable)                            |
| 20  | `composedActivityInterceptor`     | data (nullable)                            |
| 21  | `updateCoordinator`               | data                                       |
| 22  | `activityRegistry`                | data                                       |
| 23  | `activityWorkerDispatcher`        | data (nullable)                            |
| 24  | `checkpoints`                     | data                                       |
| 25  | `broadcastChannel`                | data (nullable)                            |
| 26  | `pendingNestingDepth`             | data (optional)                            |
| 27  | `pendingParentHeaders`            | data (optional)                            |
| 28  | `workflowNestingDepths`           | data                                       |
| 29  | `workflowHeaders`                 | data                                       |
| 30  | `workflowStateWriteChains`        | data                                       |
| 31  | `tenantQuotaManager`              | data                                       |
| 32  | `heartbeatDetails`                | data                                       |
| 33  | `pendingStarts`                   | data                                       |
| 34  | `pendingScheduleCreations`        | data                                       |
| 35  | `workflowsNeedingTerminalCleanup` | data                                       |
| 36  | `cleanupInterval`                 | data (nullable)                            |
| 37  | `retentionSweepInterval`          | data (nullable)                            |
| 38  | `retentionSweepInFlight`          | data (nullable)                            |
| 39  | `nextRetentionSweepAt`            | data (nullable)                            |
| 40  | `reviewCoordinator`               | data                                       |
| 41  | `reviewWaiters`                   | data                                       |
| 42  | `reviewWaitersByWorkflow`         | data                                       |
| 43  | `reviewEscalationHandlers`        | data                                       |
| 44  | `workflowReviewIds`               | data                                       |
| 45  | `parkedInlineWorkflows`           | data                                       |
| 46  | `terminalizingWorkflows`          | data                                       |
| 47  | `reviewTimerIds`                  | data                                       |
| 48  | `pendingWebhooks`                 | data                                       |
| 49  | `alertManager`                    | data (nullable)                            |
| 50  | `agentWorkflowIds`                | inline initializer (`= new Set<string>()`) |
| 51  | `eventLogHeads`                   | inline initializer (`= new Map()`)         |
| 52  | `workflowFeedListeners`           | inline initializer (`= new Map()`)         |
| 53  | `workflowVersionTuples`           | inline initializer (`= new Map()`)         |
| 54  | `pendingTimelineEntries`          | data                                       |

**Note on inline-initializer fields (#50–#53)**: in the pre-PR-8 code these
ran automatically at instance-creation time, before the constructor body. In
the WeakMap pattern they are populated explicitly in the constructor body
near the other field assignments.
