import type { ChatOptions, LLMProvider } from './interface';
import type {
  ChatResponse,
  ChatResumeContext,
  ChatResumeHint,
  Message,
  StreamChunk,
} from './types';

export interface PendingChatResumeState {
  hint: ChatResumeHint;
  resumed: boolean;
  payload?: unknown;
}

export interface ConsumedSignalResult {
  found: boolean;
  payload?: unknown;
}

export interface SuspendingProviderCoordinator {
  load(turnIndex: number): Promise<PendingChatResumeState | undefined>;
  store(turnIndex: number, state: PendingChatResumeState): Promise<void>;
  clear(turnIndex: number): Promise<void>;
  consumeSignal?(resumeToken: string): Promise<ConsumedSignalResult>;
  waitForSignal?(resumeToken: string): Promise<unknown>;
  canSuspend?: boolean;
}

export class PendingProviderResumeError extends Error {
  readonly turnIndex: number;
  readonly hint: ChatResumeHint;

  constructor(turnIndex: number, hint: ChatResumeHint) {
    super(
      `Provider resume signal "${hint.resumeToken}" is required before turn ${String(turnIndex)}`,
    );
    this.name = 'PendingProviderResumeError';
    this.turnIndex = turnIndex;
    this.hint = hint;
  }
}

async function consumeOrAwaitResumePayload(
  coordinator: SuspendingProviderCoordinator,
  turnIndex: number,
  state: PendingChatResumeState,
): Promise<ChatResumeContext> {
  if (state.resumed) {
    return {
      hint: state.hint,
      payload: state.payload,
    };
  }

  if (coordinator.consumeSignal) {
    const signal = await coordinator.consumeSignal(state.hint.resumeToken);
    if (signal.found) {
      const resumedState = { ...state, resumed: true, payload: signal.payload };
      await coordinator.store(turnIndex, resumedState);
      return {
        hint: resumedState.hint,
        payload: resumedState.payload,
      };
    }
  }

  if (coordinator.canSuspend) {
    throw new PendingProviderResumeError(turnIndex, state.hint);
  }

  if (!coordinator.waitForSignal) {
    throw new Error('Suspending provider requires a signal consumer or waiter');
  }

  const payload = await coordinator.waitForSignal(state.hint.resumeToken);
  const resumedState = { ...state, resumed: true, payload };
  await coordinator.store(turnIndex, resumedState);
  return {
    hint: resumedState.hint,
    payload: resumedState.payload,
  };
}

async function resolveResumeContext(
  provider: LLMProvider,
  coordinator: SuspendingProviderCoordinator,
  messages: Message[],
  options: ChatOptions,
): Promise<ChatResumeContext | undefined> {
  if (options.turnIndex === undefined || provider.createChatResumeHint === undefined) {
    return undefined;
  }

  const existingState = await coordinator.load(options.turnIndex);
  if (existingState !== undefined) {
    return consumeOrAwaitResumePayload(coordinator, options.turnIndex, existingState);
  }

  const hint = await provider.createChatResumeHint(messages, options);
  if (hint === undefined) {
    return undefined;
  }

  if (coordinator.canSuspend) {
    throw new PendingProviderResumeError(options.turnIndex, hint);
  }

  const initialState: PendingChatResumeState = { hint, resumed: false };
  return consumeOrAwaitResumePayload(coordinator, options.turnIndex, initialState);
}

function withResumeContext(
  options: ChatOptions,
  resumeContext: ChatResumeContext | undefined,
): ChatOptions {
  if (resumeContext === undefined) {
    return options;
  }

  return {
    ...options,
    resumeContext,
  };
}

/**
 * Wrap an LLM provider so chat and stream calls can pause on an external
 * resume signal before the blocking provider fetch begins.
 */
export function createSuspendingProvider(
  provider: LLMProvider,
  coordinator: SuspendingProviderCoordinator,
): LLMProvider {
  return {
    name: provider.name,
    async chat(messages: Message[], options: ChatOptions): Promise<ChatResponse> {
      const resumeContext = await resolveResumeContext(provider, coordinator, messages, options);
      try {
        return await provider.chat(messages, withResumeContext(options, resumeContext));
      } finally {
        if (resumeContext !== undefined && options.turnIndex !== undefined) {
          await coordinator.clear(options.turnIndex);
        }
      }
    },
    async stream(messages: Message[], options: ChatOptions): Promise<ReadableStream<StreamChunk>> {
      const resumeContext = await resolveResumeContext(provider, coordinator, messages, options);
      try {
        return await provider.stream(messages, withResumeContext(options, resumeContext));
      } finally {
        if (resumeContext !== undefined && options.turnIndex !== undefined) {
          await coordinator.clear(options.turnIndex);
        }
      }
    },
    async countTokens(messages: Message[]): Promise<number> {
      return provider.countTokens(messages);
    },
    async createChatResumeHint(messages: Message[], options: ChatOptions) {
      return provider.createChatResumeHint?.(messages, options);
    },
    async warmup() {
      return provider.warmup?.();
    },
  };
}
