import { NavLink } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext.jsx";

const itemClass = "flex min-w-0 items-center gap-2 rounded-xl border-l-2 border-transparent px-2 py-2 text-sm font-medium transition-colors focus-visible:ring-2 theme-focus-ring";

function NavigationIcon({ path }) {
  return (
    <svg aria-hidden="true" className="h-5 w-5 shrink-0" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={path} />
    </svg>
  );
}

function SidebarLink({ to, title, icon }) {
  return (
    <NavLink end to={to} className={({ isActive }) =>
      `${itemClass} ${isActive ? "theme-sidebar-active" : "theme-sidebar-link"}`
    }>
      <NavigationIcon path={icon} />
      {title}
    </NavLink>
  );
}

export default function AdminSidebar({ groups }) {
  const { logout } = useAuth();

  return (
    <aside className="theme-sidebar px-4 py-4 lg:sticky lg:top-0 lg:h-dvh lg:w-60 lg:shrink-0 lg:overflow-y-auto lg:border-r lg:p-5">
      <NavLink to="/admin/dashboard" aria-label="PrepX Admin Panel" className="mb-4 flex items-center gap-3 rounded-xl p-2">
        <span aria-hidden="true" className="theme-logo-mark theme-primary-button grid h-10 w-10 place-items-center rounded-xl text-lg font-bold">
          P
        </span>
        <div>
          <div className="text-xl font-bold tracking-tight theme-text-primary">Prep<span className="theme-text-accent">X</span></div>
          <div className="text-xs theme-text-secondary">Admin Panel</div>
        </div>
      </NavLink>

      <nav aria-label="Administrator navigation" className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-1 lg:gap-4">
        {groups.map(({ label, pages }) => (
          <div key={label} role="group" aria-label={label} className="min-w-0">
            <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide theme-text-secondary">{label}</p>
            {pages.map(({ path, title, icon }) => (
              <SidebarLink key={path} to={`/admin/${path}`} title={title} icon={icon} />
            ))}
            {label === "Account" && (
              <>
                <SidebarLink to="/dashboard" title="User Dashboard" icon="M3 12l9-8 9 8m-2-2v10H5V10m5 10v-6h4v6" />
                <button type="button" onClick={logout} className={`${itemClass} theme-sidebar-logout w-full text-left`}>
                  <NavigationIcon path="M10 17l5-5-5-5m5 5H3m9-9h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7" />
                  Log out
                </button>
              </>
            )}
          </div>
        ))}
      </nav>
    </aside>
  );
}
