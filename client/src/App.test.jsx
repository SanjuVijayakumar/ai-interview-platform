import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App.jsx";

vi.mock("./pages/DashboardPage.jsx", () => ({ default: () => <p>Dashboard content</p> }));
vi.mock("./pages/InterviewsPage.jsx", () => ({ default: () => <p>Interviews content</p> }));
vi.mock("./pages/InterviewDetailsPage.jsx", () => ({ default: () => <p>Interview details content</p> }));
vi.mock("./pages/MockSessionPage.jsx", () => ({ default: () => <p>Mock session content</p> }));
vi.mock("./pages/ResultsPage.jsx", () => ({ default: () => <p>Results content</p> }));
vi.mock("./pages/EvaluationResultPage.jsx", () => ({ default: () => <p>Evaluation result content</p> }));
vi.mock("./pages/LoginPage.jsx", () => ({ default: () => <p>Login page</p> }));

const PROFILE_URL = "http://localhost:5000/api/auth/profile";
const profile = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  skills: ["React", "Node.js"],
  experience: 5,
  targetRole: "Senior Engineer",
};

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

function setAuthenticatedFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
    if (url === "http://localhost:5000/api/health") {
      return jsonResponse({ message: "Backend is available" });
    }

    if (url === PROFILE_URL && options.method === "PATCH") {
      const updates = JSON.parse(options.body);
      return jsonResponse({
        message: "Your profile has been updated successfully.",
        user: { ...profile, ...updates },
      });
    }

    if (url === PROFILE_URL) return jsonResponse({ user: profile });
    throw new Error(`Unexpected fetch: ${url}`);
  }));
}

function renderAtProfile() {
  window.history.replaceState({}, "", "/profile");
  return render(<App />);
}

function getSidebar() {
  return screen.getByRole("navigation", { name: "Main navigation" });
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem("token", "profile-token");
  setAuthenticatedFetch();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
  vi.unstubAllGlobals();
});

describe("Profile route integration", () => {
  it("renders the shared layout, active Profile navigation, and no standalone navigation", async () => {
    renderAtProfile();

    const sidebar = getSidebar();
    const profileLink = within(sidebar).getByRole("link", { name: "Profile" });
    expect(profileLink).toHaveClass("theme-sidebar-active");
    expect(within(screen.getByRole("banner")).getByRole("heading", { name: "Profile" })).toBeInTheDocument();

    expect(await screen.findByDisplayValue("ada@example.com")).toHaveAttribute("readonly");
    expect(screen.getByRole("heading", { name: "Your profile" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "PrepX home" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("banner")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Log out" })).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith(PROFILE_URL, {
      headers: { Authorization: "Bearer profile-token" },
    });
  });

  it("preserves navigation between Dashboard, Interviews, Results, and Profile", async () => {
    const user = userEvent.setup();
    renderAtProfile();
    const sidebar = getSidebar();

    const routes = [
      { link: "Dashboard", title: "Dashboard", content: "Dashboard content" },
      { link: "My Interviews", title: "My Interviews", content: "Interviews content" },
      { link: "My Results", title: "My Results", content: "Results content" },
      { link: "Profile", title: "Profile", content: "Personal information" },
    ];

    for (const route of routes) {
      const link = within(sidebar).getByRole("link", { name: route.link });
      await user.click(link);
      expect(within(screen.getByRole("banner")).getByRole("heading", { name: route.title })).toBeInTheDocument();
      expect(link).toHaveClass("theme-sidebar-active");
      if (route.link === "Profile") {
        expect(await screen.findByRole("heading", { name: route.content })).toBeInTheDocument();
      } else {
        expect(await screen.findByText(route.content)).toBeInTheDocument();
      }
    }
  });

  it("redirects unauthenticated visits to login", async () => {
    window.localStorage.removeItem("token");
    renderAtProfile();

    expect(await screen.findByText("Login page")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Main navigation" })).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalledWith(PROFILE_URL, expect.anything());
  });

  it("saves the expected profile payload with the bearer token", async () => {
    const user = userEvent.setup();
    renderAtProfile();

    await screen.findByDisplayValue("ada@example.com");
    await user.clear(screen.getByLabelText("Full name"));
    await user.type(screen.getByLabelText("Full name"), "Ada B. Lovelace");
    await user.clear(screen.getByLabelText("Skills"));
    await user.type(screen.getByLabelText("Skills"), "React, TypeScript");
    await user.clear(screen.getByLabelText("Experience"));
    await user.type(screen.getByLabelText("Experience"), "6.5");
    await user.clear(screen.getByLabelText("Target role"));
    await user.type(screen.getByLabelText("Target role"), "Principal Engineer");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(await screen.findByText("Your profile has been updated successfully.")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(PROFILE_URL, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer profile-token",
      },
      body: JSON.stringify({
        name: "Ada B. Lovelace",
        skills: ["React", "TypeScript"],
        experience: 6.5,
        targetRole: "Principal Engineer",
      }),
    });
  });

  it("redirects to login when the profile save reports an expired session", async () => {
    const user = userEvent.setup();
    fetch.mockImplementation(async (url, options = {}) => {
      if (url === "http://localhost:5000/api/health") return jsonResponse({ message: "Backend is available" });
      if (url === PROFILE_URL && options.method === "PATCH") {
        return jsonResponse({ message: "Session expired" }, 401);
      }
      if (url === PROFILE_URL) return jsonResponse({ user: profile });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    renderAtProfile();

    await screen.findByDisplayValue("ada@example.com");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(await screen.findByText("Login page")).toBeInTheDocument();
    expect(window.localStorage.getItem("token")).toBeNull();
  });

  it("logs out when the token is missing at save time", async () => {
    const user = userEvent.setup();
    renderAtProfile();

    await screen.findByDisplayValue("ada@example.com");
    window.localStorage.removeItem("token");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(await screen.findByText("Login page")).toBeInTheDocument();
    expect(window.localStorage.getItem("token")).toBeNull();
  });

  it("clears the session and redirects when the shared sidebar logs out", async () => {
    const user = userEvent.setup();
    renderAtProfile();

    await screen.findByDisplayValue("ada@example.com");
    await user.click(screen.getByRole("button", { name: "Log out" }));

    expect(await screen.findByText("Login page")).toBeInTheDocument();
    expect(window.localStorage.getItem("token")).toBeNull();
  });
});
