import { matchPath, Outlet, useLocation } from "react-router-dom";
import AdminNavbar from "../components/admin/AdminNavbar.jsx";
import AdminSidebar from "../components/admin/AdminSidebar.jsx";

export default function AdminLayout({ capability, groups }) {
  const { pathname } = useLocation();
  const page = groups.flatMap(({ pages }) => pages).find(({ path }) => matchPath(`/admin/${path}`, pathname));
  const title = page?.title ?? (matchPath("/admin", pathname) ? "Dashboard" : "Page unavailable");

  return (
    <div className="theme-app-shell min-h-screen font-sans lg:flex">
      <AdminSidebar groups={groups} />
      <div className="min-w-0 flex-1">
        <AdminNavbar title={title} />
        <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
          <Outlet context={{ capability }} />
        </main>
      </div>
    </div>
  );
}
