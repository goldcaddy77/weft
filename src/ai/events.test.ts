import { describe, expect, it } from 'bun:test';

import {
  AgentCheckpointResumedEvent,
  AgentCheckpointSizeWarningEvent,
  AgentToolCalledEvent,
  AgentToolReturnedEvent,
  AgentTurnCompletedEvent,
  AgentTurnStartedEvent,
  ReviewCompletedEvent,
  ReviewRequestedEvent,
} from './events/index.ts';

describe('AgentTurnStartedEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const event = new AgentTurnStartedEvent('wf-1', 'agent-1', 0, 'claude-3-opus', 1500, 10);

    expect(event.type).toBe('agent:turn:started');
    expect(event.workflowId).toBe('wf-1');
    expect(event.agentId).toBe('agent-1');
    expect(event.turnIndex).toBe(0);
    expect(event.model).toBe('claude-3-opus');
    expect(event.inputTokenEstimate).toBe(1500);
    expect(event.conversationLength).toBe(10);
  });
});

describe('AgentTurnCompletedEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const event = new AgentTurnCompletedEvent(
      'wf-2',
      'agent-2',
      1,
      'claude-3-opus',
      500,
      200,
      1200,
      3,
      [],
    );

    expect(event.type).toBe('agent:turn:completed');
    expect(event.workflowId).toBe('wf-2');
    expect(event.agentId).toBe('agent-2');
    expect(event.turnIndex).toBe(1);
    expect(event.model).toBe('claude-3-opus');
    expect(event.inputTokens).toBe(500);
    expect(event.outputTokens).toBe(200);
    expect(event.duration).toBe(1200);
    expect(event.toolCallCount).toBe(3);
  });
});

describe('AgentToolCalledEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const input = { path: '/tmp/file.txt' };
    const event = new AgentToolCalledEvent(
      'wf-3',
      'agent-3',
      2,
      'readFile',
      input,
      'local',
      'op-1',
    );

    expect(event.type).toBe('agent:tool:called');
    expect(event.workflowId).toBe('wf-3');
    expect(event.agentId).toBe('agent-3');
    expect(event.turnIndex).toBe(2);
    expect(event.toolName).toBe('readFile');
    expect(event.toolInput).toBe(input);
    expect(event.source).toBe('local');
    expect(event.operationId).toBe('op-1');
  });
});

describe('AgentToolReturnedEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const event = new AgentToolReturnedEvent('wf-4', 'agent-4', 0, 'readFile', 250, true, 'op-2');

    expect(event.type).toBe('agent:tool:returned');
    expect(event.workflowId).toBe('wf-4');
    expect(event.agentId).toBe('agent-4');
    expect(event.turnIndex).toBe(0);
    expect(event.toolName).toBe('readFile');
    expect(event.duration).toBe(250);
    expect(event.success).toBe(true);
    expect(event.operationId).toBe('op-2');
  });
});

describe('ReviewRequestedEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const event = new ReviewRequestedEvent('wf-5', 'review-1', 'approval', ['alice', 'bob']);

    expect(event.type).toBe('human-review:requested');
    expect(event.workflowId).toBe('wf-5');
    expect(event.reviewId).toBe('review-1');
    expect(event.reviewType).toBe('approval');
    expect(event.reviewers).toEqual(['alice', 'bob']);
  });
});

describe('ReviewCompletedEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const event = new ReviewCompletedEvent('wf-6', 'review-2', 'approved', 'alice', 250);

    expect(event.type).toBe('human-review:completed');
    expect(event.workflowId).toBe('wf-6');
    expect(event.reviewId).toBe('review-2');
    expect(event.decision).toBe('approved');
    expect(event.reviewer).toBe('alice');
    expect(event.duration).toBe(250);
  });
});

describe('AgentCheckpointSizeWarningEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const event = new AgentCheckpointSizeWarningEvent('wf-7', 'agent-7', 123_456, 4);

    expect(event.type).toBe('agent:checkpoint-size-warning');
    expect(event.workflowId).toBe('wf-7');
    expect(event.agentId).toBe('agent-7');
    expect(event.sizeBytes).toBe(123_456);
    expect(event.turnIndex).toBe(4);
  });
});

describe('AgentCheckpointResumedEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const event = new AgentCheckpointResumedEvent('wf-8', 'agent-8', 3);

    expect(event.type).toBe('agent:checkpoint:resumed');
    expect(event.workflowId).toBe('wf-8');
    expect(event.agentId).toBe('agent-8');
    expect(event.duplicatesPrevented).toBe(3);
  });
});

describe('EventTarget integration', () => {
  it('dispatches AgentTurnStartedEvent to a typed listener', () => {
    const target = new EventTarget();
    const received: AgentTurnStartedEvent[] = [];
    target.addEventListener(AgentTurnStartedEvent.type, (event) => {
      received.push(event as AgentTurnStartedEvent);
    });

    target.dispatchEvent(new AgentTurnStartedEvent('wf-9', 'agent-9', 1, 'model', 0, 2));

    expect(received[0]).toBeInstanceOf(AgentTurnStartedEvent);
    const event = received[0]!;
    expect(event.workflowId).toBe('wf-9');
    expect(event.agentId).toBe('agent-9');
  });
});
