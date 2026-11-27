import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { gsap } from "gsap";
import { ScrambleTextPlugin } from "gsap/ScrambleTextPlugin";
import { useAuth } from "../contexts/AuthContext.jsx";
import { loginUser } from "../services/authService.js";
import "../App.css";
import leftImage from "../assets/login-left.jpg";

gsap.registerPlugin(ScrambleTextPlugin);

const loginErrors = {
  "invalid-credentials": "Invalid email or password.",
  "network-error": "Could not connect to PrepX. Please try again.",
  "malformed-response": "PrepX returned an invalid login response. Please try again.",
  "verification-error": "We could not verify your session. Please try signing in again.",
};

export function ProviderBoundLoginPage({ healthMessage, onVerifiedLogin, onSubmissionChange }) {
  const { login } = useAuth();
  return (
    <LoginForm
      healthMessage={healthMessage}
      authenticate={login}
      onLogin={onVerifiedLogin}
      onSubmissionChange={onSubmissionChange}
      prepared
    />
  );
}

function LoginPage({ onLogin, healthMessage }) {
  return <LoginForm onLogin={onLogin} healthMessage={healthMessage} authenticate={loginUser} />;
}

function LoginForm({ onLogin, healthMessage, authenticate, prepared, onSubmissionChange }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const promoRef = useRef(null);
  const submission = useRef(null);

  useLayoutEffect(() => () => { submission.current = null; }, []);

  useEffect(() => {
    const context = gsap.context(() => {
      const lines = gsap.utils.toArray(".login-promo-line");
      gsap.from(".login-promo-copy", { opacity: 0, y: 18, duration: 0.6, ease: "power2.out" });
      gsap.to(lines, {
        duration: 1.15,
        stagger: 0.28,
        ease: "none",
        scrambleText: { chars: "upperCase", speed: 0.65 },
      });
    }, promoRef);

    return () => context.revert();
  }, []);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (prepared && submission.current) return;
    setError("");

    if (!email.trim() || !password) {
      setError("Enter your email address and password to continue.");
      return;
    }

    const attempt = {};
    submission.current = attempt;
    const active = () => !prepared || submission.current === attempt;
    let handedOff = false;
    onSubmissionChange?.(attempt, true);
    setLoading(true);
    try {
      const result = await authenticate({ email: email.trim(), password });
      if (active() && (!prepared || (result.status === "authenticated" && result.isCurrent()))) {
        if (prepared) onLogin(attempt);
        else onLogin();
        handedOff = prepared;
      }
    } catch (loginError) {
      if (active()) {
        const message = prepared ? loginErrors[loginError?.category] : loginError.message;
        setError(message || "Unable to log in. Please try again.");
      }
    } finally {
      if (active() && !handedOff) {
        submission.current = null;
        setLoading(false);
        // Only the owning form may release an unsuccessful submission.
        onSubmissionChange?.(attempt, false);
      }
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

      <div className="login-stage">
        <section className="login-left-panel" aria-label="Prepare for your next interview">
          <div className="login-image-panel" aria-hidden="true">
            <img className="login-background-image" src={leftImage} alt="" />
          </div>
          <div className="login-image-overlay" aria-hidden="true" />
          <div className="login-promo" ref={promoRef}>
            <div className="login-promo-copy">
              <p className="eyebrow">YOUR NEXT CHAPTER STARTS HERE</p>
              <h2 className="login-promo-title">
                <span className="login-promo-line">Prepare Smarter.</span>
                <span className="login-promo-line">Practice Better.</span>
                <span className="login-promo-line">Get Interview Ready.</span>
              </h2>
              <p className="login-promo-description">Build confidence with focused practice and AI-powered interview preparation.</p>
            </div>
          </div>
        </section>

        <section className="login-form-panel" aria-label="Sign in">
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
        </section>
      </div>
    </main>
  );
}

export default LoginPage;
