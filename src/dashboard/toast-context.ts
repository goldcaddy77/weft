export interface Toast {
  id: string;
  message: string;
  variant: 'info' | 'success' | 'error';
}

export interface ToastContext {
  toasts: Toast[];
  addToast: (message: string, variant?: 'info' | 'success' | 'error') => void;
  dismissToast: (id: string) => void;
}
