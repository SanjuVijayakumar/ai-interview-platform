import { describe, expect, it, vi } from "vitest";
import { getProfile, updateProfile } from "./profileService.js";

const profile = {
  id: "a".repeat(24), name: "Profile User", email: "profile@example.test", role: "user",
  skills: [], experience: 0, targetRole: "",
};
const url = "http://localhost:5000/api/auth/profile";
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });

describe("profile service", () => {
  it("validates and projects a GET response, preserving empty values", async () => {
    const signal = new AbortController().signal;
    const fetch = vi.fn().mockResolvedValue(response({ success: true, user: { ...profile, password: "private" } }));
    await expect(getProfile({ capability: { fetch, isCurrent: () => true }, signal })).resolves.toEqual(profile);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(url, { method: "GET", signal });
  });

  it("sends only own editable fields and validates the PATCH response", async () => {
    const fetch = vi.fn().mockResolvedValue(response({ success: true, user: profile }));
    const inherited = { targetRole: "Inherited" };
    const updates = Object.assign(Object.create(inherited), profile, { password: "private" });
    delete updates.targetRole;
    await expect(updateProfile(updates, { capability: { fetch, isCurrent: () => true } })).resolves.toEqual(profile);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(url, {
      method: "PATCH", headers: new Headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ name: profile.name, skills: [], experience: 0 }), signal: undefined,
    });
  });

  it.each([
    [undefined, "missing-capability"], [{}, "invalid-capability"],
    [{ fetch: vi.fn(), isCurrent: () => false }, "stale-session"],
    [{ fetch: vi.fn(), isCurrent: () => { throw new Error("private"); } }, "invalid-capability"],
  ])("fails closed with capability %j", async (capability, category) => {
    await expect(getProfile({ capability })).rejects.toMatchObject({ category });
    await expect(updateProfile({ name: "Name" }, { capability })).rejects.toMatchObject({ category });
    if (capability?.fetch) expect(capability.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { user: profile }, { success: true }, { success: false, user: profile },
    ...Object.keys(profile).map((field) => ({ success: true, user: { ...profile, [field]: null } })),
  ])("rejects an invalid successful response %#", async (body) => {
    const capability = { fetch: vi.fn().mockImplementation(() => response(body)), isCurrent: () => true };
    await expect(getProfile({ capability })).rejects.toMatchObject({ category: "malformed-response", status: 200 });
    await expect(updateProfile({ name: profile.name }, { capability })).rejects.toMatchObject({ category: "malformed-response", status: 200 });
  });

  it.each([{ role: "admin" }, { name: " " }, { targetRole: "" }, { experience: -1 }, { skills: [""] }])(
    "rejects invalid editable payload %j without transport", async (updates) => {
      const fetch = vi.fn();
      await expect(updateProfile(updates, { capability: { fetch, isCurrent: () => true } }))
        .rejects.toMatchObject({ category: "invalid-request-options" });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("does not expose backend errors", async () => {
    const capability = {
      fetch: vi.fn().mockResolvedValue(response({ errors: { name: "private" } }, 403)),
      isCurrent: () => true,
    };
    const error = await updateProfile({ name: "Name" }, { capability }).catch((error) => error);
    expect(error).toMatchObject({ category: "http-error", status: 403 });
    expect(error).not.toHaveProperty("data");
    expect(error.message).not.toContain("private");
  });
});
