import { useEffect, useState } from "react";
import LoginPage from "./pages/LoginPage.jsx";
import ProfilePage from "./pages/ProfilePage.jsx";
import { getAuthToken, logoutUser } from "./services/authService.js";
import "./App.css";

function App() {
  const [healthMessage, setHealthMessage] = useState("Checking backend status...");
  const [token, setToken] = useState(() => getAuthToken());

  useEffect(() => {
    fetch("http://localhost:5000/api/health")
      .then((response) => response.json())
      .then((data) => setHealthMessage(data.message || "Backend is available"))
      .catch((error) => {
        console.error("Backend health check failed:", error);
        setHealthMessage("Could not reach backend");
      });
  }, []);

  const handleLogin = () => setToken(getAuthToken());
  const handleLogout = () => {
    logoutUser();
    setToken(null);
  };

  return token
    ? <ProfilePage healthMessage={healthMessage} onLogout={handleLogout} />
    : <LoginPage healthMessage={healthMessage} onLogin={handleLogin} />;
}

export default App;
