import { useEffect, useRef, useState } from "react";
import { loadSession } from "../auth";
import type { Metrics, Worker } from "../types";

export interface LiveSnapshot {
  workers: Worker[];
  metrics: Metrics;
}

const RECONNECT_DELAY_MS = 3000;

/** Derives a ws(s):// base from VITE_API_BASE_URL (e.g. https://x.onrender.com/api -> wss://x.onrender.com), unless VITE_WS_BASE_URL is set explicitly. */
function resolveWsBaseUrl(): string {
  const explicit = import.meta.env.VITE_WS_BASE_URL as string | undefined;
  if (explicit) return explicit;
  const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:4000/api";
  return apiBase.replace(/^http/, "ws").replace(/\/api\/?$/, "");
}

/**
 * Live counterpart to the Overview tab's usePolling(listWorkers/getMetrics)
 * calls -- opens one WebSocket to backend-api's /ws endpoint (see
 * backend-api/src/ws/liveServer.ts) and reconnects with a fixed delay if it
 * drops. Deliberately additive, not a replacement: App.tsx keeps its
 * existing HTTP polling running underneath and only prefers this hook's
 * `snapshot` while `connected` is true, so a WS outage (or an
 * environment that never configured VITE_WS_BASE_URL/CORS for it) silently
 * falls back to the polling data that was already there before this existed.
 */
export function useLiveOverview(active: boolean) {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!active) return;
    const session = loadSession();
    if (!session?.project) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (cancelled) return;
      const base = resolveWsBaseUrl();
      const url = `${base}/ws?token=${encodeURIComponent(session!.token)}&projectId=${encodeURIComponent(session!.project!.id)}`;

      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        retryTimer = setTimeout(connect, RECONNECT_DELAY_MS);
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as { type: string; data: LiveSnapshot };
          if (msg.type === "snapshot") setSnapshot(msg.data);
        } catch {
          // Malformed frame -- ignore, the next push corrects it.
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (!cancelled) retryTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      };

      ws.onerror = () => ws.close();
    }

    connect();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      wsRef.current?.close();
    };
  }, [active]);

  return { snapshot, connected };
}
