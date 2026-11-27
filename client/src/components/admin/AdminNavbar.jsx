import { useAuth } from "../../contexts/AuthContext.jsx";

export default function AdminNavbar({ title }) {
  const { session } = useAuth();
  const { name } = session.user;
  const initials = name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();

  return (
    <header className="theme-navbar flex flex-wrap items-center justify-between gap-4 border-b px-4 py-4 sm:px-6 lg:px-10">
      <div>
        <p className="mb-1 text-xs font-bold uppercase tracking-wider theme-text-accent">PrepX Administrator Workspace</p>
        <h1 className="text-2xl font-bold theme-text-primary">{title}</h1>
      </div>
      <div className="flex min-w-0 items-center gap-3">
        <span aria-hidden="true" className="theme-primary-button grid h-10 w-10 shrink-0 place-items-center rounded-xl text-sm font-bold">
          {initials}
        </span>
        <div className="min-w-0 [overflow-wrap:anywhere]">
          <p className="text-sm font-semibold theme-text-primary">{name}</p>
          <p className="text-xs theme-text-secondary">Administrator</p>
        </div>
      </div>
    </header>
  );
}
