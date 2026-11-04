import { useState } from "react";

// Small dependency-free SVG charts for the leadership pages. Colours come from
// the shared palette so every project keeps one colour across charts.
export const SERIES_COLORS = [
  "#376b58",
  "#48658e",
  "#866830",
  "#80608e",
  "#9b6250",
  "#5f7f86",
];
export const seriesColor = (index: number) =>
  SERIES_COLORS[index % SERIES_COLORS.length]!;

const shortDate = (date: string) =>
  `${Number(date.slice(5, 7))}/${Number(date.slice(8))}`;

export function Sparkline({
  values,
  color = "var(--accent)",
  label,
}: {
  values: number[];
  color?: string;
  label: string;
}) {
  const max = Math.max(1, ...values);
  const width = 84;
  const height = 28;
  const gap = 3;
  const bar = (width - gap * (values.length - 1)) / values.length;
  return (
    <svg
      className="lc-spark"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
    >
      {values.map((value, i) => {
        const h = value ? Math.max(3, (value / max) * height) : 1.5;
        return (
          <rect
            key={i}
            x={i * (bar + gap)}
            y={height - h}
            width={bar}
            height={h}
            rx={1.5}
            fill={value ? color : "var(--line)"}
          />
        );
      })}
    </svg>
  );
}

const NICE_STEPS = [
  1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100, 150, 200,
  300, 500, 1000,
];

export function LineChart({
  categories,
  series: allSeries,
  label,
  xTitle,
  yTitle,
  formatCategory,
  formatTip,
  onSelect,
  hint = "移动到图上查看具体数值",
}: {
  categories: string[];
  series: Array<{ name: string; color: string; values: number[] }>;
  label: string;
  xTitle: string;
  yTitle: string;
  formatCategory: (value: string) => string;
  formatTip: (value: string) => string;
  /** Clicking a point selects its category, for drilling from months into a day. */
  onSelect?: (category: string) => void;
  hint?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  // Legend entries toggle lines; the axis rescales to what is still shown.
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const series = allSeries.filter((line) => !hidden.has(line.name));
  const toggle = (name: string) =>
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      // Keep at least one line visible so the chart is never blank.
      else if (series.length > 1) next.add(name);
      return next;
    });
  const peak = Math.max(1, ...series.flatMap((line) => line.values));
  // Four gridlines at a round step, so the axis reads 0, 15, 30, 45, 60 rather than 0, 13, 26, 39, 52.
  const step4 =
    NICE_STEPS.find((candidate) => candidate * 4 >= peak) ??
    Math.ceil(peak / 4);
  const top = step4 * 4;
  const ticks = [0, 1, 2, 3, 4].map((t) => step4 * t);
  const width = 720;
  const height = 250;
  const left = 52;
  const right = 12;
  const topPad = 12;
  const bottom = 46;
  const plotH = height - topPad - bottom;
  const step = (width - left - right) / Math.max(1, categories.length - 1);
  const x = (i: number) => left + i * step;
  const y = (value: number) => topPad + plotH - (value / top) * plotH;
  return (
    <div className="lc-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={label}
        onMouseLeave={() => setHover(null)}
        onClick={() => hover !== null && onSelect?.(categories[hover]!)}
        style={onSelect ? { cursor: "pointer" } : undefined}
        onMouseMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const px = ((event.clientX - box.left) / box.width) * width;
          setHover(
            Math.min(
              categories.length - 1,
              Math.max(0, Math.round((px - left) / step)),
            ),
          );
        }}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={left}
              x2={width - right}
              y1={y(tick)}
              y2={y(tick)}
              stroke="var(--line)"
            />
            <text
              x={left - 8}
              y={y(tick) + 4}
              textAnchor="end"
              className="lc-axis"
            >
              {tick}
            </text>
          </g>
        ))}
        <line
          x1={left}
          x2={left}
          y1={topPad}
          y2={topPad + plotH}
          stroke="var(--muted)"
        />
        <line
          x1={left}
          x2={width - right}
          y1={topPad + plotH}
          y2={topPad + plotH}
          stroke="var(--muted)"
        />
        {categories.map((category, i) => (
          <g key={category}>
            <line
              x1={x(i)}
              x2={x(i)}
              y1={topPad + plotH}
              y2={topPad + plotH + 4}
              stroke="var(--muted)"
            />
            <text
              x={x(i)}
              y={topPad + plotH + 17}
              textAnchor="middle"
              className="lc-axis"
            >
              {formatCategory(category)}
            </text>
          </g>
        ))}
        <text
          x={left + (width - left - right) / 2}
          y={height - 6}
          textAnchor="middle"
          className="lc-axis-title"
        >
          {xTitle}
        </text>
        <text
          x={14}
          y={topPad + plotH / 2}
          textAnchor="middle"
          className="lc-axis-title"
          transform={`rotate(-90 14 ${topPad + plotH / 2})`}
        >
          {yTitle}
        </text>
        {series.map((line) => (
          <polyline
            key={line.name}
            fill="none"
            stroke={line.color}
            strokeWidth={2}
            strokeLinejoin="round"
            points={line.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
          />
        ))}
        {hover !== null && (
          <g>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={topPad}
              y2={topPad + plotH}
              stroke="var(--muted)"
              strokeDasharray="3 3"
            />
            {series.map((line) => (
              <circle
                key={line.name}
                cx={x(hover)}
                cy={y(line.values[hover] ?? 0)}
                r={3.5}
                fill={line.color}
              />
            ))}
          </g>
        )}
      </svg>
      <ul
        className="lc-legend lc-legend-inline"
        aria-label="图例（点击显示或隐藏）"
      >
        {allSeries.map((line) => {
          const off = hidden.has(line.name);
          return (
            <li key={line.name}>
              <button
                type="button"
                className={`lc-legend-item ${off ? "is-off" : ""}`}
                aria-pressed={!off}
                title={off ? "点击显示" : "点击隐藏"}
                onClick={() => toggle(line.name)}
              >
                <i style={{ background: off ? "var(--line)" : line.color }} />
                <span>{line.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="lc-tip" aria-live="polite">
        {hover === null
          ? hint
          : `${formatTip(categories[hover]!)} · ${series
              .map((line) => `${line.name} ${line.values[hover] ?? 0}`)
              .join(" · ")}`}
      </div>
    </div>
  );
}
