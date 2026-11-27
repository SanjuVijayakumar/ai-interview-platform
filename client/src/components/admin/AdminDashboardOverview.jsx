const number = new Intl.NumberFormat("en");
const dayLabel = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });
const timeLabel = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const accountSeries = [
  ["regular", "Regular users", "var(--color-accent-green)"],
  ["administrators", "Administrators", "var(--color-accent-blue)"],
  ["unknownRole", "Unknown role", "var(--color-accent-gold)"],
];
const categoryLabels = { technical: "Technical", behavioral: "Behavioral", "system-design": "System Design", other: "Other", unknown: "Unknown" };
const evaluationLabels = {
  "not-requested": "Not Requested", pending: "Pending", completed: "Completed", failed: "Failed", unknown: "Unknown",
};
const evaluationColors = ["var(--color-text-muted)", "var(--color-accent-gold)", "var(--color-accent-green)", "var(--color-error)", "var(--color-accent-blue)"];
const eventDetails = {
  "account-created": ["Account created", "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m17-14v8m-4-4h8M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z"],
  "interview-created": ["Interview created", "M3 5h18v16H3zm5-2v4m8-4v4M3 10h18m-13 5h8"],
  "question-saved": ["Question saved", "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM9 9a3 3 0 1 1 4 2.8c-1 .4-1 1.2-1 2.2m0 3h.01"],
  "session-started": ["Session started", "M8 5l12 7-12 7z"],
  "session-completed": ["Session completed", "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM7 12l3 3 7-7"],
};
const metricIcons = [
  eventDetails["account-created"][1], eventDetails["interview-created"][1],
  eventDetails["question-saved"][1], eventDetails["session-started"][1],
  eventDetails["session-completed"][1], "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM12 6v6l4 2",
  "M3 19h18M5 16l5-5 4 2 5-7", "M6 3h12v18H6zm3 5h6m-6 4h6m-6 4h3",
];
const tones = ["green", "teal", "gold", "blue"];

function Icon({ path }) {
  return (
    <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={path} />
    </svg>
  );
}

