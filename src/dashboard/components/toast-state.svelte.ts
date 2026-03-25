export type ToastVariant = 'info' | 'success' | 'warning' | 'danger';

export type ToastAction = {
  label: string;
  onClick: () => void;
  dismissOnClick?: boolean;
};

export type ToastData = {
  id: string;
  message: string;
  title?: string;
  variant?: ToastVariant;
  duration?: number;
  dismissible?: boolean;
  action?: ToastAction;
  exiting?: boolean;
};

const DEFAULT_DURATION = 5000;
const MAX_TOASTS = 5;
const EXIT_ANIMATION_MS = 120;

class ToastStore {
  #toasts = $state<ToastData[]>([]);
  #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #idCounter = 0;

  get toasts(): ToastData[] {
    return this.#toasts;
  }

  addToast(data: Omit<ToastData, 'id'> & { id?: string }): string {
    let id: string = data.id ?? `toast-${++this.#idCounter}`;
    if (this.#toasts.some((item) => item.id === id)) {
      const base: string = data.id ?? 'toast';
      do {
        id = `${base}-${++this.#idCounter}`;
      } while (this.#toasts.some((item) => item.id === id));
    }

    const newToast: ToastData = {
      id,
      variant: data.variant ?? 'info',
      duration: data.duration ?? DEFAULT_DURATION,
      dismissible: data.dismissible ?? true,
      message: data.message,
      exiting: false,
      ...(data.title !== undefined && { title: data.title }),
      ...(data.action !== undefined && { action: data.action }),
    };

    if (this.#toasts.length >= MAX_TOASTS) {
      const oldest = this.#toasts[this.#toasts.length - 1];
      if (oldest) this.removeToast(oldest.id);
    }

    this.#toasts = [newToast, ...this.#toasts];

    if (newToast.duration && newToast.duration > 0) {
      this.#scheduleRemoval(id, newToast.duration);
    }

    return id;
  }

  removeToast(id: string): void {
    this.#clearTimer(id);
    this.#toasts = this.#toasts.filter((toast) => toast.id !== id);
  }

  startExit(id: string): void {
    const toast = this.#toasts.find((item) => item.id === id);
    if (!toast || toast.exiting) return;

    this.#clearTimer(id);
    this.#toasts = this.#toasts.map((item) => (item.id === id ? { ...item, exiting: true } : item));
    this.#timers.set(
      id,
      setTimeout(() => this.removeToast(id), EXIT_ANIMATION_MS),
    );
  }

  pauseTimer(id: string): void {
    this.#clearTimer(id);
  }

  resumeTimer(id: string, remainingTime: number): void {
    if (remainingTime > 0) {
      this.#scheduleRemoval(id, remainingTime);
    }
  }

  clear(): void {
    for (const id of this.#timers.keys()) {
      this.#clearTimer(id);
    }
    this.#toasts = [];
  }

  #scheduleRemoval(id: string, duration: number): void {
    this.#clearTimer(id);
    this.#timers.set(
      id,
      setTimeout(() => {
        this.startExit(id);
      }, duration),
    );
  }

  #clearTimer(id: string): void {
    const timer = this.#timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.#timers.delete(id);
    }
  }
}

export const toastStore = new ToastStore();
