/**
 * In-memory min-heap that tracks inflight task deadlines.
 *
 * Used by the visibility timeout scanner to avoid a full storage scan
 * on every tick. The scanner pops expired entries from the heap instead
 * of iterating all `op:inflight:*` records.
 *
 * @module server/deadline-tracker
 */

/** A single tracked deadline entry. */
export type DeadlineEntry = {
  operationId: string;
  deadline: number;
};

/**
 * Min-heap ordered by deadline. Supports O(log n) insert/remove-min
 * and O(1) peek at the earliest deadline.
 */
export class DeadlineTracker {
  readonly #heap: DeadlineEntry[] = [];

  /** Number of tracked deadlines. */
  get size(): number {
    return this.#heap.length;
  }

  /** Peek at the earliest deadline without removing it. Returns `undefined` if empty. */
  peekDeadline(): number | undefined {
    return this.#heap[0]?.deadline;
  }

  /** Add a new deadline entry. */
  add(entry: DeadlineEntry): void {
    this.#heap.push(entry);
    this.#siftUp(this.#heap.length - 1);
  }

  /** Remove and return the entry with the earliest deadline, or `undefined` if empty. */
  popMin(): DeadlineEntry | undefined {
    if (this.#heap.length === 0) return undefined;
    const min = this.#heap[0]!;
    const last = this.#heap.pop()!;
    if (this.#heap.length > 0) {
      this.#heap[0] = last;
      this.#siftDown(0);
    }
    return min;
  }

  /** Remove all entries matching the given operation ID. */
  remove(operationId: string): void {
    const filtered = this.#heap.filter((e) => e.operationId !== operationId);
    this.#heap.splice(0, this.#heap.length, ...filtered);
    this.#buildHeap();
  }

  /** Drain all entries whose deadline is at or before `now`. */
  drainExpired(now: number): DeadlineEntry[] {
    const expired: DeadlineEntry[] = [];
    while (this.#heap.length > 0 && this.#heap[0]!.deadline <= now) {
      expired.push(this.popMin()!);
    }
    return expired;
  }

  /** Remove all entries. */
  clear(): void {
    this.#heap.length = 0;
  }

  #siftUp(index: number): void {
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (this.#heap[parent]!.deadline <= this.#heap[index]!.deadline) break;
      [this.#heap[parent], this.#heap[index]] = [this.#heap[index]!, this.#heap[parent]!];
      index = parent;
    }
  }

  #siftDown(index: number): void {
    const length = this.#heap.length;
    while (true) {
      let smallest = index;
      const left = 2 * index + 1;
      const right = 2 * index + 2;
      if (left < length && this.#heap[left]!.deadline < this.#heap[smallest]!.deadline) {
        smallest = left;
      }
      if (right < length && this.#heap[right]!.deadline < this.#heap[smallest]!.deadline) {
        smallest = right;
      }
      if (smallest === index) break;
      [this.#heap[smallest], this.#heap[index]] = [this.#heap[index]!, this.#heap[smallest]!];
      index = smallest;
    }
  }

  #buildHeap(): void {
    for (let i = (this.#heap.length >>> 1) - 1; i >= 0; i--) {
      this.#siftDown(i);
    }
  }
}
