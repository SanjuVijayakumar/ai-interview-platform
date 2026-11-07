import { Outlet } from "react-router-dom";
import Navbar from "../components/dashboard/Navbar.jsx";
import Sidebar from "../components/dashboard/Sidebar.jsx";

function DashboardLayout({
  onLogout,
  user,
  userName,
  userRole,
  avatarUrl,
  notificationCount,
  onNotificationsClick,
}) {
  return (
    <div className="flex min-h-screen bg-slate-50 font-sans text-slate-800">
      <Sidebar onLogout={onLogout} />

      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        <Navbar
          user={user}
          userName={userName}
          userRole={userRole}
          avatarUrl={avatarUrl}
          notificationCount={notificationCount}
          onNotificationsClick={onNotificationsClick}
        />

        <main className="min-h-0 flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
          <div className="mx-auto w-full max-w-7xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

export default DashboardLayout;
