export type ImportIntentOutcome<T> =
  | { readonly status: 'current'; readonly ok: true; readonly value: T }
  | { readonly status: 'current'; readonly ok: false; readonly error: unknown }
  | { readonly status: 'stale' };

export interface ImportIntent {
  run<T>(operation: () => Promise<T>): Promise<ImportIntentOutcome<T>>;
  invalidate(): void;
}

export function createImportIntent(
  onPendingChange?: (pending: boolean) => void,
): ImportIntent {
  let generation = 0;
  const notifyPending = (pending: boolean): void => {
    onPendingChange?.(pending);
  };

  return {
    invalidate(): void {
      generation += 1;
      notifyPending(false);
    },

    async run<T>(operation: () => Promise<T>): Promise<ImportIntentOutcome<T>> {
      const request = ++generation;
      notifyPending(true);
      try {
        const value = await operation();
        if (request !== generation) return { status: 'stale' };
        return { status: 'current', ok: true, value };
      } catch (error) {
        if (request !== generation) return { status: 'stale' };
        return { status: 'current', ok: false, error };
      } finally {
        if (request === generation) notifyPending(false);
      }
    },
  };
}
