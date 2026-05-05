# Agent Declaration

**Agent definition:** A reusable description of an agent loop. It names the agent, chooses the model identifier passed to your provider, supplies optional prompt text and tools, and sets a turn limit.

Definitions are intentionally thin. They do not own provider setup, tool discovery, tenant policy, or runtime authorization. Those decisions belong in your application and workflow code.

## Basic usage

```typescript
import { defineAgent, type AgentToolDefinition } from 'weft';

declare const webSearch: AgentToolDefinition;
declare const factCheck: AgentToolDefinition;

const researcher = defineAgent({
  name: 'research',
  model: 'claude-sonnet-4-20250514',
  version: '1.0.0',
  description: 'Researches a topic and checks claims before returning an answer.',
  systemPrompt: 'You are a careful research analyst.',
  tools: [webSearch, factCheck],
  maxTurns: 20,
});
```

The resulting value is an `AgentDefinition`:

```typescript
interface AgentDefinition {
  name: string;
  model: string;
  version?: string;
  description?: string;
  systemPrompt?: string;
  tools?: AgentToolDefinition[];
  maxTurns?: number;
}
```

## Field reference

| Field          | Type                     | Description                                                                |
| -------------- | ------------------------ | -------------------------------------------------------------------------- |
| `name`         | `string`                 | Stable identifier used when registering and starting the agent             |
| `model`        | `string`                 | Model identifier passed to the supplied `LLMProvider`                      |
| `version`      | `string?`                | Optional semantic version for resume compatibility and operational clarity |
| `description`  | `string?`                | Human-readable purpose for documentation, dashboards, and agent catalogs   |
| `systemPrompt` | `string?`                | Optional system instruction sent to the provider                           |
| `tools`        | `AgentToolDefinition[]?` | Optional default tools available to the agent                              |
| `maxTurns`     | `number?`                | Maximum provider turns before the loop stops                               |

## Registering on an engine

Register the definition with a provider. Weft only requires a structural `LLMProvider`: a `name` and a `chat()` method.

```typescript
import { Engine, defineAgent, type LLMProvider } from 'weft';

declare const provider: LLMProvider;

const assistant = defineAgent({
  name: 'assistant',
  model: 'claude-sonnet-4-20250514',
  systemPrompt: 'You help users solve workflow problems.',
  maxTurns: 8,
});

const engine = new Engine();
engine.register(assistant, { provider });
```

After registration, start the agent by name:

```typescript
const handle = await engine.start('assistant', 'Summarize this incident report.');
const result = await handle.result();
```

For provider setup examples and ownership boundaries, see [What Weft Owns](./what-weft-owns.md).

## Using an agent inside a workflow

Use `ctx.agent()` when the agent loop is part of a larger workflow:

```typescript
import type { LLMProvider, WorkflowContext } from 'weft';

declare const provider: LLMProvider;

async function* triageWorkflow(ctx: WorkflowContext, incident: string) {
  const summary = yield* ctx.agent({
    model: 'claude-sonnet-4-20250514',
    provider,
    systemPrompt: 'Summarize incidents for an on-call engineer.',
    prompt: incident,
    maxTurns: 6,
  });

  return summary.content;
}
```

`ctx.agent()` accepts the runtime pieces needed for that invocation: provider, prompt, tools, signal, event target, and other loop options.

## Tenant-scoped tools

**Tenant-scoped tools:** Weft no longer enforces tool scoping centrally. Pass scoped tools at invocation time.

```typescript
import type { AgentToolDefinition, LLMProvider, TenantContext, WorkflowContext } from 'weft';

declare const provider: LLMProvider;

function pickToolsForTenant(tenant: TenantContext | undefined): AgentToolDefinition[] {
  if (tenant?.id === 'enterprise') return [enterpriseSearch, auditLogReader];
  return [publicSearch];
}

async function* tenantResearchWorkflow(ctx: WorkflowContext, topic: string) {
  const tools = pickToolsForTenant(ctx.tenant);

  return yield* ctx.agent({
    model: 'claude-sonnet-4-20250514',
    provider,
    tools,
    prompt: topic,
  });
}
```

Keep authorization close to the workflow that knows the tenant, request, and product boundary. The agent definition can still provide default tools, but runtime scoping belongs at the call site.
