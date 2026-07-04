import { useState } from "react";
import { api, projectsApi } from "./api/client";
import { AuthScreen } from "./components/AuthScreen";
import { ClusterHealth } from "./components/ClusterHealth";
import { GlassCard } from "./components/GlassCard";
import { JobExplorer } from "./components/JobExplorer";
import { Layout } from "./components/Layout";
import { QueueMatrix } from "./components/QueueMatrix";
import type { TabKey } from "./components/Sidebar";
import { ThroughputChart } from "./components/ThroughputChart";
import { useAuth } from "./hooks/useAuth";
import { useLiveOverview } from "./hooks/useLiveOverview";
import { usePolling } from "./hooks/usePolling";

const TITLES: Record<TabKey, string> = {
  overview: "Overview",
  queues: "Queues",
  jobs: "Job Explorer",
};

function NoProjectCard({ onCreated }: { onCreated: (project: { id: string; name: string }) => void }) {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const res = await projectsApi.create(name.trim());
      onCreated({ id: res.data.id, name: res.data.name });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <GlassCard className="mx-auto max-w-md p-8 text-center">
      <h3 className="mb-2 text-lg font-semibold text-olive-dark">No project yet</h3>
      <p className="mb-4 text-sm text-olive-dark/70">
        Your organization doesn't have a project set up yet. Create one to start scheduling jobs.
      </p>
      <div className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Project name"
          className="min-w-0 flex-1 rounded-lg border border-olive-dark/20 bg-white/80 px-3 py-2 text-sm"
        />
        <button
          onClick={handleCreate}
          disabled={creating || !name.trim()}
          className="btn-press shrink-0 rounded-lg bg-olive px-4 py-2 text-sm font-medium text-white transition hover:bg-olive-dark disabled:opacity-50"
        >
          {creating ? "Creating…" : "Create project"}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-terracotta">{error}</p>}
    </GlassCard>
  );
}

function App() {
  const { session, checking, login, signup, loginWithGoogle, logout, switchProject } = useAuth();
  const [tab, setTab] = useState<TabKey>("overview");

  const hasProject = session?.project != null;

  const {
    data: queuesData,
    error: queuesError,
    refetch: refetchQueues,
  } = usePolling(() => api.listQueues(), 5000, hasProject);
  const { data: workersData, error: workersError } = usePolling(() => api.listWorkers(), 5000, hasProject);
  const { data: metricsData, error: metricsError } = usePolling(() => api.getMetrics(), 5000, hasProject);
  // Live push channel for the Overview tab; falls back to the polled data
  // above whenever it isn't connected (fresh page load, a dropped socket
  // mid-reconnect, or an environment that hasn't wired up WS at all).
  const { snapshot: liveSnapshot, connected: liveConnected } = useLiveOverview(hasProject);

  const queues = queuesData?.data ?? null;
  const workers = liveConnected && liveSnapshot ? liveSnapshot.workers : (workersData?.data ?? null);
  const metrics = liveConnected && liveSnapshot ? liveSnapshot.metrics : (metricsData?.data ?? null);
  const pollingError = queuesError ?? workersError ?? metricsError;

  if (checking) {
    return <div className="flex min-h-screen items-center justify-center bg-sand text-olive-dark/60">Loading…</div>;
  }

  if (!session) {
    return <AuthScreen onLogin={login} onSignup={signup} onGoogleLogin={loginWithGoogle} />;
  }

  return (
    <Layout
      active={tab}
      onNavigate={setTab}
      title={TITLES[tab]}
      session={session}
      onLogout={logout}
      onSwitchProject={switchProject}
    >
      {hasProject && pollingError && (
        <p className="mb-4 rounded-lg bg-terracotta-light/60 px-4 py-2 text-sm text-olive-dark">
          Couldn't refresh: {pollingError.message}. Showing the last data loaded successfully.
        </p>
      )}
      {!hasProject ? (
        <NoProjectCard onCreated={switchProject} />
      ) : tab === "overview" ? (
        <div className="stagger grid grid-cols-1 gap-6 xl:grid-cols-2">
          <ClusterHealth workers={workers} metrics={metrics} live={liveConnected} />
          <ThroughputChart metrics={metrics} />
        </div>
      ) : tab === "queues" ? (
        <QueueMatrix queues={queues} loading={!queuesData} role={session.role} onChanged={refetchQueues} />
      ) : (
        <JobExplorer queues={queues} />
      )}
    </Layout>
  );
}

export default App;
