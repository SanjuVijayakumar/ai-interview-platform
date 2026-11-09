import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import DashboardLayout from "./layouts/DashboardLayout.jsx";
import DashboardPage from "./pages/DashboardPage.jsx";
import InterviewsPage from "./pages/InterviewsPage.jsx";
import InterviewDetailsPage from "./pages/InterviewDetailsPage.jsx";
import MockSessionPage from "./pages/MockSessionPage.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import ProfilePage from "./pages/ProfilePage.jsx";
import { getAuthToken, logoutUser } from "./services/authService.js";
import "./App.css";

function ProtectedRoute({ token, children }) {
  return token ? children : <Navigate to="/login" replace />;
}

function AppRoutes({ healthMessage }) {
  const [token, setToken] = useState(() => getAuthToken());
  const navigate = useNavigate();

  const handleLogin = () => {
    const savedToken = getAuthToken();
    setToken(savedToken);
    if (savedToken) navigate("/dashboard", { replace: true });
  };

  const handleLogout = () => {
    logoutUser();
    setToken(null);
    navigate("/login", { replace: true });
  };

  return (
    <Routes>
      <Route path="/login" element={token ? <Navigate to="/dashboard" replace /> : <LoginPage healthMessage={healthMessage} onLogin={handleLogin} />} />

      <Route
        element={
          <ProtectedRoute token={token}>
            <DashboardLayout onLogout={handleLogout} />
          </ProtectedRoute>
        }
      >
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/interviews" element={<InterviewsPage />} />
        <Route path="/interviews/:interviewId" element={<InterviewDetailsPage />} />
        <Route path="/mock-session/:sessionId" element={<MockSessionPage />} />
      </Route>

      <Route
        path="/profile"
        element={
          <ProtectedRoute token={token}>
            <ProfilePage healthMessage={healthMessage} onLogout={handleLogout} />
          </ProtectedRoute>
        }
      />

      <Route path="*" element={<Navigate to={token ? "/dashboard" : "/login"} replace />} />
    </Routes>
  );
}

function App() {
  const [healthMessage, setHealthMessage] = useState("Checking backend status...");

  useEffect(() => {
    fetch("http://localhost:5000/api/health")
      .then((response) => response.json())
      .then((data) => setHealthMessage(data.message || "Backend is available"))
      .catch((error) => {
        console.error("Backend health check failed:", error);
        setHealthMessage("Could not reach backend");
      });
  }, []);

  return (
    <BrowserRouter>
      <AppRoutes healthMessage={healthMessage} />
    </BrowserRouter>
  );
}

export default App;
