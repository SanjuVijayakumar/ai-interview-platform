const statusPresentation = {
  scheduled: {
    label: "Scheduled",
    tone: "theme-status-warning",
  },
  "in-progress": {
    label: "In Progress",
    tone: "theme-status-info",
  },
  completed: {
    label: "Completed",
    tone: "theme-status-success",
  },
};

function InterviewPracticeStatusBadge({ practiceStatus }) {
  const presentation = statusPresentation[practiceStatus];
  const label = presentation?.label || "Practice status unavailable";
  const tone = presentation?.tone || "border theme-border-subtle theme-inset-surface theme-text-muted";

  return (
    <span
      aria-label={`Practice status: ${label}`}
      className={`inline-flex w-fit rounded-full border border-transparent px-3 py-1 text-xs font-semibold ${tone}`}
    >
      {label}
    </span>
  );
}

export default InterviewPracticeStatusBadge;
