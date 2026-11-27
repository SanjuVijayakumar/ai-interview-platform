import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticatedRequestError } from "./authenticatedRequest.js";
import {
  createQuestion, deleteQuestion, generateInterviewQuestions, getQuestions, updateQuestion,
} from "./questionService.js";

const api = "http://localhost:5000/api";
const questionsUrl = `${api}/questions`;
const interviewId = "507f1f77bcf86cd799439011";
const questionId = "507f1f77bcf86cd799439012";
const preview = {
  questionText: "How do error boundaries handle render failures?",
  category: "Frontend reliability",
  difficulty: "Advanced",
  expectedAnswer: "They render fallback UI after errors in descendant rendering.",
};
const questionData = { ...preview, interview: interviewId, order: 2 };
const record = {
  ...questionData,
  _id: questionId,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  __v: 0,
};
const list = [{ ...record, _id: "507f1f77bcf86cd799439013", order: 1, expectedAnswer: "" }, record];
const updates = { questionText: "What should an error fallback display?", order: 1 };
const updated = { ...record, ...updates };
const receipt = { success: true, questionId, message: "Question deleted successfully", trace: "test" };
const preferences = { count: 1, difficulty: "Advanced", category: "Frontend reliability" };
const operations = [
  {
    name: "list", method: "GET", destination: `${questionsUrl}/${interviewId}`,
    call: (options) => getQuestions(interviewId, options),
    envelope: { success: true, questions: list, count: 2 }, value: list,
    invalid: { success: true, questions: [preview] },
  },
  {
    name: "create", method: "POST", destination: questionsUrl, payload: questionData, status: 201,
    call: (options) => createQuestion(questionData, options),
    envelope: { success: true, message: "Question created successfully", question: record }, value: record,
    invalid: { success: true, question: { ...record, interview: null } },
  },
  {
    name: "update", method: "PATCH", destination: `${questionsUrl}/${questionId}`, payload: updates,
    call: (options) => updateQuestion(questionId, updates, options),
    envelope: { success: true, message: "Question updated successfully", question: updated }, value: updated,
    invalid: { success: true, question: { ...updated, order: "1" } },
  },
  {
    name: "delete", method: "DELETE", destination: `${questionsUrl}/${questionId}`,
    call: (options) => deleteQuestion(questionId, options),
    envelope: receipt, value: receipt,
    invalid: { success: true, question: record },
  },
  {
    name: "generate", method: "POST", destination: `${api}/interviews/${interviewId}/generate-questions`,
    payload: preferences, call: (options) => generateInterviewQuestions(interviewId, preferences, options),
    envelope: { success: true, interviewId, questions: [preview] }, value: [preview],
    invalid: { success: true, questions: [{ ...preview, expectedAnswer: "" }] },
  },
];

