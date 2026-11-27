import User from "../models/User.js";
import Interview from "../models/Interview.js";
import Question from "../models/Question.js";
import InterviewResult from "../models/InterviewResult.js";

const DAY_MS = 86_400_000;
const TREND_DAYS = 30;
const ACTIVITY_LIMIT = 10;
const MAX_QUERY_TIME_MS = 3_000;
const CATEGORY_KEYS = ["technical", "behavioral", "system-design", "other", "unknown"];
const EVALUATION_KEYS = ["not-requested", "pending", "completed", "failed"];
const DEFAULT_MODELS = { User, Interview, Question, InterviewResult };

const roleBucket = {
  $switch: {
    branches: [
      { case: { $eq: ["$role", "user"] }, then: "regular" },
      { case: { $eq: ["$role", "admin"] }, then: "administrators" },
    ],
    default: "unknownRole",
  },
};

const categoryBucket = {
  $cond: [
    { $eq: [{ $type: "$category" }, "string"] },
    {
      $let: {
        vars: { category: { $toLower: { $trim: { input: "$category" } } } },
        in: {
          $switch: {
            branches: [
              { case: { $eq: ["$$category", "technical"] }, then: "technical" },
              { case: { $eq: ["$$category", "behavioral"] }, then: "behavioral" },
              { case: { $eq: ["$$category", "system-design"] }, then: "system-design" },
              { case: { $eq: ["$$category", ""] }, then: "unknown" },
            ],
            default: "other",
          },
        },
      },
    },
    "unknown",
  ],
};

const evaluationBucket = {
  $let: {
    vars: { status: { $ifNull: ["$evaluationStatus", "not-requested"] } },
    in: { $cond: [{ $in: ["$$status", EVALUATION_KEYS] }, "$$status", "unknown"] },
  },
};

const countIf = (condition) => ({ $sum: { $cond: [condition, 1, 0] } });
const countBy = (key) => ({ $group: { _id: key, count: { $sum: 1 } } });

function dateWindow(field, start, end) {
  const value = `$${field}`;
  // Aggregation expressions compare whole scalar values without traversing arrays.
  return {
    $match: {
      [field]: { $gte: start, $lte: end },
      $expr: { $eq: [{ $type: value }, "date"] },
    },
  };
}

function recentMilestones(field, start, end, requiresCompletion = false) {
  return [
    dateWindow(field, start, end),
    ...(requiresCompletion ? [{ $match: { $expr: { $eq: ["$status", "completed"] } } }] : []),
    { $sort: { [field]: -1, _id: -1 } },
    { $limit: ACTIVITY_LIMIT },
    { $project: { _id: 0, occurredAt: `$${field}` } },
  ];
}

function sessionSummary() {
  return [
    {
      $set: {
        completed: { $eq: ["$status", "completed"] },
        inProgress: { $eq: ["$status", "in-progress"] },
        evaluation: evaluationBucket,
      },
    },
    {
      $set: {
        scored: {
          $and: [
            "$completed",
            { $eq: ["$evaluation", "completed"] },
            { $isNumber: "$overallScore" },
            // BSON NaN sorts below finite numbers. The range also excludes infinities.
            { $gte: ["$overallScore", 0] },
            { $lte: ["$overallScore", 100] },
          ],
        },
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        completed: countIf("$completed"),
        inProgress: countIf("$inProgress"),
        scoredSessions: countIf("$scored"),
        scoreSum: { $sum: { $cond: ["$scored", { $toDouble: "$overallScore" }, 0] } },
        ...Object.fromEntries(
          [...EVALUATION_KEYS, "unknown"].map((key) => [
            `evaluation_${key}`,
            countIf({ $and: ["$completed", { $eq: ["$evaluation", key] }] }),
          ]),
        ),
      },
    },
  ];
}

function buildRegistrationTrend(rows, startMs) {
  const dates = Array.from({ length: TREND_DAYS }, (_, index) => ({
    date: new Date(startMs + index * DAY_MS).toISOString().slice(0, 10),
    regular: 0,
    administrators: 0,
    unknownRole: 0,
  }));
  const buckets = new Map(dates.map((bucket) => [bucket.date, bucket]));
  for (const { _id: { date, role }, count } of rows) {
    buckets.get(date)[role] = count;
  }
  return dates;
}

