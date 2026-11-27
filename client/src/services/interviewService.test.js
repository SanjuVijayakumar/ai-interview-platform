import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticatedRequestError } from "./authenticatedRequest.js";
import {
  createInterview,
  deleteInterview,
  getInterviewById,
  getInterviews,
  updateInterview,
} from "./interviewService.js";

const url = "http://localhost:5000/api/interviews";
const id = "507f1f77bcf86cd799439011";
const interview = {
  _id: id,
  user: "507f1f77bcf86cd799439012",
  title: "Frontend practice",
  category: "React",
  difficulty: "Intermediate",
  status: "scheduled",
  practiceStatus: "completed",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  startedAt: null,
  completedAt: null,
  __v: 0,
};
const list = { success: true, count: 1, interviews: [interview] };
const detail = { success: true, interview };
const reads = [
  { name: "list", read: getInterviews, destination: url, body: list, value: [interview] },
  {
    name: "detail",
    read: (options) => getInterviewById(id, options),
    destination: `${url}/${id}`,
    body: detail,
    value: interview,
  },
];
const bearer = { Authorization: "Bearer interview-test-token" };

function response(body, status = 200) {
  return {
    ok: status < 400,
    status,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    json: vi.fn().mockResolvedValue(body),
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

async function expectLegacyError(pending, message) {
  const error = await pending.catch((caught) => caught);
  expect(error.constructor).toBe(Error);
  expect(error.message).toBe(message);
  expect(error).not.toHaveProperty("status");
  expect(error).not.toHaveProperty("category");
}

async function expectRequestError(pending, category, status) {
  const error = await pending.catch((caught) => caught);
  expect(error).toBeInstanceOf(AuthenticatedRequestError);
  expect(error.category).toBe(category);
  expect(error.status).toBe(status);
  expect(error).not.toHaveProperty("data");
  return error;
}

beforeEach(() => {
  localStorage.setItem("token", "interview-test-token");
  vi.stubGlobal("fetch", vi.fn());
  vi.spyOn(Storage.prototype, "getItem");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe.each(reads)("legacy interview $name", ({ read, destination, body, value }) => {
  it("uses the stored bearer and implicit GET and extracts the original response", async () => {
    fetch.mockResolvedValue(response(body));
    await expect(read()).resolves.toEqual(value);
    expect(Storage.prototype.getItem).toHaveBeenCalledExactlyOnceWith("token");
    expect(fetch).toHaveBeenCalledExactlyOnceWith(destination, { headers: bearer });
  });

  it("uses legacy authentication when capability is inherited", async () => {
    const inherited = { fetch: vi.fn(), isCurrent: () => true };
    fetch.mockResolvedValue(response(body));
    await expect(read(Object.create({ capability: inherited }))).resolves.toEqual(value);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(destination, { headers: bearer });
    expect(inherited.fetch).not.toHaveBeenCalled();
  });

  it("fails before dispatch when the token is missing", async () => {
    localStorage.removeItem("token");
    await expectLegacyError(read(), "Your session is missing. Please sign in again.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([[401, "Invalid token"], [404, "Interview not found"]])(
    "preserves the plain Error for HTTP %i",
    async (status, message) => {
      fetch.mockResolvedValue(response({ message }, status));
      await expectLegacyError(read(), message);
    },
  );

  it("preserves the transport error message", async () => {
    fetch.mockRejectedValue(new TypeError("fetch failed"));
    await expectLegacyError(read(), "Could not connect to PrepX. Check that the backend is running and try again.");
  });
});

it("preserves the legacy list validation and empty-list behavior", async () => {
  fetch.mockResolvedValueOnce(response({ interviews: [] })).mockResolvedValueOnce(response({}));
  await expect(getInterviews()).resolves.toEqual([]);
  await expectLegacyError(getInterviews(), "The interviews response was not in the expected format.");
});

it("preserves legacy detail encoding and extraction from an empty envelope", async () => {
  fetch.mockResolvedValue(response({}));
  await expect(getInterviewById("invalid/id")).resolves.toBeUndefined();
  expect(fetch).toHaveBeenCalledExactlyOnceWith(`${url}/invalid%2Fid`, { headers: bearer });
});

describe.each(reads)("capability interview $name", ({ read, destination, body, value }) => {
  let capability;

  beforeEach(() => {
    capability = { fetch: vi.fn(), isCurrent: vi.fn(() => true) };
  });

  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
    expect(Storage.prototype.getItem).not.toHaveBeenCalled();
  });

  it("dispatches once with the supplied signal and preserves all record fields", async () => {
    const { signal } = new AbortController();
    capability.fetch.mockResolvedValue(response(body));
    await expect(read({ capability, signal })).resolves.toEqual(value);
    expect(capability.fetch).toHaveBeenCalledExactlyOnceWith(destination, { method: "GET", signal });
  });

  it.each([
    [null, "missing-capability"],
    [undefined, "missing-capability"],
    [{ fetch: vi.fn() }, "invalid-capability"],
  ])("fails closed for explicit capability %s", async (unusable, category) => {
    await expectRequestError(read({ capability: unusable }), category);
    expect(unusable?.fetch ?? capability.fetch).not.toHaveBeenCalled();
  });

  it("rejects a stale capability before dispatch", async () => {
    capability.isCurrent.mockReturnValue(false);
    await expectRequestError(read({ capability }), "stale-session");
    expect(capability.fetch).not.toHaveBeenCalled();
  });

  it("rejects a pre-cancelled signal before dispatch", async () => {
    const signal = AbortSignal.abort();
    await expectRequestError(read({ capability, signal }), "cancelled");
    expect(capability.fetch).not.toHaveBeenCalled();
  });

  it("rejects a stale response before reading its body", async () => {
    const dispatch = deferred();
    const result = response(body);
    capability.fetch.mockReturnValue(dispatch.promise);
    const pending = read({ capability });
    capability.isCurrent.mockReturnValue(false);
    dispatch.resolve(result);
    await expectRequestError(pending, "stale-session");
    expect(result.text).not.toHaveBeenCalled();
    expect(capability.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["stale body resolves", "stale-session"],
    ["stale body rejects", "stale-session"],
    ["cancelled body resolves", "cancelled"],
    ["current body rejects", "body-read-error", 200],
  ])("handles a %s", async (scenario, category, status) => {
    const controller = new AbortController();
    const started = deferred();
    const reading = deferred();
    const result = response(body);
    result.text.mockImplementation(() => {
      started.resolve();
      return reading.promise;
    });
    capability.fetch.mockResolvedValue(result);
    const pending = read({ capability, signal: controller.signal });
    await started.promise;
    if (scenario.startsWith("stale")) capability.isCurrent.mockReturnValue(false);
    if (scenario.startsWith("cancelled")) controller.abort();
    if (scenario.endsWith("rejects")) reading.reject(new Error("private body failure"));
    else reading.resolve(JSON.stringify(body));
    const error = await expectRequestError(pending, category, status);
    expect(error.message).not.toContain("private body failure");
    expect(capability.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([["unauthorized", 401], ["forbidden", 403], ["network-error", undefined]])(
    "preserves the provider's %s classification",
    async (category, status) => {
      capability.fetch.mockImplementation(async () => {
        if (status) capability.isCurrent.mockReturnValue(false);
        throw Object.assign(new Error("private provider error"), { category, status });
      });
      const error = await expectRequestError(read({ capability }), category, status);
      expect(error.message).not.toContain("private provider error");
      expect(capability.fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([400, 403, 404, 500, 503])("preserves resource HTTP %i without backend metadata", async (status) => {
    capability.fetch.mockResolvedValue(response({
      success: false,
      message: "No in-progress session found",
    }, status));
    const error = await expectRequestError(read({ capability }), "http-error", status);
    expect(error.message).not.toContain("No in-progress session found");
    expect(capability.isCurrent()).toBe(true);
    expect(capability.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed successful JSON", async () => {
    const result = response(body);
    result.text.mockResolvedValue("{private invalid JSON");
    capability.fetch.mockResolvedValue(result);
    const error = await expectRequestError(read({ capability }), "malformed-response", 200);
    expect(error.message).not.toContain("private");
  });
});

it.each([
  ["list", getInterviews, [interview]],
  ["list", getInterviews, { success: true }],
  ["list", getInterviews, { success: true, interviews: {} }],
  ["list", getInterviews, { success: true, interviews: [interview, { title: "Missing ID" }] }],
  ["detail", reads[1].read, interview],
  ["detail", reads[1].read, { success: true }],
  ["detail", reads[1].read, { success: true, interview: [interview] }],
  ["detail", reads[1].read, { success: true, interview: { _id: " " } }],
])("rejects a malformed %s success envelope %#", async (_name, read, body) => {
  const capability = { isCurrent: () => true, fetch: vi.fn().mockResolvedValue(response(body)) };
  await expectRequestError(read({ capability }), "malformed-response", 200);
  expect(fetch).not.toHaveBeenCalled();
  expect(Storage.prototype.getItem).not.toHaveBeenCalled();
});

it("preserves an empty capability list without requiring a signal", async () => {
  const capability = {
    isCurrent: () => true,
    fetch: vi.fn().mockResolvedValue(response({ success: true, count: 0, interviews: [] })),
  };
  await expect(getInterviews({ capability })).resolves.toEqual([]);
  expect(capability.fetch).toHaveBeenCalledExactlyOnceWith(url, { method: "GET", signal: undefined });
  expect(fetch).not.toHaveBeenCalled();
  expect(Storage.prototype.getItem).not.toHaveBeenCalled();
});

it.each(["", ".", "..", "../other", "id/extra", "id\\extra", "id?query=1", "id#fragment", "%2e%2e", "id\n"])(
  "rejects an unsafe detail identifier %j before dispatch",
  async (unsafeId) => {
    const capability = { isCurrent: () => true, fetch: vi.fn() };
    await expectRequestError(getInterviewById(unsafeId, { capability }), "invalid-destination");
    expect(capability.fetch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(Storage.prototype.getItem).not.toHaveBeenCalled();
  },
);

it("lets the backend return 400 for a segment-safe invalid ObjectId", async () => {
  const capability = {
    isCurrent: () => true,
    fetch: vi.fn().mockResolvedValue(response({ success: false, message: "Invalid interview ID" }, 400)),
  };
  await expectRequestError(getInterviewById("invalid-id", { capability }), "http-error", 400);
  expect(capability.fetch).toHaveBeenCalledExactlyOnceWith(`${url}/invalid-id`, { method: "GET", signal: undefined });
  expect(fetch).not.toHaveBeenCalled();
  expect(Storage.prototype.getItem).not.toHaveBeenCalled();
});

const creation = { title: "Frontend practice", category: "React", difficulty: "Intermediate" };
const updates = { status: "completed" };
const mutations = [
  ["POST", () => createInterview(creation), url, creation, 201],
  ["PATCH", () => updateInterview("encoded/id", updates), `${url}/encoded%2Fid`, updates, 200],
  ["DELETE", () => deleteInterview("encoded/id"), `${url}/encoded%2Fid`, undefined, 200],
];

describe.each(mutations)("legacy mutation %s", (method, mutate, destination, body, status) => {
  it("preserves the request and unwraps the returned interview", async () => {
    fetch.mockResolvedValue(response(detail, status));
    const options = body
      ? { method, body: JSON.stringify(body), headers: { ...bearer, "Content-Type": "application/json" } }
      : { method, headers: bearer };
    await expect(mutate()).resolves.toEqual(interview);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(destination, options);
    expect(Storage.prototype.getItem).toHaveBeenCalledExactlyOnceWith("token");
  });

  it("preserves the backend message and plain Error shape", async () => {
    fetch.mockResolvedValue(response({ message: "Mutation rejected" }, 400));
    await expectLegacyError(mutate(), "Mutation rejected");
  });
});

const mutationOperations = [
  {
    method: "POST",
    mutate: (options) => createInterview(creation, options),
    destination: url,
    payload: creation,
    successStatus: 201,
    message: "Interview created successfully",
  },
  {
    method: "PATCH",
    mutate: (options) => updateInterview(id, updates, options),
    destination: `${url}/${id}`,
    payload: updates,
    successStatus: 200,
    message: "Interview updated successfully",
  },
  {
    method: "DELETE",
    mutate: (options) => deleteInterview(id, options),
    destination: `${url}/${id}`,
    successStatus: 200,
    message: "Interview deleted successfully",
  },
];

describe.each(mutationOperations)("legacy $method option compatibility", ({ mutate, destination }) => {
  it("uses the legacy request when capability is inherited", async () => {
    const inherited = { isCurrent: () => true, fetch: vi.fn() };
    fetch.mockResolvedValue(response(detail));
    await expect(mutate(Object.create({ capability: inherited }))).resolves.toEqual(interview);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(destination, expect.objectContaining({
      headers: expect.objectContaining(bearer),
    }));
    expect(inherited.fetch).not.toHaveBeenCalled();
  });

  it("preserves missing-token and transport errors", async () => {
    localStorage.removeItem("token");
    await expectLegacyError(mutate(), "Your session is missing. Please sign in again.");
    expect(fetch).not.toHaveBeenCalled();
    localStorage.setItem("token", "interview-test-token");
    fetch.mockRejectedValue(new TypeError("private transport failure"));
    await expectLegacyError(mutate(), "Could not connect to PrepX. Check that the backend is running and try again.");
  });
});

describe("capability mutation isolation", () => {
  let capability;
  let logoutEvent;

  beforeEach(() => {
    capability = { fetch: vi.fn(), isCurrent: vi.fn(() => true) };
    vi.spyOn(Storage.prototype, "removeItem");
    vi.spyOn(Storage.prototype, "setItem");
    vi.spyOn(Storage.prototype, "clear");
    logoutEvent = vi.fn();
    window.addEventListener("prepx:logout", logoutEvent);
  });

  afterEach(() => {
    window.removeEventListener("prepx:logout", logoutEvent);
    expect(fetch).not.toHaveBeenCalled();
    expect(Storage.prototype.getItem).not.toHaveBeenCalled();
    expect(Storage.prototype.removeItem).not.toHaveBeenCalled();
    expect(Storage.prototype.setItem).not.toHaveBeenCalled();
    expect(Storage.prototype.clear).not.toHaveBeenCalled();
    expect(logoutEvent).not.toHaveBeenCalled();
  });

  describe.each(mutationOperations)("capability $method", ({
    method, mutate, destination, payload, successStatus, message,
  }) => {
    it("dispatches only the intended mutation and returns the backend interview", async () => {
      const record = { ...interview, ...(method === "PATCH" ? updates : {}) };
      delete record.practiceStatus;
      const { signal } = new AbortController();
      capability.fetch.mockResolvedValue(response({ success: true, message, interview: record }, successStatus));
      const expected = payload
        ? { method, signal, body: JSON.stringify(payload), headers: new Headers({ "Content-Type": "application/json" }) }
        : { method, signal };
      await expect(mutate({ capability, signal })).resolves.toEqual(record);
      expect(capability.fetch).toHaveBeenCalledExactlyOnceWith(destination, expected);
      expect(Object.keys(capability.fetch.mock.lastCall[1]).sort()).toEqual(Object.keys(expected).sort());
    });

    it.each([
      ["null", null, "missing-capability"],
      ["undefined", undefined, "missing-capability"],
      ["invalid", { fetch: vi.fn() }, "invalid-capability"],
    ])("fails closed for an explicit %s capability", async (_label, unusable, category) => {
      await expectRequestError(mutate({ capability: unusable }), category);
      expect(unusable?.fetch ?? capability.fetch).not.toHaveBeenCalled();
    });

    it("blocks stale and pre-cancelled mutations before dispatch", async () => {
      capability.isCurrent.mockReturnValue(false);
      const signal = AbortSignal.abort();
      await expectRequestError(mutate({ capability, signal }), "stale-session");
      capability.isCurrent.mockReturnValue(true);
      await expectRequestError(mutate({ capability, signal }), "cancelled");
      expect(capability.fetch).not.toHaveBeenCalled();
    });

    it.each([400, 403, 404, 409, 503])("preserves resource HTTP %i as a safe operation failure", async (status) => {
      capability.fetch.mockResolvedValue(response({
        success: false,
        message: "Completed sessions cannot be modified",
      }, status));
      const error = await expectRequestError(mutate({ capability }), "http-error", status);
      expect(error.message).not.toContain("Completed sessions cannot be modified");
      expect(capability.isCurrent()).toBe(true);
      expect(capability.fetch).toHaveBeenCalledTimes(1);
    });

    it.each([["unauthorized", 401], ["forbidden", 403], ["network-error", undefined]])(
      "preserves the provider's %s category without another dispatch",
      async (category, status) => {
        capability.fetch.mockImplementation(async () => {
          if (status) capability.isCurrent.mockReturnValue(false);
          throw Object.assign(new Error("private provider failure"), { category, status });
        });
        const error = await expectRequestError(mutate({ capability }), category, status);
        expect(error.message).not.toContain("private provider failure");
        expect(capability.fetch).toHaveBeenCalledTimes(1);
      },
    );

    it.each([
      ["flat record", interview],
      ["missing interview", { success: true }],
      ["missing identity", { success: true, interview: { title: "Missing ID" } }],
    ])("rejects a successful response with %s", async (_description, body) => {
      capability.fetch.mockResolvedValue(response(body, successStatus));
      await expectRequestError(mutate({ capability }), "malformed-response", successStatus);
      expect(capability.fetch).toHaveBeenCalledTimes(1);
    });

    it("rejects malformed JSON with a safe error", async () => {
      const result = response(null, successStatus);
      result.text.mockResolvedValue("{private invalid JSON");
      capability.fetch.mockResolvedValue(result);
      const error = await expectRequestError(mutate({ capability }), "malformed-response", successStatus);
      expect(error.message).not.toContain("private");
      expect(capability.fetch).toHaveBeenCalledTimes(1);
    });

    it("discards a late success after capability invalidation without reading the body", async () => {
      const dispatch = deferred();
      const result = response(detail, successStatus);
      capability.fetch.mockReturnValue(dispatch.promise);
      const pending = mutate({ capability });
      capability.isCurrent.mockReturnValue(false);
      dispatch.resolve(result);
      await expectRequestError(pending, "stale-session");
      expect(result.text).not.toHaveBeenCalled();
      expect(capability.fetch).toHaveBeenCalledTimes(1);
    });

    it.each([
      { stale: true, abort: false, rejectBody: false, category: "stale-session" },
      { stale: true, abort: false, rejectBody: true, category: "stale-session" },
      { stale: false, abort: true, rejectBody: false, category: "cancelled" },
      { stale: true, abort: true, rejectBody: true, category: "cancelled" },
      { stale: false, abort: false, rejectBody: true, category: "body-read-error" },
    ])("preserves $category during body reading (stale=$stale, abort=$abort, rejection=$rejectBody)", async ({
      stale, abort, rejectBody, category,
    }) => {
      const controller = new AbortController();
      const started = deferred();
      const reading = deferred();
      const result = response(detail, successStatus);
      result.text.mockImplementation(() => {
        started.resolve();
        return reading.promise;
      });
      capability.fetch.mockResolvedValue(result);
      const pending = mutate({ capability, signal: controller.signal });
      await started.promise;
      if (stale) capability.isCurrent.mockReturnValue(false);
      if (abort) controller.abort();
      if (rejectBody) reading.reject(new Error("private body failure"));
      else reading.resolve(JSON.stringify(detail));
      const status = category === "body-read-error" ? successStatus : undefined;
      const error = await expectRequestError(pending, category, status);
      expect(error.message).not.toContain("private body failure");
      expect(capability.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe.each([
    ["PATCH", (identifier, options) => updateInterview(identifier, updates, options)],
    ["DELETE", deleteInterview],
  ])("capability %s identifiers", (method, mutate) => {
    it.each(["", null, 42, ".", "..", "../other", "id/extra", "id\\extra", "id%2Fextra", "id%5cextra",
      "%2e%2e", "id?query=1", "id#fragment", "id\n"])("rejects unsafe identifier %j", async (identifier) => {
      await expectRequestError(mutate(identifier, { capability }), "invalid-destination");
      expect(capability.fetch).not.toHaveBeenCalled();
    });

    it("still sends a segment-safe invalid ObjectId for backend validation", async () => {
      capability.fetch.mockResolvedValue(response({ success: false, message: "Invalid interview ID" }, 400));
      await expectRequestError(mutate("invalid-id", { capability }), "http-error", 400);
      expect(capability.fetch).toHaveBeenCalledExactlyOnceWith(
        `${url}/invalid-id`,
        expect.objectContaining({ method }),
      );
    });
  });
});
