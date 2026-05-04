import type { ScheduleSummary } from '../core/types.ts';
import type { HttpClient } from './http-client.ts';
import type { ClientScheduleHandle } from './interface.ts';

export class HttpScheduleHandle implements ClientScheduleHandle {
  readonly id: string;
  readonly #client: HttpClient;

  constructor(id: string, client: HttpClient) {
    this.id = id;
    this.#client = client;
  }

  async pause(): Promise<void> {
    return this.#client.pauseSchedule(this.id);
  }

  async resume(): Promise<void> {
    return this.#client.resumeSchedule(this.id);
  }

  async cancel(): Promise<void> {
    return this.#client.cancelSchedule(this.id);
  }

  async update(newCronExpression: string): Promise<void> {
    return this.#client.updateSchedule(this.id, newCronExpression);
  }

  async describe(): Promise<ScheduleSummary | null> {
    return this.#client.getSchedule(this.id);
  }

  [Symbol.dispose](): void {
    // HTTP schedule handles do not hold long-lived resources.
  }
}
