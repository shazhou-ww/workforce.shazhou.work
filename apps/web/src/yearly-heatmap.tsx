import {
  activityWindow,
  beijingDate,
  type DailyCommitCount,
} from "@shazhou-work/workforce-contracts";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

const dayMs = 86_400_000;
const ranges = ["0–3", "4–15", "16–63", "64–255", "256–1023", "1024+"];
const weekday = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "UTC",
  weekday: "long",
});

export function commitLevel(count: number): number {
  return count === 0 ? 0 : Math.min(Math.floor(Math.log2(count) / 2), 5);
}

function tooltipPosition(element: HTMLButtonElement) {
  const rect = element.getBoundingClientRect();
  return {
    left: Math.max(12, Math.min(rect.left - 100, globalThis.innerWidth - 232)),
    top: rect.top > 80 ? rect.top - 72 : rect.bottom + 8,
  };
}

export function YearlyHeatmap({
  daily,
  until,
}: {
  readonly daily: readonly DailyCommitCount[] | undefined;
  readonly until: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [focusedDate, setFocusedDate] = useState(beijingDate(until));
  const [tooltip, setTooltip] = useState<{
    label: string;
    left: number;
    top: number;
  } | null>(null);
  const window = activityWindow(new Date(until), 365);
  const counts = new Map(daily?.map((day) => [day.date, day.commits]));
  const complete = window.dates.every((date) => counts.has(date));
  const first = Date.parse(`${window.dates[0]}T00:00:00Z`);
  const offset = (new Date(first).getUTCDay() + 6) % 7;
  const columns = Math.ceil((offset + window.dates.length) / 7);
  const dates = Array.from({ length: columns * 7 }, (_, index) =>
    new Date(first + (index - offset) * dayMs).toISOString().slice(0, 10),
  );
  const months = dates.flatMap((date, index) =>
    index >= offset &&
    index < offset + 365 &&
    (index === offset || date.endsWith("-01"))
      ? [{ date, column: Math.floor(index / 7) }]
      : [],
  );

  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollLeft = element.scrollWidth;
    setFocusedDate(beijingDate(until));
    setTooltip(null);
  }, [until, complete]);

  useEffect(() => {
    const reposition = () => {
      const element = document.activeElement;
      if (
        element instanceof HTMLButtonElement &&
        scroller.current?.contains(element)
      ) {
        setTooltip({
          label: element.getAttribute("aria-label") ?? "",
          ...tooltipPosition(element),
        });
      } else {
        setTooltip(null);
      }
    };
    globalThis.addEventListener("scroll", reposition, true);
    globalThis.addEventListener("resize", reposition);
    return () => {
      globalThis.removeEventListener("scroll", reposition, true);
      globalThis.removeEventListener("resize", reposition);
    };
  }, []);

  function showTooltip(element: HTMLButtonElement, label: string) {
    setTooltip({
      label,
      ...tooltipPosition(element),
    });
  }

  function navigate(event: KeyboardEvent<HTMLButtonElement>, date: string) {
    if (event.key === "Escape") {
      setTooltip(null);
      return;
    }
    const step: Record<string, number> = {
      ArrowLeft: -7,
      ArrowRight: 7,
      ArrowUp: -1,
      ArrowDown: 1,
    };
    const delta = step[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    const next = new Date(Date.parse(date) + delta * dayMs)
      .toISOString()
      .slice(0, 10);
    scroller.current
      ?.querySelector<HTMLButtonElement>(`button[data-date="${next}"]`)
      ?.focus();
  }

  return (
    <section className="yearly-panel" aria-labelledby="yearly-title">
      <div className="section-heading">
        <h2 id="yearly-title">年度提交足迹</h2>
        <span className="yearly-period">最近一年</span>
      </div>
      {!complete ? (
        <p className="yearly-pending" role="status">
          年度统计尚未生成，等待下一次完整采集。
        </p>
      ) : (
        <>
          <div className="heatmap-layout">
            <div className="heatmap-weekdays" aria-hidden="true">
              <span>周一</span>
              <span />
              <span>周三</span>
              <span />
              <span>周五</span>
              <span />
              <span />
            </div>
            <div
              className="heatmap-scroll"
              ref={scroller}
              role="region"
              aria-label={`${window.dates[0]} 至 ${window.dates.at(-1)} 每日提交数量，北京时间，可横向滚动`}
              tabIndex={0}
            >
              <div className="heatmap-calendar">
                <div className="heatmap-months" aria-hidden="true">
                  {months.map(({ date, column }) => (
                    <span
                      key={date}
                      style={{ left: `${(column / columns) * 100}%` }}
                    >
                      {Number(date.slice(5, 7))}月
                    </span>
                  ))}
                </div>
                <div
                  className="heatmap-days"
                  style={{
                    gridTemplateColumns: `repeat(${columns}, minmax(7px, 1fr))`,
                  }}
                >
                  {dates.map((date, index) => {
                    if (index < offset || index >= offset + 365)
                      return <span key={date} aria-hidden="true" />;
                    const count = counts.get(date) ?? 0;
                    const today = date === window.dates.at(-1);
                    const label = `${date} ${weekday.format(new Date(date))} · ${count} 次提交${today ? " · 截至本次采集" : ""}`;
                    return (
                      <button
                        key={date}
                        type="button"
                        className={`heatmap-day${today ? " heatmap-today" : ""}`}
                        data-level={commitLevel(count)}
                        data-date={date}
                        aria-label={label}
                        tabIndex={focusedDate === date ? 0 : -1}
                        onMouseEnter={(event) =>
                          showTooltip(event.currentTarget, label)
                        }
                        onMouseLeave={(event) => {
                          if (document.activeElement !== event.currentTarget)
                            setTooltip(null);
                        }}
                        onFocus={(event) => {
                          setFocusedDate(date);
                          showTooltip(event.currentTarget, label);
                        }}
                        onBlur={() => setTooltip(null)}
                        onClick={(event) =>
                          showTooltip(event.currentTarget, label)
                        }
                        onKeyDown={(event) => navigate(event, date)}
                      />
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
          <div
            className="heatmap-legend"
            aria-label="每日提交色阶，4为底对数向下取整，最高5级"
          >
            <span>次 / 天</span>
            {ranges.map((range, level) => (
              <span key={range}>
                <i data-level={level} />
                {range}
              </span>
            ))}
          </div>
          {tooltip ? (
            <div
              className="heatmap-tooltip"
              role="tooltip"
              style={{ left: tooltip.left, top: tooltip.top }}
            >
              {tooltip.label}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
