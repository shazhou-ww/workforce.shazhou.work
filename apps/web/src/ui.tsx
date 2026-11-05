import {
  activityTotals,
  type ActivitySnapshot,
  type ActivityTotals,
} from "@workspace/contracts";
import { useState } from "react";

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

export function Dashboard({
  state,
  now = Date.now(),
}: {
  readonly state: DashboardState;
  readonly now?: number;
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
        <span className="readonly">公开仓库 · 只读看板</span>
      </header>
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
  const maxCommits = Math.max(0, ...snapshot.daily.map((day) => day.commits));
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
          请检查 GitHub Actions 采集任务；下方保留上一次完整结果，并非实时数据。
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
          </div>
          <span className="period">最近 30 天，含今天</span>
        </div>
        <div className="metrics" aria-live="polite">
          <div className="metric-context">
            <span>{selectedDate ?? "30 天合计"}</span>
            {selectedDate ? (
              <button
                className="text-button"
                onClick={() => setSelectedDate(null)}
              >
                查看 30 天合计
              </button>
            ) : (
              <span className="muted">点选柱形，查看当天</span>
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
              +{number.format(totals.additions)} 新增
            </span>
            <span className="deletions">
              −{number.format(totals.deletions)} 删除
            </span>
          </div>
        </div>
        <div className="chart-caption">
          <span>每日提交数</span>
          <span>最高 {number.format(maxCommits)}</span>
        </div>
        <div
          className="chart"
          role="group"
          aria-label="30 天每日提交数，点击日期查看详情"
        >
          {snapshot.daily.map((day, index) => {
            const label = `${day.date}：${day.commits} commits，平均 ${number.format(day.averageLines)} 行变化`;
            return (
              <button
                key={day.date}
                className={`chart-day${selectedDate === day.date ? " selected" : ""}`}
                title={label}
                aria-label={label}
                aria-pressed={selectedDate === day.date}
                onClick={() =>
                  setSelectedDate(selectedDate === day.date ? null : day.date)
                }
              >
                <span className="bar-track">
                  <span
                    className={`bar${day.commits === 0 ? " zero" : ""}`}
                    style={{
                      height: `${(day.commits / (maxCommits || 1)) * 100}%`,
                    }}
                  />
                </span>
                <span className="day-label" aria-hidden="true">
                  {(index % 7 === 0 && index < snapshot.daily.length - 3) ||
                  index === snapshot.daily.length - 1
                    ? day.date.slice(5)
                    : ""}
                </span>
              </button>
            );
          })}
        </div>
        <details className="daily-details">
          <summary>查看每日明细与统计口径</summary>
          <p>
            统计公开仓库默认分支上所有作者的提交，按提交时间归入北京时间日期。
            平均行变化 =（新增行 + 删除行）÷ 提交数；无提交时为 0。
            包含合并提交、fork 及其继承的历史；相同 SHA 在同一仓库只计一次，
            跨仓库分别计数。二进制文件变化不折算为代码行。 今天仅统计至{" "}
            {timestamp.format(new Date(snapshot.until))}。
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
                  <th>最新提交（不限 30 天）</th>
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
