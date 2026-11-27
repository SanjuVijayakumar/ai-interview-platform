import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import Navbar, { VerifiedNavbar } from "./Navbar.jsx";
import { AuthProvider } from "../contexts/AuthContext.jsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("preserves the legacy defaults, identity overrides, avatar and route title", () => {
  const view = render(<MemoryRouter initialEntries={["/profile"]}><Navbar /></MemoryRouter>);
  expect(screen.getByRole("heading", { name: "Profile" })).toBeInTheDocument();
  expect(screen.getByText("Your account")).toBeInTheDocument();
  expect(screen.getByText("Interview candidate")).toBeInTheDocument();
  expect(screen.getByText("YA")).toBeInTheDocument();
  view.rerender(<MemoryRouter><Navbar user={{ name: "Legacy User", role: "user" }}
    userName="Override Name" userRole="Candidate" avatarUrl="/avatar.png" notificationCount={0} /></MemoryRouter>);
  expect(screen.getByText("Override Name")).toBeInTheDocument();
  expect(screen.getByText("Candidate")).toBeInTheDocument();
  expect(view.container.querySelector("img")).toHaveAttribute("src", "/avatar.png");
  expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument();
});

it("presents provider identity and initials using the provider's only GET", async () => {
  localStorage.setItem("token", "synthetic-navbar-token");
  localStorage.setItem("user", JSON.stringify({ name: "Storage User" }));
  const transport = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, user: {
    id: "b".repeat(24), name: "Verified User", email: "verified@example.test", role: "user",
  } })));
  vi.stubGlobal("fetch", transport);
  render(<MemoryRouter><AuthProvider><VerifiedNavbar /></AuthProvider></MemoryRouter>);
  expect(await screen.findByText("Verified User")).toBeInTheDocument();
  expect(screen.getByText("VU")).toBeInTheDocument();
  expect(screen.queryByText("Storage User")).toBeNull();
  expect(transport).toHaveBeenCalledTimes(1);
  const [url, options] = transport.mock.calls[0];
  expect(url).toBe("http://localhost:5000/api/auth/profile");
  expect(options.method).toBe("GET");
  expect(new Headers(options.headers).get("Authorization")).toBe("Bearer synthetic-navbar-token");
});
