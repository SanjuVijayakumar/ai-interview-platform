import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Link, RouterProvider } from "react-router-dom";
import InterviewsPage from "./InterviewsPage.jsx";
import { createInterview, deleteInterview, getInterviews, updateInterview } from "../services/interviewService.js";

vi.mock("../services/interviewService.js", () => ({
  createInterview: vi.fn(),
  deleteInterview: vi.fn(),
  getInterviews: vi.fn(),
  updateInterview: vi.fn(),
}));

const interview = {
  _id: "interview-1",
  title: "Frontend Engineer",
  category: "Engineering",
  difficulty: "Intermediate",
  status: "completed",
  practiceStatus: "in-progress",
  createdAt: "2026-11-01T10:00:00.000Z",
};

function ReturnAfterSession() {
  return <Link to="/interviews">Return to My Interviews</Link>;
}

function renderPage() {
  const router = createMemoryRouter([
    { path: "/interviews", element: <InterviewsPage /> },
    { path: "/mock-session/:sessionId", element: <ReturnAfterSession /> },
  ], { initialEntries: ["/interviews"] });
  return { ...render(<RouterProvider router={router} />), router };
}

beforeEach(() => {
  getInterviews.mockResolvedValue([interview]);
  createInterview.mockResolvedValue({ _id: "new-interview" });
  updateInterview.mockResolvedValue({ ...interview });
  deleteInterview.mockResolvedValue({});
});

afterEach(() => cleanup());

describe("InterviewsPage practice status", () => {
  it("uses practiceStatus for cards with consistent labels and styles", async () => {
    getInterviews.mockResolvedValue([
      { ...interview, _id: "scheduled", title: "Scheduled practice", status: "completed", practiceStatus: "scheduled" },
      { ...interview, _id: "active", title: "Active practice", status: "completed", practiceStatus: "in-progress" },
      { ...interview, _id: "done", title: "Completed practice", status: "scheduled", practiceStatus: "completed" },
    ]);
    renderPage();

    expect(await screen.findByText("Scheduled practice")).toBeInTheDocument();
    expect(screen.getByLabelText("Practice status: Scheduled")).toHaveClass("theme-status-warning");
    expect(screen.getByLabelText("Practice status: In Progress")).toHaveClass("theme-status-info");
    expect(screen.getByLabelText("Practice status: Completed")).toHaveClass("theme-status-success");
  });

  it.each([
    { practiceStatus: undefined, storedStatus: "completed" },
    { practiceStatus: "unknown", storedStatus: "in-progress" },
  ])("shows an unavailable label for missing or unknown practiceStatus", async ({ practiceStatus, storedStatus }) => {
    const item = { ...interview, status: storedStatus };
    if (practiceStatus !== undefined) item.practiceStatus = practiceStatus;
    else delete item.practiceStatus;
    getInterviews.mockResolvedValue([item]);
    renderPage();

    expect(await screen.findByText("Frontend Engineer")).toBeInTheDocument();
    expect(screen.getByLabelText("Practice status: Practice status unavailable")).toBeInTheDocument();
    expect(screen.queryByLabelText("Practice status: Completed")).not.toBeInTheDocument();
  });

  it("keeps manual status in the edit form, excludes practiceStatus from PATCH, and reloads derived status", async () => {
    const user = userEvent.setup();
    getInterviews
      .mockResolvedValueOnce([interview])
      .mockResolvedValueOnce([{ ...interview, status: "scheduled", practiceStatus: "completed" }]);
    updateInterview.mockResolvedValue({ ...interview, practiceStatus: "in-progress" });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const manualStatus = screen.getByLabelText(/Manual interview status/);
    expect(manualStatus).toHaveValue("completed");
    expect(screen.getByText("Manually managed; practice progress is calculated from mock sessions.")).toBeInTheDocument();
    await user.selectOptions(manualStatus, "scheduled");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(getInterviews).toHaveBeenCalledTimes(2));
    expect(updateInterview).toHaveBeenCalledWith("interview-1", {
      title: "Frontend Engineer",
      category: "Engineering",
      difficulty: "Intermediate",
      status: "scheduled",
    });
    expect(updateInterview.mock.calls[0][1]).not.toHaveProperty("practiceStatus");
    expect(screen.getByLabelText("Practice status: Completed")).toBeInTheDocument();
  });

  it("does not send practiceStatus when creating an interview", async () => {
    const user = userEvent.setup();
    getInterviews
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        ...interview,
        _id: "new-interview",
        title: "New practice",
        status: "scheduled",
        practiceStatus: "scheduled",
      }]);
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Create your first interview" }));
    await user.type(screen.getByLabelText("Interview title"), "New practice");
    await user.type(screen.getByLabelText("Category"), "Engineering");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create interview" }));

    await waitFor(() => expect(getInterviews).toHaveBeenCalledTimes(2));
    expect(createInterview).toHaveBeenCalledWith({
      title: "New practice",
      category: "Engineering",
      difficulty: "Beginner",
    });
    expect(createInterview.mock.calls[0][0]).not.toHaveProperty("practiceStatus");
    expect(screen.getByLabelText("Practice status: Scheduled")).toBeInTheDocument();
  });

  it("refreshes practice status when returning after mock-session completion", async () => {
    const user = userEvent.setup();
    let interviewRequest = 0;
    getInterviews.mockImplementation(async () => {
      interviewRequest += 1;
      return [{ ...interview, practiceStatus: interviewRequest === 1 ? "in-progress" : "completed" }];
    });
    const { router } = renderPage();

    expect(await screen.findByLabelText("Practice status: In Progress")).toBeInTheDocument();
    await act(async () => { await router.navigate("/mock-session/session-1"); });
    await user.click(screen.getByRole("link", { name: "Return to My Interviews" }));

    expect(await screen.findByLabelText("Practice status: Completed")).toBeInTheDocument();
    expect(getInterviews).toHaveBeenCalledTimes(2);
  });
});
