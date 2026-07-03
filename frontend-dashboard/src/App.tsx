import { useState } from "react";
import { api } from "./api/client";
import { ClusterHealth } from "./components/ClusterHealth";
import { GlassCard } from "./components/GlassCard";
import { JobExplorer } from "./components/JobExplorer";
import { Layout } from "./components/Layout";
import { QueueMatrix } from "./components/QueueMatrix";
import type { TabKey } from "./components/Sidebar";
import { ThroughputChart } from "./components/ThroughputChart";
import { usePolling } from "./hooks/usePolling";
import { useSettings } from "./hooks/useSettings";
import { isConfigured } from "./settings";

const TITLES: Record<TabKey, string> = {
  overview: "Overview",
  queues: "Queues",
  jobs: "Job Explorer",
};

function App() {
  const { settings, update } = useSettings();
  const [tab, setTab] = useState<TabKey>("overview");
  const configured = isConfigured(settings);

  const { data: queuesData, refetch: refetchQueues } = usePolling(() => api.listQueues(), 5000, configured);
  const { data: workersData } = usePolling(() => api.listWorkers(), 5000, configured);
  const { data: metricsData } = usePolling(() => api.getMetrics(), 5000, configured);

  const queues = queuesData?.data ?? null;
  const workers = workersData?.data ?? null;
  const metrics = metricsData?.data ?? null;

  return (
    <Layout active={tab} onNavigate={setTab} title={TITLES[tab]} settings={settings} onSaveSettings={update}>
      {!configured ? (
        <GlassCard className="mx-auto max-w-md p-8 text-center">
          <h3 className="mb-2 text-lg font-semibold text-olive-dark">Connect a project</h3>
          <p className="text-sm text-olive-dark/70">
            Open <span className="font-medium">Connection settings</span> in the sidebar and paste in an
            organization and project id to load live data.
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
