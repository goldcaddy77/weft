export interface WorkerTurnState {
  worker: Worker;
  workflowId: string;
  turnId: number;
  kind: 'run' | 'resume';
}

interface TrackedWorkerTurn extends WorkerTurnState {
  timeout: ReturnType<typeof setTimeout> | null;
}

export class WorkerTurnWatchdog {
  readonly #turnsByWorker = new Map<Worker, TrackedWorkerTurn>();
  readonly #timeoutMs: number | undefined;
  readonly #onTimeout: (turn: WorkerTurnState) => void;

  constructor(timeoutMs: number | undefined, onTimeout: (turn: WorkerTurnState) => void) {
    this.#timeoutMs = timeoutMs;
    this.#onTimeout = onTimeout;
  }

  begin(worker: Worker, workflowId: string, turnId: number, kind: WorkerTurnState['kind']): void {
    this.clear(worker);
    const turn: TrackedWorkerTurn = {
      worker,
      workflowId,
      turnId,
      kind,
      timeout: null,
    };

    if (this.#timeoutMs !== undefined) {
      turn.timeout = setTimeout(() => {
        if (this.#turnsByWorker.get(worker) === turn) {
          this.#onTimeout(turn);
        }
      }, this.#timeoutMs);
    }

    this.#turnsByWorker.set(worker, turn);
  }

  clear(worker: Worker): void {
    const turn = this.#turnsByWorker.get(worker);
    if (!turn) return;
    if (turn.timeout !== null) {
      clearTimeout(turn.timeout);
    }
    this.#turnsByWorker.delete(worker);
  }

  clearAll(): void {
    for (const worker of this.#turnsByWorker.keys()) {
      this.clear(worker);
    }
  }

  get(worker: Worker): WorkerTurnState | undefined {
    return this.#turnsByWorker.get(worker);
  }
}
