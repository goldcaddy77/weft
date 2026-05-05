# Engine field initialization order

This document lists the 58 instance fields of `Engine` (formerly `#private`) in
the order they were declared in the pre-PR-8 `src/core/engine.ts`. The
`initializeInternals(engine)` function in
`src/core/engine/internals.ts` creates an empty skeleton; the Engine
constructor body then populates these fields in the same order via
`getInternals(this).fieldName = expr`.

Preserving this ordering is load-bearing for replay determinism: any code
that runs during construction (e.g., `createExecutionStrategyBundle` calling
back into `getRegistration: getInternals(this).registrations.get.bind(...)`)
expects fields to be assigned in this sequence.

| #   | Field                              | Kind                                       |
| --- | ---------------------------------- | ------------------------------------------ |
| 1   | `storage`                          | data                                       |
| 2   | `registrations`                    | data                                       |
| 3   | `workflowTypesByHandler`           | data                                       |
| 4   | `abortController`                  | data                                       |
| 5   | `scheduler`                        | data                                       |
| 6   | `options`                          | data                                       |
| 7   | `strategy`                         | data                                       |
| 8   | `inlineStrategy`                   | data (nullable)                            |
| 9   | `handleCache`                      | data                                       |
| 10  | `finalizationRegistry`             | data                                       |
| 11  | `resultResolvers`                  | data                                       |
| 12  | `signalWaiters`                    | data                                       |
| 13  | `signalWaitersByWorkflow`          | data                                       |
| 14  | `updateWaiters`                    | data                                       |
| 15  | `updateWaitersByWorkflow`          | data                                       |
| 16  | `sleepResolvers`                   | data                                       |
| 17  | `sleepResolversByWorkflow`         | data                                       |
| 18  | `interceptors`                     | data                                       |
| 19  | `composedWorkflowInterceptor`      | data (nullable)                            |
| 20  | `composedActivityInterceptor`      | data (nullable)                            |
| 21  | `updateCoordinator`                | data                                       |
| 22  | `activityRegistry`                 | data                                       |
| 23  | `activityWorkerDispatcher`         | data (nullable)                            |
| 24  | `checkpoints`                      | data                                       |
| 25  | `broadcastChannel`                 | data (nullable)                            |
| 26  | `pendingNestingDepth`              | data (optional)                            |
| 27  | `pendingParentHeaders`             | data (optional)                            |
| 28  | `workflowNestingDepths`            | data                                       |
| 29  | `workflowHeaders`                  | data                                       |
| 30  | `workflowStateWriteChains`         | data                                       |
| 31  | `budgetPolicyEnforcer`             | data (nullable)                            |
| 32  | `tenantQuotaManager`               | data                                       |
| 33  | `heartbeatDetails`                 | data                                       |
| 34  | `pendingStarts`                    | data                                       |
| 35  | `pendingScheduleCreations`         | data                                       |
| 36  | `chargedAgentOperations`           | data                                       |
| 37  | `chargedAgentOperationsByWorkflow` | data                                       |
| 38  | `workflowsNeedingTerminalCleanup`  | data                                       |
| 39  | `cleanupInterval`                  | data (nullable)                            |
| 40  | `retentionSweepInterval`           | data (nullable)                            |
| 41  | `retentionSweepInFlight`           | data (nullable)                            |
| 42  | `nextRetentionSweepAt`             | data (nullable)                            |
| 43  | `defaultModelRouter`               | data (optional)                            |
| 44  | `reviewCoordinator`                | data                                       |
| 45  | `reviewWaiters`                    | data                                       |
| 46  | `reviewWaitersByWorkflow`          | data                                       |
| 47  | `reviewEscalationHandlers`         | data                                       |
| 48  | `workflowReviewIds`                | data                                       |
| 49  | `parkedInlineWorkflows`            | data                                       |
| 50  | `terminalizingWorkflows`           | data                                       |
| 51  | `reviewTimerIds`                   | data                                       |
| 52  | `pendingWebhooks`                  | data                                       |
| 53  | `alertManager`                     | data (nullable)                            |
| 54  | `agentWorkflowIds`                 | inline initializer (`= new Set<string>()`) |
| 55  | `eventLogHeads`                    | inline initializer (`= new Map()`)         |
| 56  | `workflowFeedListeners`            | inline initializer (`= new Map()`)         |
| 57  | `workflowVersionTuples`            | inline initializer (`= new Map()`)         |
| 58  | `pendingTimelineEntries`           | data                                       |

**Note on inline-initializer fields (#54–#57)**: in the pre-PR-8 code these
ran automatically at instance-creation time, before the constructor body. In
the WeakMap pattern they are populated explicitly in the constructor body
near the other field assignments.
