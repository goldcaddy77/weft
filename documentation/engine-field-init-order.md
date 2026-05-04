# Engine field initialization order

This document lists the 59 instance fields of `Engine` (formerly `#private`) in
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
| 19  | `activityInterceptors`             | data                                       |
| 20  | `composedWorkflowInterceptor`      | data (nullable)                            |
| 21  | `composedActivityInterceptor`      | data (nullable)                            |
| 22  | `updateCoordinator`                | data                                       |
| 23  | `activityRegistry`                 | data                                       |
| 24  | `activityWorkerDispatcher`         | data (nullable)                            |
| 25  | `checkpoints`                      | data                                       |
| 26  | `broadcastChannel`                 | data (nullable)                            |
| 27  | `pendingNestingDepth`              | data (optional)                            |
| 28  | `pendingParentHeaders`             | data (optional)                            |
| 29  | `workflowNestingDepths`            | data                                       |
| 30  | `workflowHeaders`                  | data                                       |
| 31  | `workflowStateWriteChains`         | data                                       |
| 32  | `budgetPolicyEnforcer`             | data (nullable)                            |
| 33  | `tenantQuotaManager`               | data                                       |
| 34  | `heartbeatDetails`                 | data                                       |
| 35  | `pendingStarts`                    | data                                       |
| 36  | `pendingScheduleCreations`         | data                                       |
| 37  | `chargedAgentOperations`           | data                                       |
| 38  | `chargedAgentOperationsByWorkflow` | data                                       |
| 39  | `workflowsNeedingTerminalCleanup`  | data                                       |
| 40  | `cleanupInterval`                  | data (nullable)                            |
| 41  | `retentionSweepInterval`           | data (nullable)                            |
| 42  | `retentionSweepInFlight`           | data (nullable)                            |
| 43  | `nextRetentionSweepAt`             | data (nullable)                            |
| 44  | `defaultModelRouter`               | data (optional)                            |
| 45  | `reviewCoordinator`                | data                                       |
| 46  | `reviewWaiters`                    | data                                       |
| 47  | `reviewWaitersByWorkflow`          | data                                       |
| 48  | `reviewEscalationHandlers`         | data                                       |
| 49  | `workflowReviewIds`                | data                                       |
| 50  | `parkedInlineWorkflows`            | data                                       |
| 51  | `terminalizingWorkflows`           | data                                       |
| 52  | `reviewTimerIds`                   | data                                       |
| 53  | `pendingWebhooks`                  | data                                       |
| 54  | `alertManager`                     | data (nullable)                            |
| 55  | `agentWorkflowIds`                 | inline initializer (`= new Set<string>()`) |
| 56  | `eventLogHeads`                    | inline initializer (`= new Map()`)         |
| 57  | `workflowFeedListeners`            | inline initializer (`= new Map()`)         |
| 58  | `workflowVersionTuples`            | inline initializer (`= new Map()`)         |
| 59  | `pendingTimelineEntries`           | data                                       |

**Note on inline-initializer fields (#55–#58)**: in the pre-PR-8 code these
ran automatically at instance-creation time, before the constructor body. In
the WeakMap pattern they are populated explicitly in the constructor body
near the other field assignments.
