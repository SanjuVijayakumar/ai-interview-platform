import { useState } from "react";
import { loginUser } from "../services/authService.js";
import "../App.css";

function LoginPage({ onLogin, healthMessage }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");

    if (!email.trim() || !password) {
      setError("Enter your email address and password to continue.");
      return;
    }

    setLoading(true);
    try {
      await loginUser({ email: email.trim(), password });
      onLogin();
    } catch (loginError) {
      setError(loginError.message || "Unable to log in. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="page-shell login-shell">
      <header className="topbar">
        <a className="brand" href="#login" aria-label="PrepX home">
          <span className="brand-mark" aria-hidden="true">P</span>
          <span>PrepX<span className="brand-period">.</span></span>
        </a>
        <div className="health-status" role="status" aria-live="polite">
          <span className={`status-dot ${healthMessage === "Could not reach backend" ? "status-dot-error" : ""}`} />
          <span>{healthMessage}</span>
        </div>
      </header>

      <div className="login-content" id="login">
        <section className="login-card" aria-labelledby="login-title">
          <div className="login-heading">
            <p className="eyebrow">WELCOME BACK</p>
            <h1 id="login-title">Sign in to PrepX</h1>
            <p>Continue preparing for your next opportunity.</p>
          </div>

          <form className="login-form" onSubmit={handleSubmit} noValidate>
            <div className="field">
              <label htmlFor="login-email">Email address</label>
              <input
                id="login-email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </div>

            <div className="field">
              <label htmlFor="login-password">Password</label>
              <div className="password-input-wrap">
                <input
                  id="login-password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
                <button
                  className="password-toggle"
                  type="button"
                  onClick={() => setShowPassword((visible) => !visible)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                >
                  {showPassword ? "Hide" : "Show"}
                </button>
              </div>
            </div>

            {error && <p className="form-notice notice-error" role="alert">{error}</p>}

            <button className="button button-primary login-submit" type="submit" disabled={loading}>
              {loading && <span className="button-spinner" aria-hidden="true" />}
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </section>

        <footer className="page-footer login-footer"><span>PREPARED FOR WHAT’S NEXT</span></footer>
      </div>
    </main>
  );
}

export default LoginPage;
