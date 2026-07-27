import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  AreaChart,
  Area,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";
import type { ChartSpec } from "@/lib/scholar/store";

const COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
];

export function ChartView({ spec }: { spec: ChartSpec }) {
  // Margins must leave room for: axis tick labels, the rotated yLabel on the
  // left, and the xLabel below the x-axis ticks. Without these the labels get
  // clipped and the chart appears to have "no axes".
  const margin = {
    top: 12,
    right: 24,
    bottom: spec.xLabel ? 44 : 24,
    left: spec.yLabel ? 24 : 8,
  };
  const common = (
    <>
      <CartesianGrid stroke="var(--mono-grid)" strokeDasharray="3 3" />
      <XAxis
        dataKey={spec.xKey}
        stroke="var(--color-muted-foreground)"
        tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
        label={
          spec.xLabel
            ? {
                value: spec.xLabel,
                position: "insideBottom",
                offset: -8,
                fill: "var(--color-foreground)",
                fontSize: 12,
              }
            : undefined
        }
      />
      <YAxis
        stroke="var(--color-muted-foreground)"
        tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
        label={
          spec.yLabel
            ? {
                value: spec.yLabel,
                angle: -90,
                position: "insideLeft",
                offset: 10,
                style: { textAnchor: "middle" },
                fill: "var(--color-foreground)",
                fontSize: 12,
              }
            : undefined
        }
      />
      <Tooltip
        contentStyle={{
          background: "var(--color-popover)",
          border: "1px solid var(--color-border)",
          borderRadius: "0.5rem",
          fontSize: 12,
        }}
      />
      <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
    </>
  );

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        {spec.chartType === "line" ? (
          <LineChart data={spec.data} margin={margin}>
            {common}
            {spec.yKeys.map((k, i) => (
              <Line
                key={k}
                dataKey={k}
                stroke={COLORS[i % COLORS.length]}
                strokeWidth={2}
                dot={false}
              />
            ))}
          </LineChart>
        ) : spec.chartType === "bar" ? (
          <BarChart data={spec.data} margin={margin}>
            {common}
            {spec.yKeys.map((k, i) => (
              <Bar key={k} dataKey={k} fill={COLORS[i % COLORS.length]} />
            ))}
          </BarChart>
        ) : spec.chartType === "area" ? (
          <AreaChart data={spec.data} margin={margin}>
            {common}
            {spec.yKeys.map((k, i) => (
              <Area
                key={k}
                dataKey={k}
                stroke={COLORS[i % COLORS.length]}
                fill={COLORS[i % COLORS.length]}
                fillOpacity={0.25}
              />
            ))}
          </AreaChart>
        ) : (
          <ScatterChart margin={margin}>
            {common}
            {spec.yKeys.map((k, i) => (
              <Scatter key={k} data={spec.data} dataKey={k} fill={COLORS[i % COLORS.length]} />
            ))}
          </ScatterChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