function response(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function expectLegacyError(promise, message, status) {
  const error = await promise.catch((caught) => caught);
  expect(error.constructor).toBe(Error);
  expect(error.message).toBe(message);
  expect(error.status).toBe(status);
  expect(error).not.toHaveProperty("category");
  expect(error).not.toHaveProperty("data");
}

async function expectRequestError(promise, category, status) {
  const error = await promise.catch((caught) => caught);
  expect(error).toBeInstanceOf(AuthenticatedRequestError);
  expect(error.category).toBe(category);
  expect(error.status).toBe(status);
  expect(error).not.toHaveProperty("data");
  expect(error.message).not.toContain("private");
}

beforeEach(() => {
  localStorage.setItem("token", "question-test-token");
  vi.spyOn(Storage.prototype, "getItem");
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe.each(operations)("legacy question $name", ({ call, destination, method, payload, envelope, value, status }) => {
  it.each([false, true])("uses the original request contract (inherited capability: %s)", async (inherited) => {
    const capability = { fetch: vi.fn(), isCurrent: () => true };
    const result = response(envelope, status);
    fetch.mockResolvedValue(result);
    await expect(inherited ? call(Object.create({ capability })) : call()).resolves.toEqual(value);
    const options = { headers: { Authorization: "Bearer question-test-token" } };
    if (method !== "GET") options.method = method;
    if (payload) {
      options.body = JSON.stringify(payload);
      options.headers["Content-Type"] = "application/json";
    }
    expect(fetch).toHaveBeenCalledExactlyOnceWith(destination, options);
    expect(Storage.prototype.getItem).toHaveBeenCalledExactlyOnceWith("token");
    expect(result.json).toHaveBeenCalledOnce();
    expect(capability.fetch).not.toHaveBeenCalled();
  });

  it("preserves missing-token and transport errors", async () => {
    localStorage.removeItem("token");
    await expectLegacyError(call(), "Your session is missing. Please sign in again.");
    expect(fetch).not.toHaveBeenCalled();
    localStorage.setItem("token", "question-test-token");
    fetch.mockRejectedValue(new Error("private transport error"));
    await expectLegacyError(call(), "Could not connect to PrepX. Check that the backend is running and try again.");
  });

  it("preserves plain HTTP errors with the backend message and status", async () => {
    fetch.mockResolvedValue(response({ message: "Legacy backend message", extra: "ignored" }, 401));
    await expectLegacyError(call(), "Legacy backend message", 401);
  });
});

it.each(operations)("preserves legacy successful response parsing for $name", async ({ name, call }) => {
  const result = response(null);
  result.json.mockRejectedValue(new SyntaxError("invalid JSON"));
  fetch.mockResolvedValue(result);
  if (name === "list") {
    await expectLegacyError(call(), "The questions response was not in the expected format.");
  } else if (name === "generate") {
    await expectLegacyError(call(), "The generated questions response was not in the expected format.");
  } else {
    await expect(call()).resolves.toEqual(name === "delete" ? {} : undefined);
  }
});

it("preserves legacy encoded identifiers and the empty array contract", async () => {
  fetch.mockResolvedValue(response({ questions: [] }));
  await expect(getQuestions("id/extra")).resolves.toEqual([]);
  await expect(generateInterviewQuestions("id/extra", preferences)).resolves.toEqual([]);
  expect(fetch.mock.calls.map(([destination]) => destination)).toEqual([
    `${questionsUrl}/id%2Fextra`, `${api}/interviews/id%2Fextra/generate-questions`,
  ]);
});

describe("question capability isolation", () => {
  let capability;
  let onLogout;

  beforeEach(() => {
    capability = { fetch: vi.fn(), isCurrent: vi.fn(() => true) };
    vi.spyOn(Storage.prototype, "setItem");
    vi.spyOn(Storage.prototype, "removeItem");
    vi.spyOn(Storage.prototype, "clear");
    onLogout = vi.fn();
    window.addEventListener("prepx:logout", onLogout);
  });

  afterEach(() => {
    window.removeEventListener("prepx:logout", onLogout);
    expect(fetch).not.toHaveBeenCalled();
    expect(Storage.prototype.getItem).not.toHaveBeenCalled();
    expect(Storage.prototype.setItem).not.toHaveBeenCalled();
    expect(Storage.prototype.removeItem).not.toHaveBeenCalled();
    expect(Storage.prototype.clear).not.toHaveBeenCalled();
    expect(onLogout).not.toHaveBeenCalled();
  });

  describe.each(operations)("capability question $name", ({
    call, destination, method, payload, envelope, value, status = 200, invalid,
  }) => {
    it("dispatches exactly one request and preserves the backend value", async () => {
      const { signal } = new AbortController();
      capability.fetch.mockResolvedValue(response(envelope, status));
      const expected = payload
        ? { method, signal, body: JSON.stringify(payload), headers: new Headers({ "Content-Type": "application/json" }) }
        : { method, signal };
      await expect(call({ capability, signal })).resolves.toEqual(value);
      expect(capability.fetch).toHaveBeenCalledExactlyOnceWith(destination, expected);
      expect(Object.keys(capability.fetch.mock.lastCall[1]).sort()).toEqual(Object.keys(expected).sort());
    });

    it.each([
      ["null", null, "missing-capability"],
      ["undefined", undefined, "missing-capability"],
      ["invalid", { fetch: vi.fn() }, "invalid-capability"],
    ])("fails closed for an explicit %s capability", async (_label, unusable, category) => {
      await expectRequestError(call({ capability: unusable }), category);
      expect(unusable?.fetch ?? capability.fetch).not.toHaveBeenCalled();
    });

    it("blocks stale and pre-cancelled requests", async () => {
      capability.isCurrent.mockReturnValue(false);
      await expectRequestError(call({ capability }), "stale-session");
      capability.isCurrent.mockReturnValue(true);
      await expectRequestError(call({ capability, signal: AbortSignal.abort() }), "cancelled");
      expect(capability.fetch).not.toHaveBeenCalled();
    });

    it.each([["missing success envelope", {}], ["incorrect shape", invalid]])(
      "rejects a successful response with %s",
      async (_label, body) => {
        capability.fetch.mockResolvedValue(response(body, status));
        await expectRequestError(call({ capability }), "malformed-response", status);
        expect(capability.fetch).toHaveBeenCalledOnce();
      },
    );

    it("ignores a late response after invalidation without reading its body", async () => {
      const dispatch = deferred();
      const result = response(envelope, status);
      capability.fetch.mockReturnValue(dispatch.promise);
      const pending = call({ capability });
      capability.isCurrent.mockReturnValue(false);
      dispatch.resolve(result);
      await expectRequestError(pending, "stale-session");
      expect(result.text).not.toHaveBeenCalled();
      expect(capability.fetch).toHaveBeenCalledOnce();
    });
  });

  it("preserves empty lists and optional record fields without sorting", async () => {
    const optionalAnswer = { ...list[0] };
    delete optionalAnswer.expectedAnswer;
    const fromServer = [record, optionalAnswer];
    capability.fetch.mockResolvedValueOnce(response({ success: true, questions: [] }))
      .mockResolvedValueOnce(response({ success: true, questions: fromServer }));
    await expect(getQuestions(interviewId, { capability })).resolves.toEqual([]);
    await expect(getQuestions(interviewId, { capability })).resolves.toEqual(fromServer);
    expect(capability.fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects a partial AI preview even if its questions are valid", async () => {
    capability.fetch.mockResolvedValue(response({ success: true, interviewId, questions: [preview] }));
    await expectRequestError(generateInterviewQuestions(interviewId, { ...preferences, count: 2 }, { capability }),
      "malformed-response", 200);
    expect(capability.fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ["list", (id, options) => getQuestions(id, options), (id) => `${questionsUrl}/${id}`],
    ["update", (id, options) => updateQuestion(id, updates, options), (id) => `${questionsUrl}/${id}`],
    ["delete", (id, options) => deleteQuestion(id, options), (id) => `${questionsUrl}/${id}`],
    ["generate", (id, options) => generateInterviewQuestions(id, preferences, options),
      (id) => `${api}/interviews/${id}/generate-questions`],
  ])("holds the %s identifier to one path segment", async (_name, call, destination) => {
    for (const id of ["", null, 42, ".", "..", "../other", "id/extra", "id\\extra",
      "id%2Fextra", "id%5cextra", "%2e%2e", "id?x=1", "id#fragment", "id\n"]) {
      await expectRequestError(call(id, { capability }), "invalid-destination");
    }
    expect(capability.fetch).not.toHaveBeenCalled();
    capability.fetch.mockResolvedValue(response({ success: false, message: "Invalid ID" }, 400));
    await expectRequestError(call("invalid-id", { capability }), "http-error", 400);
    expect(capability.fetch).toHaveBeenCalledTimes(1);
    expect(capability.fetch.mock.lastCall[0]).toBe(destination("invalid-id"));
  });

  it.each([
    [0, 403], [1, 400], [2, 404], [2, 409], [3, 500], [4, 429], [4, 502], [4, 503], [4, 504],
  ])("preserves resource status for operation %i and HTTP %i without leaking the body", async (index, status) => {
    const message = status === 404 ? "No in-progress session found" : "Completed sessions cannot be modified";
    capability.fetch.mockResolvedValue(response({ success: false, message, detail: "private" }, status));
    const pending = operations[index].call({ capability });
    await expectRequestError(pending, "http-error", status);
    await expect(pending).rejects.toThrow("The authenticated request failed.");
    expect(capability.isCurrent()).toBe(true);
    expect(capability.fetch).toHaveBeenCalledOnce();
  });

  it.each([["unauthorized", 401], ["forbidden", 403], ["network-error", undefined]])(
    "preserves the provider's %s classification without retrying",
    async (category, status) => {
      capability.fetch.mockImplementation(async () => {
        if (status) capability.isCurrent.mockReturnValue(false);
        throw Object.assign(new Error("private provider error"), { category, status });
      });
      await expectRequestError(createQuestion(questionData, { capability }), category, status);
      expect(capability.fetch).toHaveBeenCalledOnce();
    },
  );

  it("rejects malformed AI JSON without retrying or creating questions", async () => {
    const result = response(null);
    result.text.mockResolvedValue("{private invalid JSON");
    capability.fetch.mockResolvedValue(result);
    await expectRequestError(generateInterviewQuestions(interviewId, preferences, { capability }),
      "malformed-response", 200);
    expect(capability.fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { operation: 0, stale: true, abort: false, rejectBody: false, category: "stale-session" },
    { operation: 1, stale: true, abort: false, rejectBody: true, category: "stale-session" },
    { operation: 3, stale: false, abort: true, rejectBody: false, category: "cancelled" },
    { operation: 4, stale: true, abort: true, rejectBody: true, category: "cancelled" },
    { operation: 2, stale: false, abort: false, rejectBody: true, category: "body-read-error" },
  ])("preserves $category during response-body processing for operation $operation", async ({
    operation, stale, abort, rejectBody, category,
  }) => {
    const { call, envelope, status = 200 } = operations[operation];
    const controller = new AbortController();
    const started = deferred();
    const reading = deferred();
    const result = response(envelope, status);
    result.text.mockImplementation(() => {
      started.resolve();
      return reading.promise;
    });
    capability.fetch.mockResolvedValue(result);
    const pending = call({ capability, signal: controller.signal });
    await started.promise;
    if (stale) capability.isCurrent.mockReturnValue(false);
    if (abort) controller.abort();
    if (rejectBody) reading.reject(new Error("private body failure"));
    else reading.resolve(JSON.stringify(envelope));
    await expectRequestError(pending, category, category === "body-read-error" ? status : undefined);
    expect(capability.fetch).toHaveBeenCalledOnce();
  });
});
