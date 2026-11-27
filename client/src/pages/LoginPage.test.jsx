import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../contexts/AuthContext.jsx";
import LoginPage, { ProviderBoundLoginPage } from "./LoginPage.jsx";

const token = "synthetic-prepared-login-token";
const password = "synthetic-password";
const email = "tester@example.test";
const url = "http://localhost:5000/api/auth";
const user = { id: "1".repeat(24), name: "Verified Tester", email, role: "user" };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
const accepted = () => reply({ success: true, token, user: { ...user, role: "admin" } });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function Controls() {
  const { logout, login } = useAuth();
  const navigate = useNavigate();
  return <>
    <button onClick={logout}>Test logout</button>
    <button onClick={() => void login({ email: "replacement@example.test", password })}>Test replace</button>
    <button onClick={() => navigate("/other")}>Test leave</button>
  </>;
}

function LoginUnderTest() {
  const navigate = useNavigate();
  return <ProviderBoundLoginPage onVerifiedLogin={() => navigate("/dashboard", { replace: true })} />;
}

function mount(transport, strict = false) {
  vi.stubGlobal("fetch", transport);
  const app = (
    <MemoryRouter initialEntries={["/login"]}>
      <AuthProvider>
        <Controls />
        <Routes>
          <Route path="/login" element={<LoginUnderTest />} />
          <Route path="/dashboard" element={<p>Dashboard route</p>} />
          <Route path="/other" element={<p>Other route</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{app}</StrictMode> : app);
}

function fill() {
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
}

function submit() {
  fireEvent.submit(screen.getByRole("button", { name: /sign(ing)? in/i }).closest("form"));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("validates locally, toggles password visibility and submits once in StrictMode", async () => {
  const exchange = deferred();
  const verification = deferred();
  const transport = vi.fn().mockReturnValueOnce(exchange.promise).mockReturnValueOnce(verification.promise);
  mount(transport, true);
  submit();
  expect(screen.getByRole("alert")).toHaveTextContent("Enter your email address and password");
  expect(transport).not.toHaveBeenCalled();
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Show password" }));
  expect(screen.getByLabelText("Password")).toHaveAttribute("type", "text");
  fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
  expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
  submit();
  submit();
  expect(screen.getByRole("button", { name: /signing in/i })).toBeDisabled();
  expect(transport).toHaveBeenCalledExactlyOnceWith(url + "/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }), signal: expect.any(AbortSignal), redirect: "error",
  });
  expect(localStorage.getItem("token")).toBeNull();
  await act(async () => exchange.resolve(accepted()));
  expect(localStorage.getItem("token")).toBe(token);
  expect(screen.queryByText("Dashboard route")).toBeNull();
  expect(transport).toHaveBeenNthCalledWith(2, url + "/profile", {
    method: "GET", headers: { Authorization: `Bearer ${token}` }, signal: expect.any(AbortSignal), redirect: "error",
  });
  await act(async () => verification.resolve(reply({ success: true, user })));
  expect(screen.getByText("Dashboard route")).toBeInTheDocument();
  expect(transport).toHaveBeenCalledTimes(2);
});

it.each([
  ["credentials", "Invalid email or password."],
  ["network", "Could not connect to PrepX."],
  ["malformed", "PrepX returned an invalid login response."],
  ["verification", "We could not verify your session."],
])("shows a safe %s error without navigating", async (phase, message) => {
  const transport = vi.fn().mockImplementationOnce(() => {
    if (phase === "network") throw new Error("private transport details");
    if (phase === "credentials") return reply({ message: "private backend details" }, 401);
    if (phase === "malformed") return reply({ token });
    return accepted();
  }).mockImplementationOnce(() => reply({ message: "private verification details" }, 503));
  mount(transport);
  fill();
  await act(async () => submit());
  expect(screen.getByRole("alert")).toHaveTextContent(message);
  expect(screen.getByRole("alert")).not.toHaveTextContent("private");
  expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  expect(screen.queryByText("Dashboard route")).toBeNull();
  expect(localStorage.getItem("token")).toBeNull();
  expect(transport).toHaveBeenCalledTimes(phase === "verification" ? 2 : 1);
});

it("ignores a superseded submission without navigating or reporting invalid credentials", async () => {
  const late = deferred();
  const replacement = "synthetic-replacement-login-token";
  const transport = vi.fn().mockReturnValueOnce(late.promise)
    .mockImplementationOnce(() => reply({ success: true, user, token: replacement }))
    .mockImplementationOnce(() => reply({ success: true, user }));
  mount(transport);
  fill();
  submit();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Test replace" })));
  expect(transport.mock.calls[0][1].signal.aborted).toBe(true);
  await act(async () => late.resolve(accepted()));
  expect(localStorage.getItem("token")).toBe(replacement);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("Dashboard route")).toBeNull();
  expect(transport).toHaveBeenCalledTimes(3);
});

it.each(["Test logout", "Test leave"])("prevents obsolete navigation after %s", async (action) => {
  const verification = deferred();
  const transport = vi.fn().mockImplementationOnce(accepted).mockReturnValueOnce(verification.promise);
  mount(transport);
  fill();
  await act(async () => submit());
  fireEvent.click(screen.getByRole("button", { name: action }));
  await act(async () => verification.resolve(reply({ success: true, user })));
  expect(screen.queryByText("Dashboard route")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  if (action === "Test leave") expect(screen.getByText("Other route")).toBeInTheDocument();
  else expect(localStorage.getItem("token")).toBeNull();
  expect(transport).toHaveBeenCalledTimes(2);
});

it("keeps the legacy callback and permissive token response without profile verification", async () => {
  const onLogin = vi.fn();
  const transport = vi.fn().mockImplementationOnce(() => reply({ token }));
  vi.stubGlobal("fetch", transport);
  render(<LoginPage onLogin={onLogin} />);
  fill();
  await act(async () => submit());
  expect(onLogin).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem("token")).toBe(token);
  expect(transport).toHaveBeenCalledExactlyOnceWith(url + "/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
});