function Panel({ title, description, children }) {
  return (
    <section aria-label={title} className="theme-card-surface min-w-0 rounded-2xl border p-5">
      <h3 className="text-lg font-semibold">{title}</h3>
      {description && <p className="mt-1 text-sm theme-text-secondary">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Metrics({ title, values, iconOffset }) {
  return (
    <section aria-label={title}>
      <h3 className="mb-3 text-lg font-semibold">{title}</h3>
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {values.map(([label, value], index) => (
          <div key={label} className={`theme-stat-card theme-stat-${tones[index]} min-w-0 rounded-2xl border p-3 sm:p-4`}>
            <span className={`theme-stat-icon theme-stat-icon-${tones[index]} mb-3 grid h-9 w-9 place-items-center rounded-xl`}>
              <Icon path={metricIcons[index + iconOffset]} />
            </span>
            <dt className="text-sm font-medium theme-text-secondary">{label}</dt>
            <dd className="mt-1 break-words text-2xl font-bold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function RegistrationTrend({ days }) {
  const total = (day) => day.regular + day.administrators + day.unknownRole;
  const maximum = Math.max(...days.map(total));

  return (
    <Panel title="User Registration" description="Account creations over the last 30 days (UTC), grouped by current role.">
      {maximum === 0 ? <p className="text-sm theme-text-secondary">No registrations in this period.</p> : (
        <>
          <ul className="flex flex-wrap gap-x-4 gap-y-2 text-xs theme-text-secondary">
            {accountSeries.map(([key, label, color]) => (
              <li key={key} className="flex items-center gap-2">
                <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
                {label}
              </li>
            ))}
          </ul>
          <figure className="mt-4">
            <figcaption className="sr-only">
              Stacked bars show daily registration counts by role. The largest daily total is {number.format(maximum)}.
              Exact counts are available in the daily registration table.
            </figcaption>
            <div aria-hidden="true" className="flex h-32 items-stretch gap-px border-b theme-border sm:gap-0.5">
              {days.map((day) => (
                <div key={day.date} className="flex min-w-0 flex-1 flex-col-reverse"
                  title={`${dayLabel.format(new Date(day.date))} UTC · ${accountSeries.map(([key, label]) => `${label}: ${number.format(day[key])}`).join(" · ")}`}>
                  {accountSeries.map(([key, , color]) => (
                    <div key={key} style={{ backgroundColor: color, height: `${(day[key] / maximum) * 100}%` }} />
                  ))}
                </div>
              ))}
            </div>
            <div aria-hidden="true" className="mt-2 flex justify-between text-xs theme-text-secondary">
              {[0, 14, 29].map((index) => <span key={index}>{dayLabel.format(new Date(days[index].date))}</span>)}
            </div>
          </figure>
          <details className="mt-4 text-sm">
            <summary className="theme-focus-ring w-fit cursor-pointer rounded theme-text-accent">Daily registration counts</summary>
            <table className="mt-2 w-full table-fixed text-left text-xs tabular-nums">
              <caption className="sr-only">Daily registration counts in UTC by account role</caption>
              <thead><tr className="theme-text-secondary">
                <th scope="col" className="py-2">Date</th>
                <th scope="col">Regular</th>
                <th scope="col">Admins</th>
                <th scope="col">Unknown</th>
              </tr></thead>
              <tbody>
                {days.map((day) => (
                  <tr key={day.date} className="border-t theme-border-subtle">
                    <th scope="row" className="py-1 font-normal"><time dateTime={day.date}>{dayLabel.format(new Date(day.date))}</time></th>
                    {accountSeries.map(([key]) => <td key={key}>{number.format(day[key])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </Panel>
  );
}

function Distribution({ rows, total, colors }) {
  return (
    <ul className="space-y-3">
      {rows.map(([label, count], index) => (
        <li key={label}>
          <div className="flex justify-between gap-2 text-sm">
            <span className="theme-text-secondary">{label}</span>
            <span className="font-semibold tabular-nums">{number.format(count)}</span>
          </div>
          <div aria-hidden="true" className="mt-1.5 h-2 overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]">
            <div className="h-full rounded-full" style={{
              width: `${total ? (count / total) * 100 : 0}%`,
              backgroundColor: colors[index % colors.length],
            }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function AdminDashboardOverview({ stats }) {
  const { accounts, interviews, questions, sessions, evaluations } = stats;
  const users = accounts.regular + accounts.administrators + accounts.unknownRole;
  const categories = stats.interviewCategories.filter(({ category, count }) =>
    count > 0 || (category !== "other" && category !== "unknown"));
  const evaluationRows = Object.entries(evaluationLabels)
    .filter(([status]) => status !== "unknown" || evaluations.status.unknown > 0)
    .map(([status, label]) => [label, evaluations.status[status]]);

  return (
    <div className="space-y-6">
      {users === 0 && interviews.total === 0 && questions.total === 0 && sessions.total === 0 && (
        <p className="theme-card-surface rounded-xl border p-4 text-sm theme-text-secondary" role="status">
          No platform records yet. Statistics will appear as records are saved.
        </p>
      )}
      <Metrics title="Platform totals" iconOffset={0} values={[
        ["Total Users", number.format(users)], ["Total Interviews", number.format(interviews.total)],
        ["Total Questions", number.format(questions.total)], ["Total Sessions", number.format(sessions.total)],
      ]} />
      <Metrics title="Session performance" iconOffset={4} values={[
        ["Completed Sessions", number.format(sessions.completed)], ["In-progress Sessions", number.format(sessions.inProgress)],
        ["Completion Rate", sessions.completionRatePercent === null ? "N/A" : `${number.format(sessions.completionRatePercent)}%`],
        ["Average Evaluation Score", evaluations.averageScore === null ? "N/A" : `${number.format(evaluations.averageScore)} / 100`],
      ]} />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <RegistrationTrend days={stats.registrationTrend} />
        <Panel title="Interview Categories">
          {interviews.total === 0 ? <p className="text-sm theme-text-secondary">No interview categories to show.</p> :
            <Distribution total={interviews.total} colors={["var(--color-accent-green)"]}
              rows={categories.map(({ category, count }) => [categoryLabels[category], count])} />}
        </Panel>
      </div>
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel title="Evaluation Overview" description="Evaluation status for completed sessions.">
          <Distribution total={sessions.completed} colors={evaluationColors} rows={evaluationRows} />
        </Panel>
        <Panel title="Account Overview">
          <dl className="space-y-3">
            {accountSeries.map(([key, label]) => (
              <div key={key} className="flex justify-between gap-2 border-b theme-border-subtle pb-3 text-sm">
                <dt className="theme-text-secondary">{label}</dt><dd className="font-semibold tabular-nums">{number.format(accounts[key])}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>
      <Panel title="Recent Activity" description="Stored record milestones for accounts, interviews, questions, and sessions. Live audit events are outside this feed.">
        {stats.recentActivity.length === 0 ? <p className="text-sm theme-text-secondary">No recent milestones.</p> : (
          <ol className="divide-y theme-dividers">
            {stats.recentActivity.map(({ type, occurredAt }, index) => (
              <li key={`${type}-${occurredAt}-${index}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
                <span className="theme-accent-soft-surface theme-text-accent grid h-9 w-9 shrink-0 place-items-center rounded-xl">
                  <Icon path={eventDetails[type][1]} />
                </span>
                <span className="flex-1 font-medium">{eventDetails[type][0]}</span>
                <time className="theme-text-secondary" dateTime={occurredAt}>{timeLabel.format(new Date(occurredAt))} UTC</time>
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </div>
  );
}
