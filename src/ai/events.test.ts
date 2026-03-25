import { describe, expect, it } from 'bun:test';

import {
  AgentBudgetExceededEvent,
  AgentBudgetWarningEvent,
  AgentContextCompactedEvent,
  AgentModelFallbackEvent,
  AgentProviderCircuitOpenEvent,
  AgentToolCalledEvent,
  AgentToolReturnedEvent,
  AgentTurnCompletedEvent,
  AgentTurnStartedEvent,
  HumanReviewCompletedEvent,
  HumanReviewRequestedEvent,
} from './events';

describe('AgentTurnStartedEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const event = new AgentTurnStartedEvent('wf-1', 'agent-1', 0, 'claude-3-opus', 1500, 10);
    expect(event.workflowId).toBe('wf-1');
    expect(event.agentId).toBe('agent-1');
    expect(event.turnIndex).toBe(0);
    expect(event.model).toBe('claude-3-opus');
    expect(event.inputTokenEstimate).toBe(1500);
    expect(event.conversationLength).toBe(10);
  });

  it('has a matching static type and instance type', () => {
    const event = new AgentTurnStartedEvent('wf-1', 'agent-1', 0, 'model', 0, 0);
    expect(event.type).toBe(AgentTurnStartedEvent.type);
    expect(event.type).toBe('agent:turn:started');
  });

  it('is an instance of Event', () => {
    const event = new AgentTurnStartedEvent('wf-1', 'agent-1', 0, 'model', 0, 0);
    expect(event).toBeInstanceOf(Event);
  });
});

describe('AgentTurnCompletedEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const event = new AgentTurnCompletedEvent(
      'wf-2',
      'agent-2',
      1,
      'claude-3-opus',
      'claude-3-haiku',
      500,
      200,
      0.015,
      0.045,
      1200,
      3,
      1,
      'thinking step by step',
    );
    expect(event.workflowId).toBe('wf-2');
    expect(event.agentId).toBe('agent-2');
    expect(event.turnIndex).toBe(1);
    expect(event.model).toBe('claude-3-opus');
    expect(event.selectedModel).toBe('claude-3-haiku');
    expect(event.inputTokens).toBe(500);
    expect(event.outputTokens).toBe(200);
    expect(event.cost).toBe(0.015);
    expect(event.cumulativeCost).toBe(0.045);
    expect(event.duration).toBe(1200);
    expect(event.toolCallCount).toBe(3);
    expect(event.fallbackAttempts).toBe(1);
    expect(event.reasoningTrace).toBe('thinking step by step');
  });

  it('allows undefined reasoningTrace', () => {
    const event = new AgentTurnCompletedEvent(
      'wf-2',
      'agent-2',
      0,
      'model',
      'model',
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      undefined,
    );
    expect(event.reasoningTrace).toBeUndefined();
  });

  it('has a matching static type and instance type', () => {
    const event = new AgentTurnCompletedEvent(
      'wf-2',
      'agent-2',
      0,
      'model',
      'model',
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      undefined,
    );
    expect(event.type).toBe(AgentTurnCompletedEvent.type);
    expect(event.type).toBe('agent:turn:completed');
  });

  it('is an instance of Event', () => {
    const event = new AgentTurnCompletedEvent(
      'wf-2',
      'agent-2',
      0,
      'model',
      'model',
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      undefined,
    );
    expect(event).toBeInstanceOf(Event);
  });
});

describe('AgentToolCalledEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const event = new AgentToolCalledEvent(
      'wf-3',
      'agent-3',
      2,
      'readFile',
      { path: '/tmp/test' },
      'local',
      'op-1',
    );
    expect(event.workflowId).toBe('wf-3');
    expect(event.agentId).toBe('agent-3');
    expect(event.turnIndex).toBe(2);
    expect(event.toolName).toBe('readFile');
    expect(event.toolInput).toEqual({ path: '/tmp/test' });
    expect(event.source).toBe('local');
    expect(event.operationId).toBe('op-1');
  });

  it('accepts mcp as source', () => {
    const event = new AgentToolCalledEvent('wf-3', 'agent-3', 0, 'tool', {}, 'mcp', 'op-2');
    expect(event.source).toBe('mcp');
  });

  it('has a matching static type and instance type', () => {
    const event = new AgentToolCalledEvent('wf-3', 'agent-3', 0, 'tool', {}, 'local', 'op-1');
    expect(event.type).toBe(AgentToolCalledEvent.type);
    expect(event.type).toBe('agent:tool:called');
  });

  it('is an instance of Event', () => {
    const event = new AgentToolCalledEvent('wf-3', 'agent-3', 0, 'tool', {}, 'local', 'op-1');
    expect(event).toBeInstanceOf(Event);
  });
});