function mergeMilestones(sources) {
  // The source order breaks cross-type ties. A stable sort preserves the
  // database's _id order within each source for equal timestamps.
  return sources
    .flatMap(([type, rows]) => rows.map(({ occurredAt }) => ({ type, occurredAt })))
    .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())
    .slice(0, ACTIVITY_LIMIT)
    .map(({ type, occurredAt }) => ({ type, occurredAt: occurredAt.toISOString() }));
}

function aggregateFacets(model, fields, facets) {
  return model.aggregate([{ $project: fields }, { $facet: facets }])
    .option({ maxTimeMS: MAX_QUERY_TIME_MS, collation: { locale: "simple" } })
    .exec();
}

export async function getAdminDashboardStats(generatedAt = new Date(), models = DEFAULT_MODELS) {
  const endMs = generatedAt.getTime();
  const startMs = Math.floor(endMs / DAY_MS) * DAY_MS - (TREND_DAYS - 1) * DAY_MS;
  const start = new Date(startMs);
  const recent = (field, requiresCompletion) =>
    recentMilestones(field, start, generatedAt, requiresCompletion);

  const [[users], [interviews], [questions], [sessions]] = await Promise.all([
    aggregateFacets(models.User, { role: 1, createdAt: 1 }, {
      accounts: [countBy(roleBucket)],
      trend: [
        dateWindow("createdAt", start, generatedAt),
        countBy({
          date: { $dateToString: { date: "$createdAt", format: "%Y-%m-%d", timezone: "UTC" } },
          role: roleBucket,
        }),
      ],
      recent: recent("createdAt"),
    }),
    aggregateFacets(models.Interview, { category: 1, createdAt: 1 }, {
      categories: [countBy(categoryBucket)],
      recent: recent("createdAt"),
    }),
    aggregateFacets(models.Question, { createdAt: 1 }, {
      total: [{ $count: "count" }],
      recent: recent("createdAt"),
    }),
    aggregateFacets(models.InterviewResult, {
      status: 1, evaluationStatus: 1, overallScore: 1, startedAt: 1, completedAt: 1,
    }, {
      summary: sessionSummary(),
      started: recent("startedAt"),
      completed: recent("completedAt", true),
    }),
  ]);

  const roles = new Map(users.accounts.map(({ _id, count }) => [_id, count]));
  const categories = new Map(interviews.categories.map(({ _id, count }) => [_id, count]));
  const summary = sessions.summary[0] ?? {};
  const { total = 0, completed = 0, inProgress = 0, scoredSessions = 0, scoreSum = 0 } = summary;
  const classified = completed + inProgress;

  return {
    generatedAt: generatedAt.toISOString(),
    timezone: "UTC",
    accounts: {
      regular: roles.get("regular") ?? 0,
      administrators: roles.get("administrators") ?? 0,
      unknownRole: roles.get("unknownRole") ?? 0,
    },
    interviews: { total: [...categories.values()].reduce((sum, count) => sum + count, 0) },
    questions: { total: questions.total[0]?.count ?? 0 },
    sessions: {
      total,
      completed,
      inProgress,
      unknownStatus: total - classified,
      completionRatePercent: classified ? Math.round((completed * 1_000) / classified) / 10 : null,
    },
    evaluations: {
      averageScore: scoredSessions ? Math.round((scoreSum / scoredSessions) * 10) / 10 : null,
      scoredSessions,
      status: Object.fromEntries(
        [...EVALUATION_KEYS, "unknown"].map((key) => [key, summary[`evaluation_${key}`] ?? 0]),
      ),
    },
    registrationTrend: buildRegistrationTrend(users.trend, startMs),
    interviewCategories: CATEGORY_KEYS.map((category) => ({
      category,
      count: categories.get(category) ?? 0,
    })),
    recentActivity: mergeMilestones([
      ["account-created", users.recent],
      ["interview-created", interviews.recent],
      ["question-saved", questions.recent],
      ["session-started", sessions.started],
      ["session-completed", sessions.completed],
    ]),
  };
}
