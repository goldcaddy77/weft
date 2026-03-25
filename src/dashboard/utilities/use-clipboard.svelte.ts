/** Reactive clipboard hook for Svelte 5. */
export function useClipboard(resetDelay = 2000) {
  let state = $state<'idle' | 'copied' | 'failed'>('idle');
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  async function copy(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      state = 'copied';

      if (timeoutId !== undefined) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        state = 'idle';
      }, resetDelay);

      return true;
    } catch {
      state = 'failed';

      if (timeoutId !== undefined) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        state = 'idle';
      }, resetDelay);

      return false;
    }
  }

  function destroy() {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }

  return {
    get state() {
      return state;
    },
    get isCopied() {
      return state === 'copied';
    },
    copy,
    destroy,
  };
}
