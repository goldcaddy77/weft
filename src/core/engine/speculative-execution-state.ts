import type { CheckpointCommitSideEffects } from './checkpoint-side-effects.ts';

export class SpeculativeExecutionState {
  readonly #verifications: Array<Promise<{ failed: false } | { failed: true; error: unknown }>>;
  readonly #compensations: Array<() => Promise<void>>;
  readonly #checkpointCommitSideEffects: CheckpointCommitSideEffects[];

  constructor() {
    this.#verifications = [];
    this.#compensations = [];
    this.#checkpointCommitSideEffects = [];
  }

  recordVerification(verification: Promise<void>): void {
    this.#verifications.push(
      verification.then(
        () => ({ failed: false as const }),
        (error) => ({ failed: true as const, error }),
      ),
    );
  }

  recordCompensation(compensation: () => Promise<void>): void {
    this.#compensations.push(compensation);
  }

  recordCheckpointCommitSideEffects(sideEffects: CheckpointCommitSideEffects): void {
    this.#checkpointCommitSideEffects.push({
      conditions: [...sideEffects.conditions],
      operations: [...sideEffects.operations],
    });
  }

  takeCheckpointCommitSideEffects(): CheckpointCommitSideEffects[] {
    const sideEffects = this.#checkpointCommitSideEffects.splice(0);
    return sideEffects.map((entry) => ({
      conditions: [...entry.conditions],
      operations: [...entry.operations],
    }));
  }

  async drainVerifications(): Promise<void> {
    const outcomes = await Promise.all(this.#verifications);
    const failure = outcomes.find((outcome) => outcome.failed);
    if (failure) {
      throw failure.error;
    }
  }

  async rollback(): Promise<void> {
    for (let index = this.#compensations.length - 1; index >= 0; index--) {
      try {
        await this.#compensations[index]!();
      } catch {
        // Best-effort rollback continues through failed compensations.
      }
    }
    await Promise.all(this.#verifications);
  }
}