describe('AgentToolReturnedEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const event = new AgentToolReturnedEvent('wf-4', 'agent-4', 1, 'readFile', 250, true, 'op-3');
    expect(event.workflowId).toBe('wf-4');
    expect(event.agentId).toBe('agent-4');
    expect(event.turnIndex).toBe(1);
    expect(event.toolName).toBe('readFile');
    expect(event.duration).toBe(250);
    expect(event.success).toBe(true);
    expect(event.operationId).toBe('op-3');
  });

  it('tracks failure', () => {
    const event = new AgentToolReturnedEvent('wf-4', 'agent-4', 0, 'tool', 100, false, 'op-4');
    expect(event.success).toBe(false);
  });

  it('has a matching static type and instance type', () => {
    const event = new AgentToolReturnedEvent('wf-4', 'agent-4', 0, 'tool', 0, true, 'op-3');
    expect(event.type).toBe(AgentToolReturnedEvent.type);
    expect(event.type).toBe('agent:tool:returned');
  });

  it('is an instance of Event', () => {
    const event = new AgentToolReturnedEvent('wf-4', 'agent-4', 0, 'tool', 0, true, 'op-3');
    expect(event).toBeInstanceOf(Event);
  });
});

describe('AgentBudgetWarningEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const event = new AgentBudgetWarningEvent('wf-5', 'agent-5', 80, 5000, 0.5, 75);
    expect(event.workflowId).toBe('wf-5');
    expect(event.agentId).toBe('agent-5');
    expect(event.budgetUsedPercent).toBe(80);
    expect(event.tokensRemaining).toBe(5000);
    expect(event.costRemaining).toBe(0.5);
    expect(event.threshold).toBe(75);
  });

  it('has a matching static type and instance type', () => {
    const event = new AgentBudgetWarningEvent('wf-5', 'agent-5', 0, 0, 0, 0);
    expect(event.type).toBe(AgentBudgetWarningEvent.type);
    expect(event.type).toBe('agent:budget:warning');
  });

  it('is an instance of Event', () => {
    const event = new AgentBudgetWarningEvent('wf-5', 'agent-5', 0, 0, 0, 0);
    expect(event).toBeInstanceOf(Event);
  });
});

describe('AgentBudgetExceededEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const event = new AgentBudgetExceededEvent('wf-6', 'agent-6', 100000, 2.5, 80000, 2.0);
    expect(event.workflowId).toBe('wf-6');
    expect(event.agentId).toBe('agent-6');
    expect(event.tokensUsed).toBe(100000);
    expect(event.costUsed).toBe(2.5);
    expect(event.tokenBudget).toBe(80000);
    expect(event.maxCost).toBe(2.0);
  });

  it('has a matching static type and instance type', () => {
    const event = new AgentBudgetExceededEvent('wf-6', 'agent-6', 0, 0, 0, 0);
    expect(event.type).toBe(AgentBudgetExceededEvent.type);
    expect(event.type).toBe('agent:budget:exceeded');
  });

  it('is an instance of Event', () => {
    const event = new AgentBudgetExceededEvent('wf-6', 'agent-6', 0, 0, 0, 0);
    expect(event).toBeInstanceOf(Event);
  });
});

describe('AgentContextCompactedEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const event = new AgentContextCompactedEvent('wf-7', 'agent-7', 'summarize', 50000, 20000, 15);
    expect(event.workflowId).toBe('wf-7');
    expect(event.agentId).toBe('agent-7');
    expect(event.strategy).toBe('summarize');
    expect(event.tokensBefore).toBe(50000);
    expect(event.tokensAfter).toBe(20000);
    expect(event.messagesDropped).toBe(15);
  });

  it('has a matching static type and instance type', () => {
    const event = new AgentContextCompactedEvent('wf-7', 'agent-7', 'trim', 0, 0, 0);
    expect(event.type).toBe(AgentContextCompactedEvent.type);
    expect(event.type).toBe('agent:context:compacted');
  });

  it('is an instance of Event', () => {
    const event = new AgentContextCompactedEvent('wf-7', 'agent-7', 'trim', 0, 0, 0);
    expect(event).toBeInstanceOf(Event);
  });
});

describe('AgentModelFallbackEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const event = new AgentModelFallbackEvent(
      'wf-8',
      'agent-8',
      3,
      'claude-3-opus',
      'rate_limit',
      'claude-3-sonnet',
      1,
    );
    expect(event.workflowId).toBe('wf-8');
    expect(event.agentId).toBe('agent-8');
    expect(event.turnIndex).toBe(3);
    expect(event.failedModel).toBe('claude-3-opus');
    expect(event.failedReason).toBe('rate_limit');
    expect(event.nextModel).toBe('claude-3-sonnet');
    expect(event.attemptIndex).toBe(1);
  });

  it('has a matching static type and instance type', () => {
    const event = new AgentModelFallbackEvent('wf-8', 'agent-8', 0, 'm1', 'err', 'm2', 0);
    expect(event.type).toBe(AgentModelFallbackEvent.type);
    expect(event.type).toBe('agent:model:fallback');
  });

  it('is an instance of Event', () => {
    const event = new AgentModelFallbackEvent('wf-8', 'agent-8', 0, 'm1', 'err', 'm2', 0);
    expect(event).toBeInstanceOf(Event);
  });
});

describe('AgentProviderCircuitOpenEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const event = new AgentProviderCircuitOpenEvent('anthropic', 0.65, 0.5, 60000);
    expect(event.provider).toBe('anthropic');
    expect(event.errorRate).toBe(0.65);
    expect(event.threshold).toBe(0.5);
    expect(event.windowDuration).toBe(60000);
  });

  it('has a matching static type and instance type', () => {
    const event = new AgentProviderCircuitOpenEvent('provider', 0, 0, 0);
    expect(event.type).toBe(AgentProviderCircuitOpenEvent.type);
    expect(event.type).toBe('agent:provider:circuit-open');
  });

  it('is an instance of Event', () => {
    const event = new AgentProviderCircuitOpenEvent('provider', 0, 0, 0);
    expect(event).toBeInstanceOf(Event);
  });
});

describe('HumanReviewRequestedEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const event = new HumanReviewRequestedEvent('wf-9', 'review-1', 'approval', ['alice', 'bob']);
    expect(event.workflowId).toBe('wf-9');
    expect(event.reviewId).toBe('review-1');
    expect(event.reviewType).toBe('approval');
    expect(event.reviewers).toEqual(['alice', 'bob']);
  });

  it('has a matching static type and instance type', () => {
    const event = new HumanReviewRequestedEvent('wf-9', 'review-1', 'type', []);
    expect(event.type).toBe(HumanReviewRequestedEvent.type);
    expect(event.type).toBe('human-review:requested');
  });

  it('is an instance of Event', () => {
    const event = new HumanReviewRequestedEvent('wf-9', 'review-1', 'type', []);
    expect(event).toBeInstanceOf(Event);
  });
});

describe('HumanReviewCompletedEvent', () => {
  it('sets all properties from constructor arguments', () => {
    const event = new HumanReviewCompletedEvent('wf-10', 'review-2', 'approved', 'alice', 30000);
    expect(event.workflowId).toBe('wf-10');
    expect(event.reviewId).toBe('review-2');
    expect(event.decision).toBe('approved');
    expect(event.reviewer).toBe('alice');
    expect(event.duration).toBe(30000);
  });

  it('has a matching static type and instance type', () => {
    const event = new HumanReviewCompletedEvent('wf-10', 'review-2', 'rejected', 'bob', 0);
    expect(event.type).toBe(HumanReviewCompletedEvent.type);
    expect(event.type).toBe('human-review:completed');
  });

  it('is an instance of Event', () => {
    const event = new HumanReviewCompletedEvent('wf-10', 'review-2', 'rejected', 'bob', 0);
    expect(event).toBeInstanceOf(Event);
  });
});

describe('WeftAgentEventMap type coverage', () => {
  it('maps all event type strings to their respective classes', () => {
    expect(AgentTurnStartedEvent.type).toBe('agent:turn:started');
    expect(AgentTurnCompletedEvent.type).toBe('agent:turn:completed');
    expect(AgentToolCalledEvent.type).toBe('agent:tool:called');
    expect(AgentToolReturnedEvent.type).toBe('agent:tool:returned');
    expect(AgentBudgetWarningEvent.type).toBe('agent:budget:warning');
    expect(AgentBudgetExceededEvent.type).toBe('agent:budget:exceeded');
    expect(AgentContextCompactedEvent.type).toBe('agent:context:compacted');
    expect(AgentModelFallbackEvent.type).toBe('agent:model:fallback');
    expect(AgentProviderCircuitOpenEvent.type).toBe('agent:provider:circuit-open');
    expect(HumanReviewRequestedEvent.type).toBe('human-review:requested');
    expect(HumanReviewCompletedEvent.type).toBe('human-review:completed');
  });
});

describe('EventTarget integration', () => {
  it('dispatches AgentTurnStartedEvent to a typed listener', () => {
    const target = new EventTarget();
    let received: AgentTurnStartedEvent | null = null;

    target.addEventListener(AgentTurnStartedEvent.type, ((event: AgentTurnStartedEvent) => {
      received = event;
    }) as EventListener);

    const dispatched = new AgentTurnStartedEvent('wf-100', 'agent-100', 0, 'model', 500, 5);
    target.dispatchEvent(dispatched);

    expect(received).not.toBeNull();
    expect(received!.workflowId).toBe('wf-100');
    expect(received!.agentId).toBe('agent-100');
  });

  it('dispatches HumanReviewCompletedEvent with all properties', () => {
    const target = new EventTarget();
    let received: HumanReviewCompletedEvent | null = null;

    target.addEventListener(HumanReviewCompletedEvent.type, ((event: HumanReviewCompletedEvent) => {
      received = event;
    }) as EventListener);

    const dispatched = new HumanReviewCompletedEvent('wf-101', 'rev-1', 'approved', 'alice', 5000);
    target.dispatchEvent(dispatched);

    expect(received).not.toBeNull();
    expect(received!.decision).toBe('approved');
    expect(received!.reviewer).toBe('alice');
    expect(received!.duration).toBe(5000);
  });
});
