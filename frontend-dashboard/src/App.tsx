import { useState } from "react";
import { api } from "./api/client";
import { AuthScreen } from "./components/AuthScreen";
import { ClusterHealth } from "./components/ClusterHealth";
import { GlassCard } from "./components/GlassCard";
import { JobExplorer } from "./components/JobExplorer";
import { Layout } from "./components/Layout";
import { QueueMatrix } from "./components/QueueMatrix";
import type { TabKey } from "./components/Sidebar";
import { ThroughputChart } from "./components/ThroughputChart";
import { useAuth } from "./hooks/useAuth";
import { usePolling } from "./hooks/usePolling";

const TITLES: Record<TabKey, string> = {
  overview: "Overview",
  queues: "Queues",
  jobs: "Job Explorer",
};

function App() {
  const { session, checking, login, signup, logout } = useAuth();
  const [tab, setTab] = useState<TabKey>("overview");

  const hasProject = session?.project != null;

  const { data: queuesData, refetch: refetchQueues } = usePolling(() => api.listQueues(), 5000, hasProject);
  const { data: workersData } = usePolling(() => api.listWorkers(), 5000, hasProject);
  const { data: metricsData } = usePolling(() => api.getMetrics(), 5000, hasProject);

  const queues = queuesData?.data ?? null;
  const workers = workersData?.data ?? null;
  const metrics = metricsData?.data ?? null;

  if (checking) {
    return <div className="flex min-h-screen items-center justify-center bg-sand text-olive-dark/60">Loading…</div>;
  }

  if (!session) {
    return <AuthScreen onLogin={login} onSignup={signup} />;
  }

  return (
    <Layout active={tab} onNavigate={setTab} title={TITLES[tab]} session={session} onLogout={logout}>
      {!hasProject ? (
        <GlassCard className="mx-auto max-w-md p-8 text-center">
          <h3 className="mb-2 text-lg font-semibold text-olive-dark">No project yet</h3>
          <p className="text-sm text-olive-dark/70">
            Your organization doesn't have a project set up. Create one via the API to start scheduling
            jobs.
          </p>
        </GlassCard>
      ) : tab === "overview" ? (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <ClusterHealth workers={workers} metrics={metrics} />
          <ThroughputChart metrics={metrics} />
        </div>
      ) : tab === "queues" ? (
        <QueueMatrix queues={queues} loading={!queuesData} onChanged={refetchQueues} />
      ) : (
        <JobExplorer queues={queues} />
      )}
    </Layout>
  );
}

export default App;
