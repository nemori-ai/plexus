/**
 * Visuals — small, theme-aware data graphics for the Overview.
 *
 * Everything here paints with CSS-variable tokens only (no literal colours), so a
 * `data-theme` flip recolours the graphics with the rest of the console. No chart
 * library: an audit JSONL stream is humble enough to render by hand.
 */
import { useMemo } from "react";
import type { AuditEvent } from "@plexus/protocol";

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Local YYYY-MM-DD key (buckets events by the viewer's calendar day, not UTC). */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * ActivityHeatmap — a GitHub-style contribution grid over the audit stream.
 * Each cell is one calendar day; intensity is that day's audit-event count
 * (handshakes, grants, tokens, invokes, revokes — whatever the audit returns).
 * The data source is the same `api.audit()` list the Activity tab uses, bucketed
 * by local day client-side.
 */
export function ActivityHeatmap({ events, weeks = 12 }: { events: AuditEvent[]; weeks?: number }) {
  const { columns, total, max, days } = useMemo(() => {
    const counts = new Map<string, number>();
    let earliest = Infinity;
    for (const e of events) {
      const t = Date.parse(e.at);
      if (Number.isNaN(t)) continue;
      const k = dayKey(new Date(t));
      counts.set(k, (counts.get(k) ?? 0) + 1);
      if (t < earliest) earliest = t;
    }

    // Grid ends on the Saturday of the current week so today sits in the last column.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const gridEnd = new Date(today.getTime() + (6 - today.getDay()) * DAY_MS);
    const cellCount = weeks * 7;
    const gridStart = new Date(gridEnd.getTime() - (cellCount - 1) * DAY_MS);

    let max = 0;
    let total = 0;
    const cols: { month: number | null; cells: { key: string; date: Date; count: number; future: boolean }[] }[] = [];
    for (let c = 0; c < weeks; c++) {
      const cells: { key: string; date: Date; count: number; future: boolean }[] = [];
      for (let r = 0; r < 7; r++) {
        const date = new Date(gridStart.getTime() + (c * 7 + r) * DAY_MS);
        const key = dayKey(date);
        const count = counts.get(key) ?? 0;
        const future = date.getTime() > today.getTime();
        if (!future) {
          max = Math.max(max, count);
          total += count;
        }
        cells.push({ key, date, count, future });
      }
      // Label a column with its month when the month changes vs the prior column.
      const firstOfMonth = cells.find((x) => x.date.getDate() <= 7);
      cols.push({ month: firstOfMonth ? firstOfMonth.date.getMonth() : null, cells });
    }
    // Count of distinct active days, for the caption.
    const days = counts.size;
    return { columns: cols, total, max, days };
  }, [events, weeks]);

  const level = (count: number): number => {
    if (count <= 0) return 0;
    if (max <= 1) return 4;
    return Math.min(4, Math.max(1, Math.ceil((count / max) * 4)));
  };

  let lastMonth = -1;
  return (
    <div className="heat">
      <div className="heat-months" style={{ gridTemplateColumns: `repeat(${weeks}, 14px)` }}>
        {columns.map((col, i) => {
          const show = col.month !== null && col.month !== lastMonth;
          if (col.month !== null) lastMonth = col.month;
          return (
            <span className="heat-month" key={i}>
              {show ? MONTHS[col.month as number] : ""}
            </span>
          );
        })}
      </div>
      <div className="heat-weeks" style={{ gridTemplateColumns: `repeat(${weeks}, 14px)` }}>
        {columns.map((col, i) => (
          <div className="heat-week" key={i}>
            {col.cells.map((cell) => (
              <i
                key={cell.key}
                className="heat-cell"
                data-level={cell.future ? undefined : level(cell.count)}
                data-future={cell.future || undefined}
                title={
                  cell.future
                    ? ""
                    : `${cell.count} event${cell.count === 1 ? "" : "s"} · ${MONTHS[cell.date.getMonth()]} ${cell.date.getDate()}`
                }
              />
            ))}
          </div>
        ))}
      </div>
      <div className="heat-foot">
        <span className="heat-caption">
          {total} event{total === 1 ? "" : "s"} across {days} active day{days === 1 ? "" : "s"}
        </span>
        <span className="heat-legend" aria-hidden>
          Less
          <i className="heat-cell" data-level={0} />
          <i className="heat-cell" data-level={1} />
          <i className="heat-cell" data-level={2} />
          <i className="heat-cell" data-level={3} />
          <i className="heat-cell" data-level={4} />
          More
        </span>
      </div>
    </div>
  );
}

/**
 * ProgressRing — a compact donut for a "x of y" ratio (e.g. capabilities granted).
 * Tokenised stroke colours so it flips with the theme; the remainder ("dark")
 * stays on the quiet hairline track.
 */
export function ProgressRing({
  value,
  max,
  size = 56,
  label,
  tone = "amber",
}: {
  value: number;
  max: number;
  size?: number;
  label?: string;
  tone?: "amber" | "grant";
}) {
  const stroke = 6;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const frac = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <div className="ring" style={{ width: size, height: size }} title={`${value} of ${max}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          className="ring-track"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
        />
        <circle
          className="ring-fill"
          data-tone={tone}
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - frac)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="ring-text">
        <span className="ring-value">{value}</span>
        {label && <span className="ring-label">{label}</span>}
      </div>
    </div>
  );
}
