import { useEffect, useRef, useState } from "react";

interface PollingState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
}

/** Simple polling data hook: refetches on an interval, plus a manual refetch() for after mutations. */
export function usePolling<T>(fetcher: () => Promise<T>, intervalMs: number, active = true) {
  const [state, setState] = useState<PollingState<T>>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    async function run() {
      try {
        const data = await fetcherRef.current();
        if (!cancelled) setState({ data, error: null, loading: false });
      } catch (err) {
        if (!cancelled) {
          setState((prev) => ({
            data: prev.data,
            error: err instanceof Error ? err : new Error(String(err)),
            loading: false,
          }));
        }
      }
    }

    run();
    const id = setInterval(run, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs, active, tick]);

  return { ...state, refetch: () => setTick((t) => t + 1) };
}
