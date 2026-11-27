import DashboardNavbar from "./dashboard/Navbar.jsx";
import { useAuth } from "../contexts/AuthContext.jsx";

export default function Navbar(props) {
  return <DashboardNavbar {...props} />;
}

export function VerifiedNavbar({ title, description, avatarUrl, notificationCount, onNotificationsClick }) {
  const { session } = useAuth();
  const user = session.status === "authenticated" ? session.user : undefined;
  return (
    <DashboardNavbar
      title={title}
      description={description}
      user={user}
      avatarUrl={user ? avatarUrl : undefined}
      notificationCount={notificationCount}
      onNotificationsClick={onNotificationsClick}
    />
  );
}
