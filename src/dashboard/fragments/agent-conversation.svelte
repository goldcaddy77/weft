<script lang="ts" module>
  import type { AgentTurnData } from './agent-turn-types.ts';

  export type AgentConversationProps = {
    turns: readonly AgentTurnData[];
  };
</script>

<script lang="ts">
  import Badge from '../components/badge.svelte';
  import JsonViewer from './json-viewer.svelte';
  import { groupConversationMessages } from './agent-conversation.ts';

  let { turns }: AgentConversationProps = $props();

  const groups = $derived(groupConversationMessages(turns));

  function isTruncated(content: string): boolean {
    return /\[truncated \d+ chars\]$/.test(content);
  }

  function isSnapshotTruncationMarker(message: { role: string; content: string }): boolean {
    return message.role === 'system' && /^\[\d+ earlier messages truncated\]$/.test(message.content);
  }
</script>

{#if groups.length === 0}
  <p class="empty">No conversation messages yet.</p>
{:else}
  <div class="conversation">
    {#each groups as group (group.turnIndex)}
      <div class="conversation-turn">
        <div class="conversation-turn-header">Turn {group.turnIndex + 1}</div>
        {#if group.messages.length === 0}
          <p class="empty-turn">No new messages in this turn.</p>
        {:else}
          {#each group.messages as message, messageIndex (messageIndex)}
            {#if isSnapshotTruncationMarker(message)}
              <div class="conversation-message" data-role="truncation-marker">
                <Badge variant="warning" label={message.content} size="xs" />
              </div>
            {:else if message.role === 'system'}
              <details class="conversation-message" data-role="system">
                <summary>System prompt</summary>
                <pre>{message.content}</pre>
                {#if isTruncated(message.content)}
                  <Badge variant="warning" label="truncated" size="xs" />
                {/if}
              </details>
            {:else if message.role === 'tool'}
              <details class="conversation-message" data-role="tool">
                <summary>Tool result{message.name ? ` · ${message.name}` : ''}</summary>
                {#if message.content}
                  <pre>{message.content}</pre>
                {/if}
                {#if message.toolResults && message.toolResults.length > 0}
                  {#each message.toolResults as result (result.toolCallId)}
                    <JsonViewer data={result} label={result.toolCallId} collapsed />
                  {/each}
                {/if}
                {#if isTruncated(message.content)}
                  <Badge variant="warning" label="truncated" size="xs" />
                {/if}
              </details>
            {:else}
              <div class="conversation-message" data-role={message.role}>
                <div class="conversation-message-role">{message.role}</div>
                <pre>{message.content}</pre>
                {#if message.toolCalls && message.toolCalls.length > 0}
                  <details>
                    <summary>{message.toolCalls.length} tool call(s)</summary>
                    {#each message.toolCalls as call (call.id)}
                      <JsonViewer data={call} label={call.name} collapsed />
                    {/each}
                  </details>
                {/if}
                {#if isTruncated(message.content)}
                  <Badge variant="warning" label="truncated" size="xs" />
                {/if}
              </div>
            {/if}
          {/each}
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .empty {
    margin: 0;
    padding: var(--space-2, 0.5rem) 0;
    color: var(--text-muted, #6b7280);
    font-size: var(--text-sm, 0.875rem);
  }

  .empty-turn {
    margin: 0;
    color: var(--text-muted, #6b7280);
    font-size: var(--text-xs, 0.75rem);
  }

  .conversation {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }

  .conversation-turn {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    border: 1px solid var(--border-muted, #e5e7eb);
    border-radius: var(--radius-md, 0.375rem);
    padding: var(--space-3, 0.75rem);
  }

  .conversation-turn-header {
    font-size: var(--text-xs, 0.75rem);
    font-weight: var(--font-medium, 500);
    color: var(--text-muted, #6b7280);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .conversation-message {
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
    padding: var(--space-2, 0.5rem);
    border-radius: var(--radius-sm, 0.25rem);
    background: var(--surface-inset, #f3f4f6);
    font-size: var(--text-sm, 0.875rem);
  }

  .conversation-message[data-role='user'] {
    background: var(--surface-accent, #eef2ff);
  }

  .conversation-message[data-role='assistant'] {
    background: var(--surface-inset, #f3f4f6);
  }

  .conversation-message-role {
    font-size: var(--text-xs, 0.75rem);
    font-weight: var(--font-medium, 500);
    color: var(--text-muted, #6b7280);
    text-transform: capitalize;
  }

  pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--font-mono, monospace);
    font-size: var(--text-xs, 0.75rem);
  }

  summary {
    cursor: pointer;
    font-size: var(--text-xs, 0.75rem);
    color: var(--text-muted, #6b7280);
  }
</style>
