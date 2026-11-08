import { NavLink } from "react-router-dom";

const navigationItems = [
  {
    label: "Dashboard",
    to: "/dashboard",
    icon: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
  },
  {
    label: "My Interviews",
    to: "/interviews",
    icon: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M16 3v4M8 3v4M3 11h18M8 15h3m-3 3h7" />
      </>
    ),
  },
  {
    label: "Profile",
    to: "/profile",
    icon: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M5 21v-1a7 7 0 0 1 14 0v1" />
      </>
    ),
  },
];

function Sidebar({ onLogout }) {
  return (
    <aside className="theme-sidebar flex h-screen w-20 shrink-0 flex-col border-r px-3 py-6 shadow-sm sm:w-64 sm:px-5">
      <NavLink
        to="/dashboard"
        aria-label="PrepX dashboard"
        className="mb-10 flex items-center justify-center gap-3 rounded-xl px-1 py-2 sm:justify-start sm:px-2"
      >
        <span className="theme-logo-mark flex h-10 w-10 shrink-0 items-center justify-center rounded-xl theme-primary-button text-lg font-bold theme-text-primary shadow-sm theme-shadow-green">
          P
        </span>
        <span className="hidden text-xl font-bold tracking-tight theme-text-primary sm:inline">
          Prep<span className="theme-text-accent">X</span>
        </span>
      </NavLink>

      <nav aria-label="Main navigation" className="flex-1 space-y-2">
        {navigationItems.map(({ label, to, icon }) => (
          <NavLink
            key={to}
            to={to}
            title={label}
            className={({ isActive }) =>
              `group flex items-center justify-center gap-3 rounded-xl px-3 py-3 text-sm font-medium transition-colors duration-200 sm:justify-start ${
                isActive
                  ? "theme-sidebar-active"
                  : "theme-sidebar-link"
              }`
            }
          >
            <svg
              aria-hidden="true"
              className="h-5 w-5 shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {icon}
            </svg>
            <span className="hidden sm:inline">{label}</span>
          </NavLink>
        ))}
      </nav>

      <button
        type="button"
        onClick={onLogout}
        title="Log out"
        className="theme-sidebar-logout flex items-center justify-center gap-3 rounded-xl px-3 py-3 text-sm font-medium transition-colors duration-200 sm:justify-start"
      >
        <svg
          aria-hidden="true"
          className="h-5 w-5 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M10 17l5-5-5-5m5 5H3" />
          <path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6" />
        </svg>
        <span className="hidden sm:inline">Log out</span>
      </button>
    </aside>
  );
}

export default Sidebar;
