import { AuthenticatedRequestError, authenticatedRequest } from "./authenticatedRequest.js";

const STATS_URL = "http://localhost:5000/api/admin/dashboard/stats";
const DAY_MS = 86_400_000;
const TREND_DAYS = 30;
const ACCOUNT_KEYS = ["regular", "administrators", "unknownRole"];
const EVALUATION_STATUSES = ["not-requested", "pending", "completed", "failed", "unknown"];
const CATEGORY_BUCKETS = ["technical", "behavioral", "system-design", "other", "unknown"];
const ACTIVITY_TYPES = [
  "account-created", "interview-created", "question-saved", "session-started", "session-completed",
];
const STATS_KEYS = [
  "generatedAt", "timezone", "accounts", "interviews", "questions", "sessions",
  "evaluations", "registrationTrend", "interviewCategories", "recentActivity",
];

function hasFields(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function hasCounts(value, keys) {
  return hasFields(value, keys) && keys.every((key) => isCount(value[key]));
}

function isPercentage(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100 &&
    Math.round(value * 10) / 10 === value;
}

function utcTimestamp(value) {
  if (typeof value !== "string") return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : NaN;
}

function validSessions(sessions) {
  const counts = ["total", "completed", "inProgress", "unknownStatus"];
  if (!hasFields(sessions, [...counts, "completionRatePercent"]) ||
      !counts.every((key) => isCount(sessions[key]))) return false;

  const { total, completed, inProgress, unknownStatus, completionRatePercent } = sessions;
  const classified = completed + inProgress;
  return total === classified + unknownStatus &&
    completionRatePercent === (classified ? Math.round((completed * 1_000) / classified) / 10 : null);
}

function validEvaluations(evaluations, completedSessions) {
  if (!hasFields(evaluations, ["averageScore", "scoredSessions", "status"])) return false;
  const { averageScore, scoredSessions, status } = evaluations;
  return hasCounts(status, EVALUATION_STATUSES) &&
    Object.values(status).reduce((sum, count) => sum + count, 0) === completedSessions &&
    isCount(scoredSessions) && scoredSessions <= status.completed &&
    (scoredSessions === 0 ? averageScore === null : isPercentage(averageScore));
}

function validTrend(trend, start) {
  return Array.isArray(trend) && trend.length === TREND_DAYS &&
    trend.every((entry, index) =>
      hasFields(entry, ["date", ...ACCOUNT_KEYS]) &&
      entry.date === new Date(start + index * DAY_MS).toISOString().slice(0, 10) &&
      ACCOUNT_KEYS.every((key) => isCount(entry[key])),
    );
}

function validCategories(categories, totalInterviews) {
  return Array.isArray(categories) && categories.length === CATEGORY_BUCKETS.length &&
    categories.every((bucket, index) =>
      hasFields(bucket, ["category", "count"]) &&
      bucket.category === CATEGORY_BUCKETS[index] && isCount(bucket.count),
    ) &&
    categories.reduce((sum, { count }) => sum + count, 0) === totalInterviews;
}

function validActivity(activity, start, end) {
  if (!Array.isArray(activity) || activity.length > 10) return false;
  let previousTime = end;
  let previousType = -1;
  for (const event of activity) {
    if (!hasFields(event, ["type", "occurredAt"])) return false;
    const time = utcTimestamp(event.occurredAt);
    const type = ACTIVITY_TYPES.indexOf(event.type);
    if (!Number.isFinite(time) || time < start || time > previousTime || type < 0 ||
        (time === previousTime && type < previousType)) return false;
    previousTime = time;
    previousType = type;
  }
  return true;
}

function validStats(stats) {
  if (!hasFields(stats, STATS_KEYS) || stats.timezone !== "UTC") return false;
  const end = utcTimestamp(stats.generatedAt);
  const start = (Math.floor(end / DAY_MS) - (TREND_DAYS - 1)) * DAY_MS;
  if (!Number.isFinite(end) || !Number.isFinite(new Date(start).getTime())) return false;

  return hasCounts(stats.accounts, ACCOUNT_KEYS) &&
    hasCounts(stats.interviews, ["total"]) && hasCounts(stats.questions, ["total"]) &&
    validSessions(stats.sessions) && validEvaluations(stats.evaluations, stats.sessions.completed) &&
    validTrend(stats.registrationTrend, start) &&
    validCategories(stats.interviewCategories, stats.interviews.total) &&
    validActivity(stats.recentActivity, start, end);
}

/** Pass the administrator capability from ProtectedAdminBoundary or its outlet context. */
export async function getAdminDashboardStats(options = {}) {
  const capability = Object.hasOwn(options ?? {}, "capability") ? options.capability : undefined;
  const { data, status } = await authenticatedRequest(capability, STATS_URL, {
    method: "GET",
    signal: options?.signal,
  });

  if (status !== 200 || !hasFields(data, ["success", "data"]) ||
      data.success !== true || !validStats(data.data)) {
    throw new AuthenticatedRequestError("malformed-response", status);
  }
  return data.data;
}
