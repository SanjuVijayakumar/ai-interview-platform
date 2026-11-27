import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { CapabilityBoundProfilePage } from "./ProfilePage.jsx";
import ProtectedSessionBoundary from "../components/auth/ProtectedSessionBoundary.jsx";
import { VerifiedNavbar } from "../components/Navbar.jsx";
import { AuthProvider, useAuth } from "../contexts/AuthContext.jsx";

const token = "synthetic-profile-token";
const user = {
  id: "a".repeat(24), name: "Original Name", email: "original@example.test", role: "user",
  skills: [], experience: 0, targetRole: "Developer",
};
const updated = { ...user, name: "Updated Name", targetRole: "Engineer" };
const reply = (profile = user) => new Response(JSON.stringify({ success: true, user: profile }));
const denied = (status) => new Response(JSON.stringify({ message: "private backend details" }), { status });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function Controls() {
  const { verifySession, logout, completeLogin } = useAuth();
  return <>
    <button onClick={() => void verifySession()}>Verify</button>
    <button onClick={logout}>Sign out test</button>
    <button onClick={() => void completeLogin()}>Complete login test</button>
  </>;
}

async function mount({ read = () => reply(), strict = false, select = (value) => value } = {}) {
  localStorage.setItem("token", token);
  const transport = vi.fn().mockRejectedValue(new Error("Unexpected request"))
    .mockImplementationOnce(() => reply());
  if (strict) transport.mockImplementationOnce(() => reply());
  transport.mockImplementationOnce(read);
  vi.stubGlobal("fetch", transport);
  const tree = (selectCapability) => (
    <MemoryRouter initialEntries={["/profile"]}>
      <AuthProvider>
        <Controls />
        <Routes>
          <Route path="/profile" element={<ProtectedSessionBoundary>
            {({ capability }) => <>
              <VerifiedNavbar />
              <CapabilityBoundProfilePage capability={selectCapability(capability)} />
            </>}
          </ProtectedSessionBoundary>} />
          <Route path="/login" element={<p>Login route</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
  let view;
  await act(async () => { view = render(strict ? <StrictMode>{tree(select)}</StrictMode> : tree(select)); });
  return { transport, unmount: view.unmount, replace: (next) => view.rerender(tree(next)) };
}

function assertCall(transport, index, method, bearer = token) {
  const [url, options] = transport.mock.calls[index];
  expect(url).toBe("http://localhost:5000/api/auth/profile");
  expect(options.method).toBe(method);
  expect(new Headers(options.headers).get("Authorization")).toBe(`Bearer ${bearer}`);
  expect(options.signal).toBeInstanceOf(AbortSignal);
  return options;
}

function fill() {
  fireEvent.change(screen.getByLabelText("Full name"), { target: { value: " Updated Name " } });
  fireEvent.change(screen.getByLabelText("Target role"), { target: { value: " Engineer " } });
}

function submit() {
  fireEvent.submit(screen.getByRole("button", { name: /sav(e changes|ing)/i }).closest("form"));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("loads the profile, submits one exact PATCH and refreshes the verified Navbar", async () => {
  const { transport } = await mount();
  assertCall(transport, 1, "GET");
  expect(screen.getByLabelText(/email address/i)).toHaveProperty("readOnly", true);
  expect(screen.getByLabelText(/email address/i)).toHaveValue(user.email);
  expect(screen.getByLabelText("Experience")).toHaveValue(0);
  expect(screen.getByLabelText("Skills")).toHaveValue("");
  expect(screen.queryByLabelText(/^role$/i)).toBeNull();
  const patch = deferred();
  const verification = deferred();
  transport.mockImplementationOnce(() => patch.promise).mockImplementationOnce(() => verification.promise);
  fill();
  submit();
  submit();
  expect(transport).toHaveBeenCalledTimes(3);
  const options = assertCall(transport, 2, "PATCH");
  expect(new Headers(options.headers).get("Content-Type")).toBe("application/json");
  expect(JSON.parse(options.body)).toEqual({ name: updated.name, skills: [], experience: 0, targetRole: updated.targetRole });
  await act(async () => patch.resolve(reply(updated)));
  assertCall(transport, 3, "GET");
  expect(screen.getByRole("banner")).toHaveTextContent(user.name);
  expect(screen.getByLabelText("Full name")).toHaveValue(updated.name);
  fireEvent.change(screen.getByLabelText("Skills"), { target: { value: "Unsaved skill" } });
  await act(async () => verification.resolve(reply(updated)));
  expect(screen.getByRole("banner")).toHaveTextContent(updated.name);
  expect(screen.getByRole("banner")).toHaveTextContent("UN");
  expect(screen.getByLabelText("Skills")).toHaveValue("Unsaved skill");
  expect(screen.getByText("Your profile has been updated successfully.")).toBeInTheDocument();
  expect(transport).toHaveBeenCalledTimes(4);
});

it("refreshes again when verification joins a pre-save GET that returns the old name", async () => {
  const { transport } = await mount();
  const previous = deferred();
  transport.mockImplementationOnce(() => previous.promise)
    .mockImplementationOnce(() => reply(updated))
    .mockImplementationOnce(() => reply(updated));
  fireEvent.click(screen.getByRole("button", { name: "Verify" }));
  fill();
  await act(async () => submit());
  expect(transport).toHaveBeenCalledTimes(4);
  await act(async () => previous.resolve(reply()));
  assertCall(transport, 4, "GET");
  expect(screen.getByRole("banner")).toHaveTextContent(updated.name);
});

it("reports a confirmed save separately from recoverable verification failure", async () => {
  const { transport } = await mount();
  transport.mockImplementationOnce(() => reply(updated)).mockImplementationOnce(() => denied(503));
  fill();
  await act(async () => submit());
  expect(screen.getByText("Your profile was saved. We could not confirm the refreshed account identity.")).toBeInTheDocument();
  expect(screen.getByRole("banner")).toHaveTextContent(user.name);
  expect(screen.getByLabelText("Full name")).toHaveValue(updated.name);
  expect(transport).toHaveBeenCalledTimes(4);
});

it.each(["network", "malformed success", "server failure"])("recovers from uncertain %s via GET only", async (kind) => {
  const { transport } = await mount();
  transport.mockImplementationOnce(() => {
    if (kind === "network") throw new Error("private backend details");
    if (kind === "malformed success") return new Response("{}");
    return denied(500);
  }).mockImplementationOnce(() => reply(updated));
  fill();
  await act(async () => submit());
  expect(screen.getByRole("alert")).toHaveTextContent("We could not confirm the save.");
  expect(screen.getByRole("alert")).not.toHaveTextContent("private");
  expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
  expect(transport).toHaveBeenCalledTimes(3);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reload profile" })));
  assertCall(transport, 3, "GET");
  expect(screen.getByLabelText("Full name")).toHaveValue(updated.name);
  expect(screen.getByRole("button", { name: "Save Changes" })).toBeEnabled();
  expect(transport).toHaveBeenCalledTimes(4);
});

it("validates experience and preserves an originally blank optional target role", async () => {
  const blank = { ...user, targetRole: "" };
  const { transport } = await mount({ read: () => reply(blank) });
  fireEvent.change(screen.getByLabelText("Experience"), { target: { value: "-1" } });
  submit();
  expect(screen.getByRole("alert")).toHaveTextContent("non-negative number");
  expect(transport).toHaveBeenCalledTimes(2);
  fireEvent.change(screen.getByLabelText("Experience"), { target: { value: "0" } });
  transport.mockImplementationOnce(() => reply(blank)).mockImplementationOnce(() => reply(blank));
  await act(async () => submit());
  expect(JSON.parse(assertCall(transport, 2, "PATCH").body))
    .toEqual({ name: user.name, skills: [], experience: 0 });
});

it.each([401, 403])("lets the provider and boundary handle a current PATCH %s", async (status) => {
  const { transport } = await mount();
  transport.mockImplementationOnce(() => denied(status));
  await act(async () => submit());
  if (status === 401) {
    expect(screen.getByText("Login route")).toBeInTheDocument();
    expect(localStorage.getItem("token")).toBeNull();
  } else {
    expect(screen.getByRole("alert")).toHaveTextContent("You do not have permission to update");
    expect(localStorage.getItem("token")).toBe(token);
  }
  expect(transport).toHaveBeenCalledTimes(3);
});

it.each([401, 403])("handles a current profile GET %s", async (status) => {
  const { transport } = await mount({ read: () => denied(status) });
  assertCall(transport, 1, "GET");
  if (status === 401) {
    expect(screen.getByText("Login route")).toBeInTheDocument();
    expect(localStorage.getItem("token")).toBeNull();
  } else {
    expect(screen.getByRole("alert")).toHaveTextContent("You do not have permission to view");
    expect(localStorage.getItem("token")).toBe(token);
  }
  expect(transport).toHaveBeenCalledTimes(2);
});

it.each(["load", "save"])("aborts a pending %s at logout and suppresses the late result", async (phase) => {
  const pending = deferred();
  const { transport } = await mount({ read: phase === "load" ? () => pending.promise : undefined });
  if (phase === "save") {
    transport.mockImplementationOnce(() => pending.promise);
    submit();
  }
  const options = assertCall(transport, phase === "load" ? 1 : 2, phase === "load" ? "GET" : "PATCH");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign out test" })));
  expect(options.signal.aborted).toBe(true);
  await act(async () => pending.resolve(reply(updated)));
  expect(screen.getByText("Login route")).toBeInTheDocument();
  expect(transport).toHaveBeenCalledTimes(phase === "load" ? 2 : 3);
});

it.each(["success", "401", "failure", "same-user relogin"])("isolates an old save after replacement (%s)", async (outcome) => {
  const { transport } = await mount();
  const pending = deferred();
  const replacement = outcome === "same-user relogin" ? user : {
    ...user, id: "b".repeat(24), name: "Replacement User", email: "replacement@example.test",
  };
  const nextToken = outcome === "same-user relogin" ? token : "synthetic-replacement-token";
  transport.mockImplementationOnce(() => pending.promise)
    .mockImplementationOnce(() => reply(replacement)).mockImplementationOnce(() => reply(replacement));
  fill();
  submit();
  const old = assertCall(transport, 2, "PATCH");
  localStorage.setItem("token", nextToken);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Complete login test" })));
  assertCall(transport, 3, "GET", nextToken);
  assertCall(transport, 4, "GET", nextToken);
  expect(old.signal.aborted).toBe(true);
  fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Unsaved replacement edit" } });
  await act(async () => {
    if (outcome === "failure") pending.reject(new Error("late failure"));
    else pending.resolve(outcome === "401" ? denied(401) : reply(updated));
  });
  expect(screen.getByLabelText("Full name")).toHaveValue("Unsaved replacement edit");
  expect(screen.getByRole("banner")).toHaveTextContent(replacement.name);
  expect(localStorage.getItem("token")).toBe(nextToken);
  expect(transport).toHaveBeenCalledTimes(5);
});

it.each([undefined, {}, { fetch: vi.fn(), isCurrent: () => false }])(
  "rejects missing, invalid or stale capabilities before profile transport %#", async (supplied) => {
    const { transport } = await mount({ select: () => supplied });
    expect(screen.getByRole("alert")).toHaveTextContent("authentication session for your profile is unavailable");
    expect(transport).toHaveBeenCalledTimes(1);
    if (supplied?.fetch) expect(supplied.fetch).not.toHaveBeenCalled();
  },
);

it("rejects a replacement capability while aborting the prior read", async () => {
  const pending = deferred();
  const { replace, transport } = await mount({ read: () => pending.promise });
  const options = assertCall(transport, 1, "GET");
  const replacement = { fetch: vi.fn(), isCurrent: () => true };
  replace(() => replacement);
  expect(options.signal.aborted).toBe(true);
  expect(screen.getByRole("alert")).toHaveTextContent("authentication session for your profile is unavailable");
  await act(async () => pending.resolve(reply()));
  expect(replacement.fetch).not.toHaveBeenCalled();
  expect(transport).toHaveBeenCalledTimes(2);
});

it("aborts on unmount and performs one profile read in StrictMode", async () => {
  const { transport, unmount } = await mount({ strict: true });
  const reads = transport.mock.calls.filter(([, options]) => options.headers instanceof Headers);
  expect(reads).toHaveLength(1);
  expect(screen.getByLabelText("Full name")).toHaveValue(user.name);
  const pending = deferred();
  transport.mockImplementationOnce(() => pending.promise);
  submit();
  const options = assertCall(transport, transport.mock.calls.length - 1, "PATCH");
  unmount();
  expect(options.signal.aborted).toBe(true);
  const count = transport.mock.calls.length;
  await act(async () => pending.resolve(reply(updated)));
  expect(transport).toHaveBeenCalledTimes(count);
});
