interface State {
  version: 1;
  maxCalls: number;
  calls: number;
  entries: Record<string, { done: boolean; value?: unknown }>;
}
export interface ModelCallBudget {
  run(key: string, send: () => Promise<unknown>): Promise<unknown>;
}

/** A request is reserved before sending; restarts reuse completed responses, never reset a cap. */
export function createModelCallBudget(file: string, maxCalls: number): ModelCallBudget {
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 100)
    throw new Error("Set an explicit model request limit from 1 to 100.");
  return {
    run: async (key, send) => {
      // Loaded on the first request, so that importing `@tender/agents` loads no payment code.
      const { lockedState } = await import("@tender/payments");
      return lockedState<State>(file, async (read, save) => {
        const state = (await read()) ?? { version: 1, maxCalls, calls: 0, entries: {} };
        if (
          state.version !== 1 ||
          state.maxCalls !== maxCalls ||
          !Number.isSafeInteger(state.calls) ||
          state.calls < 0 ||
          state.calls > maxCalls ||
          !state.entries ||
          Object.keys(state.entries).length !== state.calls
        )
          throw new Error("Model budget changed or is invalid; review it before more requests.");
        if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid model request identity.");
        const old = state.entries[key];
        if (old?.done) return old.value;
        if (old)
          throw new Error(
            "A previous model call has an uncertain outcome; it will not be repeated automatically.",
          );
        if (state.calls >= maxCalls) throw new Error("Model request budget exhausted.");
        state.calls += 1;
        state.entries[key] = { done: false };
        await save(state);
        const value = await send();
        state.entries[key] = { done: true, value };
        await save(state);
        return value;
      });
    },
  };
}
