import { Outlet } from "react-router-dom";
import Navbar from "../components/dashboard/Navbar.jsx";
import Sidebar from "../components/dashboard/Sidebar.jsx";
import { VerifiedNavbar } from "../components/Navbar.jsx";
import { useAuth } from "../contexts/AuthContext.jsx";

export function AuthenticatedDashboardLayout({ capability }) {
  const { session, logout } = useAuth();
  return (
    <DashboardShell
      onLogout={logout}
      navbar={<VerifiedNavbar />}
      outletContext={{ capability, user: session.user }}
    />
  );
}

function DashboardLayout({ onLogout, ...navbarProps }) {
  return <DashboardShell onLogout={onLogout} navbar={<Navbar {...navbarProps} />} />;
}

function DashboardShell({ onLogout, navbar, outletContext }) {
  return (
    <div className="theme-app-shell flex min-h-screen font-sans">
      <Sidebar onLogout={onLogout} />

      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        {navbar}

        <main className="min-h-0 flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
          <div className="mx-auto w-full max-w-7xl">
            <Outlet context={outletContext} />
          </div>
        </main>
      </div>
    </div>
  );
}

export default DashboardLayout;
