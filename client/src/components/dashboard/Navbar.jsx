import { useLocation } from "react-router-dom";

const pageDetails = {
  "/dashboard": {
    title: "Dashboard",
    description: "Your interview preparation, all in one place.",
  },
  "/interviews": {
    title: "My Interviews",
    description: "Review your practice sessions and keep building confidence.",
  },
  "/profile": {
    title: "Profile",
    description: "Manage your details and tailor your interview preparation.",
  },
};

function getInitials(name) {
  return name
    ?.trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "U";
}

function Navbar({
  title,
  description,
  user = {},
  userName,
  userRole,
  avatarUrl,
  notificationCount = 1,
  onNotificationsClick,
}) {
  const { pathname } = useLocation();
  const currentPage = pageDetails[pathname] || pageDetails["/dashboard"];
  const displayName = userName ?? user.name ?? "Your account";
  const displayRole = userRole ?? user.role ?? "Interview candidate";
  const imageUrl = avatarUrl ?? user.avatarUrl ?? user.avatar;
  const hasNotifications = Number(notificationCount) > 0;

  return (
    <header className="theme-navbar flex min-h-[88px] w-full items-center justify-between gap-5 border-b px-5 py-4 sm:px-8 lg:px-10">
      <div className="min-w-0">
        <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.16em] theme-text-accent">
          PREPX WORKSPACE
        </p>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="truncate font-[Manrope,sans-serif] text-xl font-bold tracking-tight theme-text-primary sm:text-2xl">
            {title ?? currentPage.title}
          </h1>
          <p className="hidden text-sm theme-text-secondary md:block">
            {description ?? currentPage.description}
          </p>
        </div>
        <p className="mt-1 text-xs theme-text-secondary md:hidden">
          {description ?? currentPage.description}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-3 sm:gap-5">
        <button
          type="button"
          onClick={onNotificationsClick}
          aria-label={hasNotifications ? `Notifications, ${notificationCount} unread` : "Notifications"}
          className="relative grid h-10 w-10 place-items-center rounded-xl border theme-border theme-card-surface theme-text-secondary transition theme-hover-border theme-hover-surface theme-hover-text-primary focus-visible:outline-none focus-visible:ring-2 theme-focus-ring focus-visible:ring-offset-2"
        >
          <svg
            aria-hidden="true"
            className="h-[19px] w-[19px]"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
            <path d="M10 21h4" />
          </svg>
          {hasNotifications && (
            <span className="absolute right-2 top-2 h-2 w-2 rounded-full border-2 theme-border-highlight theme-primary-button" />
          )}
        </button>

        <div className="h-9 w-px theme-raised-surface" aria-hidden="true" />

        <div className="flex min-w-0 items-center gap-3">
          {imageUrl ? (
            <img
              src={imageUrl}
              alt=""
              className="h-10 w-10 shrink-0 rounded-full border theme-border-highlight object-cover"
            />
          ) : (
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border theme-border-highlight theme-accent-soft-surface font-[Manrope,sans-serif] text-sm font-bold theme-text-accent">
              {getInitials(displayName)}
            </span>
          )}
          <div className="hidden min-w-0 sm:block">
            <p className="max-w-40 truncate text-sm font-semibold theme-text-primary">{displayName}</p>
            <p className="max-w-40 truncate text-xs theme-text-secondary">{displayRole}</p>
          </div>
        </div>
      </div>
    </header>
  );
}

export default Navbar;
