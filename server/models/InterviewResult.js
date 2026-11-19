import mongoose from "mongoose";
import { sanitizeInterviewResult } from "../utils/interviewResultSerialization.js";

const evaluationDimensionSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      enum: [
        "technicalAccuracy",
        "relevance",
        "completeness",
        "clarity",
        "specificity",
        "reflection",
        "tradeoffs",
      ],
      required: true,
    },
    score: { type: Number, min: 0, max: 100, required: true },
    weight: { type: Number, min: 0, max: 1, required: true },
    rationale: { type: String, maxlength: 500, default: "" },
  },
  { _id: false }
);

const answerEvaluationFields = {
  answerScore: { type: Number, min: 0, max: 100, default: null },
  dimensions: { type: [evaluationDimensionSchema], default: [] },
  strengths: {
    type: [{ type: String, maxlength: 300 }], default: [],
    validate: { validator: (items) => items.length <= 5, message: "At most 5 strengths are allowed" },
  },
  weaknesses: {
    type: [{ type: String, maxlength: 300 }], default: [],
    validate: { validator: (items) => items.length <= 5, message: "At most 5 weaknesses are allowed" },
  },
  missingConcepts: {
    type: [{ type: String, maxlength: 300 }], default: [],
    validate: { validator: (items) => items.length <= 8, message: "At most 8 missing concepts are allowed" },
  },
  improvementSuggestions: {
    type: [{ type: String, maxlength: 300 }], default: [],
    validate: { validator: (items) => items.length <= 5, message: "At most 5 improvement suggestions are allowed" },
  },
  suggestedImprovedAnswer: { type: String, maxlength: 3000, default: "" },
  referenceAnswerUsed: { type: String, maxlength: 5000, default: null },
  isUnanswered: { type: Boolean, default: false },
};

const nullableScore = { type: Number, min: 0, max: 100, default: null };

const interviewResultSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    interview: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Interview",
      required: true,
    },

    answers: [
      {
        question: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Question",
          required: true,
        },

        // Immutable copy of the question as it appeared when this attempt began.
        questionText: { type: String, default: "" },
        // Private evaluation context. API serializers must never expose this field.
        referenceAnswerSnapshot: { type: String, default: "" },
        category: { type: String, default: "" },
        difficulty: { type: String, default: "" },
        order: { type: Number, min: 1 },

        answerText: {
          type: String,
          default: "",
        },

        score: {
          type: Number,
          min: 0,
          max: 100,
          default: 0,
        },

        feedback: {
          type: String,
          default: "",
        },

        ...answerEvaluationFields,
      },
    ],

    totalQuestions: {
      type: Number,
      required: true,
      min: 0,
    },

    totalScore: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },

    overallFeedback: {
      type: String,
      default: "",
    },

    evaluationStatus: {
      type: String,
      enum: ["not-requested", "pending", "completed", "failed"],
      default: "not-requested",
    },
    evaluationRequestedAt: { type: Date, default: null },
    evaluationStartedAt: { type: Date, default: null },
    evaluationCompletedAt: { type: Date, default: null },
    evaluationFailedAt: { type: Date, default: null },
    evaluationErrorCode: { type: String, default: null },
    evaluationAttemptCount: { type: Number, min: 0, default: 0 },
    evaluationModel: { type: String, default: null },
    evaluationPromptVersion: { type: String, default: null },
    rubricVersion: { type: String, default: null },
    rubricWeights: { type: Map, of: Number, default: undefined },
    overallScore: nullableScore,
    performanceRating: {
      type: String,
      enum: ["excellent", "strong", "developing", "needs-practice"],
      default: null,
    },
    answeredCount: { type: Number, min: 0, default: null },
    unansweredCount: { type: Number, min: 0, default: null },
    strongestAreas: {
      type: [{ type: String, maxlength: 200 }], default: [],
      validate: { validator: (items) => items.length <= 10, message: "At most 10 strongest areas are allowed" },
    },
    weakestAreas: {
      type: [{ type: String, maxlength: 200 }], default: [],
      validate: { validator: (items) => items.length <= 10, message: "At most 10 weakest areas are allowed" },
    },
    technicalKnowledgeAssessment: { type: String, maxlength: 1000, default: null },
    communicationAssessment: { type: String, maxlength: 1000, default: null },
    recommendedLearningTopics: {
      type: [{ type: String, maxlength: 200 }], default: [],
      validate: { validator: (items) => items.length <= 10, message: "At most 10 learning topics are allowed" },
    },

    status: {
      type: String,
      enum: ["in-progress", "completed"],
      default: "in-progress",
    },

    startedAt: {
      type: Date,
      default: null,
    },

    durationSeconds: {
      type: Number,
      min: 0,
      default: null,
    },

    completedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_document, returned) {
        return sanitizeInterviewResult(returned);
      },
    },
  }
);

const InterviewResult = mongoose.model(
  "InterviewResult",
  interviewResultSchema
);

export default InterviewResult;
