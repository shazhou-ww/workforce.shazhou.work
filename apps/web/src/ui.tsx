import {
  activityTotals,
  type ActivitySnapshot,
  type ActivityTotals,
  type DailyActivity,
} from "@shazhou-work/workforce-contracts";
import { useState, type ReactNode } from "react";

export type DashboardState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly snapshot: ActivitySnapshot };

const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const timestamp = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const calendarDate = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "long",
  day: "numeric",
});
const weekday = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  weekday: "long",
});
const axisNumber = new Intl.NumberFormat("zh-CN", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function Dashboard({
  state,
  now = Date.now(),
  collectionControl,
  refreshError,
}: {
  readonly state: DashboardState;
  readonly now?: number;
  readonly collectionControl?: ReactNode;
  readonly refreshError?: string | null;
}) {
  return (
    <div className="shell">
      <header className="masthead">
        <a className="brand" href="/" aria-label="Workforce 首页">
          <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
            <path
              d="M3 8h5v14H3zm9-5h5v19h-5zm9 10h5v9h-5z"
              fill="currentColor"
            />
          </svg>
          Workforce
        </a>
        <div className="header-actions">
          <span className="readonly">公开仓库 · 只读看板</span>
          {collectionControl}
        </div>
      </header>
      {state.kind === "ready" && refreshError ? (
        <p className="stale-notice" role="alert">
          刷新统计失败，已保留上次完整结果：{refreshError}
        </p>
      ) : null}
      <main>
        {state.kind === "loading" ? (
          <section className="notice" role="status">
            <h1>正在读取工作动态</h1>
            <p>从 Cloudflare 获取最近一次完整统计。</p>
          </section>
        ) : state.kind === "error" ? (
          <section className="notice error" role="alert">
            <h1>暂时无法读取统计</h1>
            <p>{state.message}</p>
            <a href="/">重新加载</a>
          </section>
        ) : (
          <ActivityDashboard snapshot={state.snapshot} now={now} />
        )}
      </main>
      <footer>
        <span>GitHub 数据，Cloudflare 托管</span>
        <span>代码变化量不等于工作质量或个人贡献</span>
      </footer>
    </div>
  );
}

function ActivityDashboard({
  snapshot,
  now,
}: {
  readonly snapshot: ActivitySnapshot;
  readonly now: number;
}) {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showZeroChanges, setShowZeroChanges] = useState(false);
  const totals = selectedDate
    ? activityTotals(snapshot.daily.filter((day) => day.date === selectedDate))
    : snapshot.totals;
  const repositories = snapshot.repositories
    .map((repository) => ({
      repository,
      period: selectedDate
        ? activityTotals(
            repository.daily.filter((day) => day.date === selectedDate),
          )
        : repository,
    }))
    .filter(
      ({ repository, period }) =>
        repository.name.toLowerCase().includes(search.trim().toLowerCase()) &&
        (showZeroChanges || period.additions + period.deletions > 0),
    );
  const stale = now - Date.parse(snapshot.until) > 3 * 60 * 60 * 1000;
  const authorScope = snapshot.authorFilter
    ? `仅统计主作者 ${snapshot.authorFilter.login}${snapshot.authorFilter.emailMatching ? "（含已确认邮箱）" : ""}`
    : "统计所有作者";

  return (
    <>
      <section className="intro" aria-labelledby="page-title">
        <div>
          <p className="accounts">{snapshot.accounts.join(" / ")}</p>
          <h1 id="page-title">代码在向前。</h1>
          <p>每一天的提交，每个项目的进展。</p>
        </div>
        <div className="freshness">
          <span className={`status-dot${stale ? " stale" : ""}`} />
          <div>
            <strong>{stale ? "数据需要更新" : "最近一次完整采集"}</strong>
            <p>
              {timestamp.format(new Date(snapshot.generatedAt))}（北京时间）
            </p>
          </div>
        </div>
      </section>

      {stale ? (
        <p className="stale-notice" role="status">
          数据截止 {timestamp.format(new Date(snapshot.until))}，已超过 3 小时。
          请检查 Cloudflare 采集任务；下方保留上一次完整结果，并非实时数据。
        </p>
      ) : null}

      <section className="activity-panel" aria-labelledby="activity-title">
        <div className="section-heading">
          <div>
            <h2 id="activity-title">每日工作脉搏</h2>
            <p>
              {snapshot.daily[0]?.date} 至 {snapshot.daily.at(-1)?.date}
              <span className="timezone">北京时间 · 默认分支</span>
            </p>
            <p>{authorScope}</p>
          </div>
          <span className="period">最近 30 天，含今天</span>
        </div>
        <div className="metrics" aria-live="polite">
          <div className="metric-context">
            <strong className="period-value">
              {selectedDate
                ? calendarDate.format(
                    new Date(`${selectedDate}T00:00:00+08:00`),
                  )
                : "近 30 天"}
            </strong>
            <span className="period-detail">
              {selectedDate ? (
                `${selectedDate.slice(0, 4)} 年 · ${weekday.format(new Date(`${selectedDate}T00:00:00+08:00`))} · 北京时间`
              ) : (
                <>
                  {snapshot.daily[0]?.date} 至 {snapshot.daily.at(-1)?.date}
                </>
              )}
            </span>
            {selectedDate ? (
              <button
                className="text-button"
                onClick={() => setSelectedDate(null)}
              >
                查看 30 天合计
              </button>
            ) : (
              <span className="muted">点选图表，查看当天</span>
            )}
          </div>
          <Metric label="提交数" value={totals.commits} unit="commits" />
          <Metric
            label="平均每次提交"
            value={totals.averageLines}
            unit="行变化"
          />
          <div className="line-totals">
            <span className="additions">
              <strong>+{number.format(totals.additions)}</strong>
              <span>新增</span>
            </span>
            <span className="deletions">
              <strong>−{number.format(totals.deletions)}</strong>
              <span>删除</span>
            </span>
          </div>
        </div>
        <ActivityChart
          daily={snapshot.daily}
          selectedDate={selectedDate}
          onSelectDate={(date) =>
            setSelectedDate(selectedDate === date ? null : date)
          }
        />
        <details className="daily-details">
          <summary>查看每日明细与统计口径</summary>
          <p>
            {authorScope}
            的提交，范围为公开仓库默认分支，按提交时间归入北京时间日期。
            {snapshot.authorFilter ? (
              <>
                按 GitHub 主作者账号
                {snapshot.authorFilter.emailMatching
                  ? "或已确认的作者邮箱"
                  : ""}
                匹配，不按提交者或联合作者匹配。主作者匹配时，Copilot
                作为联合作者不影响计入；仅由机器人作为主作者且不匹配的提交不计入。
              </>
            ) : null}
            柱形表示每日提交次数（左轴），折线表示每日新增行 + 删除行（右轴），
            两轴独立缩放，不能直接比较高度。 平均行变化 =（新增行 + 删除行）÷
            提交数；无提交时为 0。 保留
            fork；合并提交及继承历史也按同一作者口径计入。
            合并提交的变化可能包含上游代码，不代表原创代码行数。相同 SHA
            在同一仓库只计一次， 跨仓库分别计数。二进制文件变化不折算为代码行。
            今天仅统计至 {timestamp.format(new Date(snapshot.until))}。
          </p>
          <div className="table-scroll">
            <table>
              <caption className="sr-only">每日提交与代码变化明细</caption>
              <thead>
                <tr>
                  <th>日期</th>
                  <th>提交数</th>
                  <th>新增行</th>
                  <th>删除行</th>
                  <th>平均行变化</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.daily.map((day) => (
                  <tr key={day.date}>
                    <th scope="row">{day.date}</th>
                    <td>{number.format(day.commits)}</td>
                    <td>{number.format(day.additions)}</td>
                    <td>{number.format(day.deletions)}</td>
                    <td>{number.format(day.averageLines)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <section className="repositories" aria-labelledby="repositories-title">
        <div className="section-heading">
          <div>
            <h2 id="repositories-title">
              项目更新{" "}
              <span className="count">
                {repositories.length} / {snapshot.repositories.length}
              </span>
            </h2>
            <p>
              按默认分支最新提交排序；统计列对应{selectedDate ?? "最近 30 天"}。
            </p>
          </div>
          <label className="zero-changes-toggle">
            <input
              type="checkbox"
              checked={showZeroChanges}
              onChange={(event) => setShowZeroChanges(event.target.checked)}
            />
            显示零变化项目
          </label>
          <label className="search">
            <span className="sr-only">搜索仓库</span>
            <input
              type="search"
              placeholder="搜索仓库名称"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </div>
        {snapshot.repositories.length === 0 ? (
          <p className="empty">
            这些账号下尚无公开仓库。私有仓库不会出现在此看板。
          </p>
        ) : repositories.length === 0 ? (
          <p className="empty">
            没有匹配的仓库。请调整搜索名称或勾选“显示零变化项目”。
          </p>
        ) : (
          <div className="table-scroll">
            <table className="repo-table">
              <caption className="sr-only">公开仓库默认分支更新情况</caption>
              <thead>
                <tr>
                  <th>仓库 / 默认分支</th>
                  <th>最新提交（所有作者，不限 30 天）</th>
                  <th>提交数</th>
                  <th>代码变化</th>
                  <th>平均行变化</th>
                </tr>
              </thead>
              <tbody>
                {repositories.map(({ repository, period }) => {
                  return (
                    <tr key={repository.name}>
                      <td className="repo-name">
                        <a
                          href={repository.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {repository.name}
                        </a>
                        <div className="repo-meta">
                          <span>{repository.defaultBranch ?? "空仓库"}</span>
                          {repository.fork ? (
                            <span className="tag">Fork</span>
                          ) : null}
                          {repository.archived ? (
                            <span className="tag">已归档</span>
                          ) : null}
                        </div>
                        {repository.description ? (
                          <p className="repo-description">
                            {repository.description}
                          </p>
                        ) : null}
                      </td>
                      <td className="latest">
                        {repository.latestCommit ? (
                          <>
                            <a
                              href={repository.latestCommit.url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {repository.latestCommit.message}
                            </a>
                            <time
                              dateTime={repository.latestCommit.committedAt}
                            >
                              {new Intl.DateTimeFormat("zh-CN", {
                                timeZone: "Asia/Shanghai",
                                dateStyle: "medium",
                              }).format(
                                new Date(repository.latestCommit.committedAt),
                              )}
                            </time>
                          </>
                        ) : (
                          <span className="muted">暂无提交</span>
                        )}
                      </td>
                      <td className="numeric">
                        {number.format(period.commits)}
                      </td>
                      <td className="changes">
                        <span className="additions">
                          +{number.format(period.additions)}
                        </span>
                        <span className="deletions">
                          −{number.format(period.deletions)}
                        </span>
                      </td>
                      <td className="numeric">
                        {number.format(period.averageLines)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function ActivityChart({
  daily,
  selectedDate,
  onSelectDate,
}: {
  readonly daily: readonly DailyActivity[];
  readonly selectedDate: string | null;
  readonly onSelectDate: (date: string) => void;
}) {
  const maxCommits = Math.max(0, ...daily.map((day) => day.commits));
  const maxLines = Math.max(
    0,
    ...daily.map((day) => day.additions + day.deletions),
  );
  const linePoints = daily
    .map(
      (day, index) =>
        `${((index + 0.5) / daily.length) * 1000},${100 - ((day.additions + day.deletions) / (maxLines || 1)) * 90}`,
    )
    .join(" ");

  return (
    <div className="activity-chart">
      <div className="chart-caption">
        <span className="chart-key commits-key">提交次数 · 左轴</span>
        <span className="chart-key lines-key">
          变化行数（新增 + 删除） · 右轴
        </span>
        <span className="chart-key weekdays-key">周一至周五</span>
        <span className="chart-key weekends-key">周末（周六、周日）</span>
      </div>
      <div className="chart-composite">
        <div className="chart-axis commits-axis" aria-hidden="true">
          <span title={`${maxCommits} 次提交`}>
            {axisNumber.format(maxCommits)}
          </span>
          <span>0</span>
        </div>
        <div
          className="chart"
          role="group"
          aria-label="30 天每日提交次数与代码变化行数，点击日期查看详情"
        >
          <svg
            className="chart-line"
            viewBox="0 0 1000 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <polyline points={linePoints} />
          </svg>
          {daily.map((day, index) => {
            const lines = day.additions + day.deletions;
            const date = new Date(`${day.date}T00:00:00Z`);
            const isWeekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
            const label = `${day.date}：${day.commits} commits，${number.format(lines)} 行变化（新增 ${number.format(day.additions)}，删除 ${number.format(day.deletions)}），平均 ${number.format(day.averageLines)} 行/次；${weekday.format(date)}${isWeekend ? "（周末）" : ""}`;
            return (
              <button
                key={day.date}
                className={`chart-day${isWeekend ? " weekend" : ""}${selectedDate === day.date ? " selected" : ""}`}
                title={label}
                aria-label={label}
                aria-pressed={selectedDate === day.date}
                onClick={() => onSelectDate(day.date)}
              >
                <span className="bar-track">
                  <span
                    className={`bar${day.commits === 0 ? " zero" : ""}`}
                    style={{
                      height: `${(day.commits / (maxCommits || 1)) * 90}%`,
                    }}
                  />
                  <span
                    className="line-marker"
                    aria-hidden="true"
                    style={{
                      bottom: `${(lines / (maxLines || 1)) * 90}%`,
                    }}
                  />
                </span>
                <span className="day-label" aria-hidden="true">
                  {(index % 7 === 0 && index < daily.length - 3) ||
                  index === daily.length - 1
                    ? day.date.slice(5)
                    : ""}
                </span>
              </button>
            );
          })}
        </div>
        <div className="chart-axis lines-axis" aria-hidden="true">
          <span title={`${number.format(maxLines)} 行变化`}>
            {axisNumber.format(maxLines)}
          </span>
          <span>0</span>
        </div>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  unit,
}: {
  readonly label: string;
  readonly value: ActivityTotals["commits"];
  readonly unit: string;
}) {
  return (
    <div className="metric">
      <span>{label}</span>
      <div>
        <strong>{number.format(value)}</strong>
        <span>{unit}</span>
      </div>
    </div>
  );
}
