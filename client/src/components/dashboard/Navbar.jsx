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
    <header className="flex min-h-[88px] w-full items-center justify-between gap-5 border-b border-slate-200 bg-white px-5 py-4 sm:px-8 lg:px-10">
      <div className="min-w-0">
        <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.16em] text-indigo-600">
          PREPX WORKSPACE
        </p>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="truncate font-[Manrope,sans-serif] text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
            {title ?? currentPage.title}
          </h1>
          <p className="hidden text-sm text-slate-500 md:block">
            {description ?? currentPage.description}
          </p>
        </div>
        <p className="mt-1 text-xs text-slate-500 md:hidden">
          {description ?? currentPage.description}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-3 sm:gap-5">
        <button
          type="button"
          onClick={onNotificationsClick}
          aria-label={hasNotifications ? `Notifications, ${notificationCount} unread` : "Notifications"}
          className="relative grid h-10 w-10 place-items-center rounded-xl border border-slate-200 bg-white text-slate-500 transition hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
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
            <span className="absolute right-2 top-2 h-2 w-2 rounded-full border-2 border-white bg-indigo-600" />
          )}
        </button>

        <div className="h-9 w-px bg-slate-200" aria-hidden="true" />

        <div className="flex min-w-0 items-center gap-3">
          {imageUrl ? (
            <img
              src={imageUrl}
              alt=""
              className="h-10 w-10 shrink-0 rounded-full border border-indigo-100 object-cover"
            />
          ) : (
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-indigo-100 bg-indigo-50 font-[Manrope,sans-serif] text-sm font-bold text-indigo-700">
              {getInitials(displayName)}
            </span>
          )}
          <div className="hidden min-w-0 sm:block">
            <p className="max-w-40 truncate text-sm font-semibold text-slate-800">{displayName}</p>
            <p className="max-w-40 truncate text-xs text-slate-500">{displayRole}</p>
          </div>
        </div>
      </div>
    </header>
  );
}

export default Navbar;
