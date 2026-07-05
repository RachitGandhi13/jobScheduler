import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import type { Metrics } from "../types";
import { GlassCard } from "./GlassCard";

// Deepened variants of the brand's sage/terracotta/slate hues, validated for
// categorical use with scripts/validate_palette.js from the dataviz skill.
// The brand's exact soft tones (#C0CFC0/#E5CEC6/#DDA28F) read as near-gray at
// low chroma and fail CVD separation (protan ΔE 1.9) -- fine for backgrounds
// and badges, not for a chart where color alone carries meaning. This trio
// passes lightness/chroma/contrast; CVD sits in the 8-12 floor band, so
// direct value labels + a legend are shipped alongside (never color-only).
const ACTIVE_COLOR = "#33578F";
const COMPLETED_COLOR = "#398048";
const FAILED_COLOR = "#C97B4A";

interface ThroughputChartProps {
  metrics: Metrics | null;
}

export function ThroughputChart({ metrics }: ThroughputChartProps) {
  const active =
    (metrics?.jobCounts.queued ?? 0) +
    (metrics?.jobCounts.scheduled ?? 0) +
    (metrics?.jobCounts.claimed ?? 0) +
    (metrics?.jobCounts.running ?? 0);
  const completed = metrics?.jobCounts.completed ?? 0;
  const failed = metrics?.jobCounts.failed ?? 0;
  const total = active + completed + failed;

  const data = [
    { name: "Active", value: active, color: ACTIVE_COLOR },
    { name: "Completed", value: completed, color: COMPLETED_COLOR },
    { name: "Failed", value: failed, color: FAILED_COLOR },
  ];

  return (
    <GlassCard className="p-5 md:p-6">
      <h3 className="mb-1 text-sm font-semibold text-olive-dark">Throughput distribution</h3>
      <p className="mb-4 text-xs text-olive-dark/60">Job run states across all queues in this project</p>

      {total === 0 ? (
        <div className="flex h-64 flex-col items-center justify-center gap-3 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-olive/[0.08]">
            <span aria-hidden="true" className="h-5 w-5 rounded-full border-[3px] border-olive/30 border-t-sage" />
          </span>
          <div>
            <p className="text-sm font-medium text-olive-dark/70">No jobs yet</p>
            <p className="mx-auto mt-1 max-w-[230px] text-xs leading-relaxed text-olive-dark/45">
              Throughput appears here the moment your first job runs.
            </p>
          </div>
        </div>
      ) : (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                dataKey="value"
                nameKey="name"
                innerRadius="55%"
                outerRadius="85%"
                paddingAngle={2}
                strokeWidth={2}
                stroke="#f6f1e7"
                label={({ name, value }) => (value ? `${name}: ${value}` : "")}
                labelLine={false}
              >
                {data.map((entry) => (
                  <Cell key={entry.name} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip
                formatter={(value, name) => {
                  const count = typeof value === "number" ? value : 0;
                  const pct = total > 0 ? ((count / total) * 100).toFixed(0) : "0";
                  return [`${count} (${pct}%)`, String(name)];
                }}
                contentStyle={{
                  background: "rgba(255,255,255,0.9)",
                  border: "1px solid rgba(255,255,255,0.6)",
                  borderRadius: 12,
                  fontSize: 12,
                }}
              />
              <Legend verticalAlign="bottom" height={32} iconType="circle" wrapperStyle={{ fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}
    </GlassCard>
  );
}
