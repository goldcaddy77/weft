# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed (breaking)

The `weft/server/handler` subpath no longer exports the internal legacy route
precedence helpers `countLiteralSegments`, `countPathParameters`, or
`shouldPreferLegacyRoute`. Direct meta and discovery endpoints are now modeled
as reserved direct HTTP routes instead of legacy fallbacks.

## [0.1.0] - 2026-05-11

### Removed (breaking)

Weft no longer ships an AI agent surface. All agent loops, declarations, and
coordination primitives now live outside Weft — in an external agent
framework or in your own loop on top of `ctx.run()` and `ctx.review()`.

Removed exports:

- `executeAgentLoop`, `AgentLoopSuspendedError`
- `AgentOptions`, `AgentResult`, `AgentTool`, `PendingProviderResumeState`,
  `PersistedAgentLoopState`, `TurnUsageEntry`, `VerificationRecorder`
- `AgentBureauConversationHistory`, `ChatOptions`, `ChatResponse`,
  `ChatResumeContext`, `ChatResumeHint`, `ConversationHistoryMessage`,
  `LLMProvider`, `NormalizedChatResponse`
- `ToolCall`, `ToolCallInput`, `ToolDefinition`, `ToolDescriptor`,
  `ToolResult`, `ToolResultInput`, `ToolErrorShape`, `ToolActionShape`,
  `ToolErrorCategory`, `TokenUsage`
- `debate`, `handoff`, `supervise`, `createChildHeaders`
- `agent`, `isAgentDefinition`, `AgentDefinition`, `AgentToolDefinition`,
  `ToolIdentityResult`, `AgentRegistrationOptions`
- `AgentTurnStartedEvent`, `AgentTurnCompletedEvent`, `AgentToolCalledEvent`,
  `AgentToolReturnedEvent`, `AgentCheckpointResumedEvent`,
  `AgentCheckpointSizeWarningEvent`, `WeftAgentEventMap`
- `Message`, `MessageRole`, `ConversationHistory`
- `ctx.agent()`, `ctx.handoff()`, `ctx.debate()`, `ctx.supervise()` removed
  from `Context`

### Renamed (breaking)

The following generic primitives were promoted out of `src/ai/` and renamed:

- `ToolEffectLog` → `EffectLog` (class)
- `ToolCallReplayConflictError` → `EffectReplayConflictError`
- `EffectLog` constructor parameter `agentId` → `operationId`
- `EffectRecord.toolName` → `EffectRecord.effectName` (no observed
  persisted-data impact — Phase 0 inventory found zero stored records with
  the field)
- `HumanReviewRequestedEvent` → `ReviewRequestedEvent` (TypeScript symbol only)
- `HumanReviewCompletedEvent` → `ReviewCompletedEvent` (TypeScript symbol only)
- `WeftAgentEventMap` → `WeftReviewEventMap`
- `ctx.humanReview()` → `ctx.review()`
- `HumanReviewOptions.conversation` field removed

### Wire format

Persisted event `type` strings remain unchanged: `'human-review:requested'`
and `'human-review:completed'`. Historical event records replay without
migration.

### Migration

Weft now focuses on durable execution and human-in-the-loop review. If you
were using Weft's agent loop or coordination primitives, migrate to an
external agent framework or build your loop on top of `ctx.run()` and
`ctx.review()`.

---
