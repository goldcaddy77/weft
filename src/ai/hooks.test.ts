import { describe, expect, it } from 'bun:test';
import { sleepForTesting } from '../testing/fake-timers.ts';

import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentHooks,
  BeforeTurnContext,
  BeforeTurnResult,
  BudgetWarningContext,
} from './hooks.ts';
import type { Message, ToolCall } from './providers/types.ts';

function createMessages(): Message[] {
  return [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello' },
  ];
}

function createToolCall(): ToolCall {
  return { id: 'call-1', name: 'search', input: { query: 'test' } };
}

describe('AgentHooks', () => {
  describe('beforeTurn', () => {
    it('with action continue passes messages through', () => {
      const messages = createMessages();
      const beforeTurn = (_context: BeforeTurnContext): BeforeTurnResult => {
        return { action: 'continue' };
      };

      const context: BeforeTurnContext = { turnIndex: 0, messages, model: 'gpt-4' };
      const result = beforeTurn(context);

      expect(result.action).toBe('continue');
      expect(result).not.toHaveProperty('messages');
    });

    it('with action continue and modified messages uses the modified version', () => {
      const originalMessages = createMessages();
      const modifiedMessages: Message[] = [
        ...originalMessages,
        { role: 'assistant', content: 'Injected message' },
      ];

      const beforeTurn = (_context: BeforeTurnContext): BeforeTurnResult => {
        return { action: 'continue', messages: modifiedMessages };
      };

      const context: BeforeTurnContext = {
        turnIndex: 1,
        messages: originalMessages,
        model: 'gpt-4',
      };
      const result = beforeTurn(context);

      expect(result.action).toBe('continue');
      if (result.action === 'continue') {
        expect(result.messages).toEqual(modifiedMessages);
        expect(result.messages).toHaveLength(3);
      }
    });

    it('with action skip skips the turn', () => {
      const beforeTurn = (_context: BeforeTurnContext): BeforeTurnResult => {
        return { action: 'skip', result: 'Skipped due to policy' };
      };

      const context: BeforeTurnContext = {
        turnIndex: 0,
        messages: createMessages(),
        model: 'gpt-4',
      };
      const result = beforeTurn(context);

      expect(result.action).toBe('skip');
      if (result.action === 'skip') {
        expect(result.result).toBe('Skipped due to policy');
      }
    });
  });

  describe('afterToolCall', () => {
    it('with action continue passes result through', () => {
      const afterToolCall = (_context: AfterToolCallContext): AfterToolCallResult => {
        return { action: 'continue' };
      };

      const context: AfterToolCallContext = {
        turnIndex: 0,
        toolCall: createToolCall(),
        result: { data: 'original' },
      };
      const result = afterToolCall(context);

      expect(result.action).toBe('continue');
      expect(result).not.toHaveProperty('result');
    });

    it('with action continue and modified result uses it', () => {
      const modifiedResult = { data: 'modified' };

      const afterToolCall = (_context: AfterToolCallContext): AfterToolCallResult => {
        return { action: 'continue', result: modifiedResult };
      };

      const context: AfterToolCallContext = {
        turnIndex: 0,
        toolCall: createToolCall(),
        result: { data: 'original' },
      };
      const result = afterToolCall(context);

      expect(result.action).toBe('continue');
      if (result.action === 'continue') {
        expect(result.result).toEqual(modifiedResult);
      }
    });

    it('with action reject rejects the result', () => {
      const afterToolCall = (_context: AfterToolCallContext): AfterToolCallResult => {
        return { action: 'reject', reason: 'Unsafe operation' };
      };

      const context: AfterToolCallContext = {
        turnIndex: 0,
        toolCall: createToolCall(),
        result: { data: 'dangerous' },
      };
      const result = afterToolCall(context);

      expect(result.action).toBe('reject');
      if (result.action === 'reject') {
        expect(result.reason).toBe('Unsafe operation');
      }
    });
  });

  describe('onBudgetWarning', () => {
    it('receives correct context', () => {
      let capturedContext: BudgetWarningContext | undefined;

      const onBudgetWarning = (context: BudgetWarningContext): void => {
        capturedContext = context;
      };

      const warningContext: BudgetWarningContext = {
        tokensRemaining: 5000,
        costRemaining: 1.5,
        budgetUsedPercent: 85,
      };

      onBudgetWarning(warningContext);

      expect(capturedContext).toBeDefined();
      expect(capturedContext!.tokensRemaining).toBe(5000);
      expect(capturedContext!.costRemaining).toBe(1.5);
      expect(capturedContext!.budgetUsedPercent).toBe(85);
    });
  });

  describe('all hooks are optional', () => {
    it('an empty hooks object is valid', () => {
      const hooks: AgentHooks = {};

      expect(hooks.beforeTurn).toBeUndefined();
      expect(hooks.afterToolCall).toBeUndefined();
      expect(hooks.onBudgetWarning).toBeUndefined();
    });
  });

  describe('async hooks', () => {
    it('beforeTurn works as async', async () => {
      const beforeTurn: NonNullable<AgentHooks['beforeTurn']> = async (
        _context: BeforeTurnContext,
      ): Promise<BeforeTurnResult> => {
        await sleepForTesting(1);
        return { action: 'continue', messages: [{ role: 'user', content: 'async' }] };
      };

      const context: BeforeTurnContext = {
        turnIndex: 0,
        messages: createMessages(),
        model: 'gpt-4',
      };
      const result = await beforeTurn(context);

      expect(result.action).toBe('continue');
      if (result.action === 'continue') {
        expect(result.messages).toHaveLength(1);
      }
    });

    it('afterToolCall works as async', async () => {
      const afterToolCall: NonNullable<AgentHooks['afterToolCall']> = async (
        _context: AfterToolCallContext,
      ): Promise<AfterToolCallResult> => {
        await sleepForTesting(1);
        return { action: 'reject', reason: 'async rejection' };
      };

      const context: AfterToolCallContext = {
        turnIndex: 0,
        toolCall: createToolCall(),
        result: 'something',
      };
      const result = await afterToolCall(context);

      expect(result.action).toBe('reject');
      if (result.action === 'reject') {
        expect(result.reason).toBe('async rejection');
      }
    });

    it('onBudgetWarning works as async', async () => {
      let called = false;

      const onBudgetWarning: NonNullable<AgentHooks['onBudgetWarning']> = async (
        _context: BudgetWarningContext,
      ): Promise<void> => {
        await sleepForTesting(1);
        called = true;
      };

      await onBudgetWarning({
        tokensRemaining: 100,
        costRemaining: 0.5,
        budgetUsedPercent: 95,
      });

      expect(called).toBe(true);
    });
  });
});
