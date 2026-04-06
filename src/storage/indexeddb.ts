import type { BatchOperation, ScanOptions, Storage } from './interface';

const STORE_NAME = 'kv';

/** Wrap an IDBRequest in a Promise, resolving on success and rejecting on error. */
function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    /* c8 ignore next -- IndexedDB request failures require injected browser storage faults */
    request.onerror = () => reject(request.error);
  });
}

export class IndexedDBStorage implements Storage {
  #databaseName: string;
  #database: IDBDatabase | null = null;
  #databasePromise: Promise<IDBDatabase>;

  constructor(databaseName: string = 'weft') {
    this.#databaseName = databaseName;
    this.#databasePromise = this.#open();
  }

  #open(): Promise<IDBDatabase> {
    const request = indexedDB.open(this.#databaseName, 1);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };

    return promisify(request).then((database) => {
      this.#database = database;
      return database;
    });
  }

  async get(key: string): Promise<Uint8Array | null> {
    const database = await this.#databasePromise;
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const result = await promisify(store.get(key));
    return result === undefined ? null : new Uint8Array(result);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    const database = await this.#databasePromise;
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    await promisify(store.put(value, key));
  }

  async delete(key: string): Promise<void> {
    const database = await this.#databasePromise;
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    await promisify(store.delete(key));
  }

  async *scan(prefix: string, options: ScanOptions = {}): AsyncIterable<[string, Uint8Array]> {
    const { limit, reverse, gt, lt, gte, lte } = options;
    const database = await this.#databasePromise;

    // Compute the exclusive upper bound for the prefix range.
    // When prefix is empty, use '\xff' to match all keys since all valid string keys sort before it.
    const prefixEnd =
      prefix.length > 0
        ? prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
        : '\xff';

    const range = IDBKeyRange.bound(prefix, prefixEnd, false, true);
    const direction: IDBCursorDirection = reverse ? 'prev' : 'next';

    const transaction = database.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.openCursor(range, direction);

    let count = 0;

    // Pull-based async cursor iteration: each step resolves a promise.
    let resolveCurrent: ((value: IDBCursorWithValue | null) => void) | null = null;

    request.onsuccess = () => {
      if (resolveCurrent) {
        resolveCurrent(request.result);
      }
    };

    const nextCursor = (): Promise<IDBCursorWithValue | null> => {
      return new Promise<IDBCursorWithValue | null>((resolve) => {
        resolveCurrent = resolve;
        // The initial onsuccess may have already fired before we attached resolveCurrent.
        if (request.readyState === 'done') {
          resolve(request.result);
        }
      });
    };

    // Track whether iteration ran to completion so we can abort the transaction
    // on early termination (e.g., consumer breaks out of the loop), releasing the cursor.
    let completed = false;
    try {
      // Get the first cursor position
      let cursor = await nextCursor();

      while (cursor) {
        if (limit !== undefined && count >= limit) break;

        const key = cursor.key as string;

        // Apply bound filters
        let include = true;
        if (gt !== undefined && key <= gt) include = false;
        if (gte !== undefined && key < gte) include = false;
        if (lt !== undefined && key >= lt) include = false;
        if (lte !== undefined && key > lte) include = false;

        if (include) {
          yield [key, new Uint8Array(cursor.value)];
          count++;
        }

        // Advance the cursor
        cursor.continue();
        cursor = await new Promise<IDBCursorWithValue | null>((resolve) => {
          resolveCurrent = resolve;
        });
      }

      completed = true;
    } finally {
      if (!completed) {
        try {
          transaction.abort();
        } catch {
          // Transaction may already be finished
        }
      }
    }
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    if (operations.length === 0) return;

    const database = await this.#databasePromise;
    return new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      for (const operation of operations) {
        if (operation.type === 'put') {
          store.put(operation.value, operation.key);
        } else {
          store.delete(operation.key);
        }
      }

      transaction.oncomplete = () => resolve();
      /* c8 ignore next -- transaction failure requires injected IndexedDB write faults */
      transaction.onerror = () => reject(transaction.error);
    });
  }

  [Symbol.dispose](): void {
    if (this.#database) {
      this.#database.close();
      this.#database = null;
    }
  }
}
