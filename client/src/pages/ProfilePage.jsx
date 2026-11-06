import { useEffect, useState } from "react";
import { getAuthToken } from "../services/authService.js";
import "../App.css";

const PROFILE_URL = "http://localhost:5000/api/auth/profile";
function profileFromApi(user) {
  return {
    name: user.name ?? "",
    email: user.email ?? "",
    skills: Array.isArray(user.skills) ? user.skills.join(", ") : (user.skills ?? ""),
    experience: user.experience === null || user.experience === undefined ? "" : String(user.experience),
    targetRole: user.targetRole ?? "",
  };
}

function errorMessageFromApi(data) {
  if (Array.isArray(data.errors)) {
    return data.errors.map((error) => error.message || error.msg || String(error)).join(" ");
  }
  if (data.errors && typeof data.errors === "object") {
    return Object.values(data.errors).flat().map((error) => typeof error === "string" ? error : error.message || error.msg || "").filter(Boolean).join(" ");
  }
  return data.message || data.error || "We couldn’t save your profile. Please check your details and try again.";
}

function ProfilePage({ healthMessage, onLogout }) {
  const [profile, setProfile] = useState(null);
  const [savedProfile, setSavedProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState({ type: "", text: "" });

  useEffect(() => {
    let cancelled = false;

    const loadProfile = async () => {
      const token = getAuthToken();
      if (!token) {
        setNotice({ type: "error", text: "You’re not signed in. Log in, then return here to view your profile." });
        setLoading(false);
        return;
      }

      try {
        const response = await fetch(PROFILE_URL, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          const message = response.status === 401
            ? data.message || "Your session is missing, invalid, or expired. Please log in again."
            : data.message || "We couldn’t load your profile. Please try again.";
          throw new Error(message);
        }

        if (!data.user) throw new Error("The profile response did not include user details.");
        if (!cancelled) {
          const loadedProfile = profileFromApi(data.user);
          setProfile(loadedProfile);
          setSavedProfile(loadedProfile);
          setNotice({ type: "", text: "" });
        }
      } catch (error) {
        if (!cancelled) {
          setNotice({ type: "error", text: error.message || "We couldn’t load your profile. Please try again." });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadProfile();
    return () => { cancelled = true; };
  }, []);

  const updateField = (field) => (event) => {
    setProfile((current) => ({ ...current, [field]: event.target.value }));
    setNotice({ type: "", text: "" });
  };

  const cancelChanges = () => {
    setProfile(savedProfile);
    setNotice({ type: "", text: "" });
  };

  const saveChanges = async (event) => {
    event.preventDefault();
    if (saving) return;

    const token = getAuthToken();
    if (!token) {
      setNotice({ type: "error", text: "Your session has ended. Please log in again to update your profile." });
      onLogout?.();
      return;
    }

    const skills = profile.skills.split(",").map((skill) => skill.trim()).filter(Boolean);
    const experience = Number(profile.experience);
    if (profile.experience.trim() === "" || !Number.isFinite(experience) || experience < 0) {
      setNotice({ type: "error", text: "Enter a valid, non-negative number of years for experience." });
      return;
    }

    setSaving(true);
    setNotice({ type: "", text: "" });
    try {
      const response = await fetch(PROFILE_URL, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: profile.name.trim(), skills, experience, targetRole: profile.targetRole.trim() }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) {
        setNotice({ type: "error", text: data.message || "Your session has expired. Please log in again." });
        onLogout?.();
        return;
      }
      if (!response.ok) throw new Error(errorMessageFromApi(data));

      const updatedUser = data.user || data.profile || data;
      if (!updatedUser || typeof updatedUser !== "object" || !("name" in updatedUser)) {
        throw new Error("Your profile was saved, but the server response did not include updated profile details.");
      }
      const updatedProfile = profileFromApi(updatedUser);
      setProfile(updatedProfile);
      setSavedProfile(updatedProfile);
      setNotice({ type: "success", text: data.message || "Your profile has been updated successfully." });
    } catch (error) {
      setNotice({ type: "error", text: error.message || "We couldn’t save your profile. Please try again." });
    } finally {
      setSaving(false);
    }
  };

  const initials = profile?.name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "U";

  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="brand" href="#profile" aria-label="PrepX home">
          <span className="brand-mark" aria-hidden="true">P</span>
          <span>PrepX<span className="brand-period">.</span></span>
        </a>
        <div className="topbar-user">
          <span className="topbar-label">Your workspace</span>
          <span className="mini-avatar" aria-hidden="true">{initials}</span>
          <button className="button button-ghost logout-button" type="button" onClick={onLogout}>Log out</button>
        </div>
      </header>

      <div className="content-wrap" id="profile">
        <nav className="breadcrumbs" aria-label="Breadcrumb">
          <span>Account</span><span className="crumb-divider">/</span><span aria-current="page">Profile</span>
        </nav>

        <section className="page-heading">
          <div>
            <p className="eyebrow">ACCOUNT SETTINGS</p>
            <h1>Your profile</h1>
            <p className="heading-copy">Manage your details and tailor your interview preparation.</p>
          </div>
          <div className="health-status" role="status" aria-live="polite">
            <span className={`status-dot ${healthMessage === "Could not reach backend" ? "status-dot-error" : ""}`} />
            <span>{healthMessage}</span>
          </div>
        </section>

        <section className="profile-card" aria-labelledby="profile-card-title">
          <div className="profile-summary">
            <div className="profile-avatar" aria-hidden="true">{initials}</div>
            <div className="summary-copy">
              <h2>{loading ? "Loading your profile…" : profile?.name || "Profile unavailable"}</h2>
              <p>{profile?.targetRole || (loading ? "Fetching profile details" : "")}</p>
            </div>
          </div>

          <div className="card-divider" />

          <div className="profile-form">
            <div className="section-intro">
              <div>
                <h2 id="profile-card-title">Personal information</h2>
                <p>Keep your profile up to date for a more relevant preparation experience.</p>
              </div>
            </div>

            {loading ? (
              <div className="profile-loading" role="status"><span className="loading-spinner" />Loading your profile from your account…</div>
            ) : !profile ? (
              <p className={`form-notice notice-${notice.type || "error"}`} role="alert">{notice.text || "Your profile could not be loaded."}</p>
            ) : (
              <form onSubmit={saveChanges}>
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="name">Full name</label>
                  <input id="name" type="text" autoComplete="name" value={profile.name} onChange={updateField("name")} required />
                </div>
                <div className="field">
                  <label htmlFor="email">Email address <span className="label-note">(read-only)</span></label>
                  <div className="input-with-icon">
                    <input id="email" type="email" autoComplete="email" value={profile.email} readOnly aria-describedby="email-help" />
                    <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4.5" y="8.5" width="11" height="8" rx="1.5"/><path d="M7 8.5V6a3 3 0 0 1 6 0v2.5"/></svg>
                  </div>
                  <span className="field-help" id="email-help">Your email address can’t be changed here.</span>
                </div>
                <div className="field field-wide">
                  <label htmlFor="skills">Skills</label>
                  <input id="skills" type="text" value={profile.skills} onChange={updateField("skills")} placeholder="e.g. React, Node.js, MongoDB" />
                  <span className="field-help">Separate skills with commas.</span>
                </div>
                <div className="field">
                  <label htmlFor="experience">Experience</label>
                  <div className="input-suffix">
                    <input id="experience" type="number" min="0" step="any" value={profile.experience} onChange={updateField("experience")} required />
                    <span>years</span>
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="targetRole">Target role</label>
                  <input id="targetRole" type="text" value={profile.targetRole} onChange={updateField("targetRole")} />
                </div>
              </div>
              <div className="form-actions">
                <button className="button button-secondary" type="button" onClick={cancelChanges} disabled={saving}>Cancel</button>
                <button className="button button-primary" type="submit" disabled={saving}>
                  {saving && <span className="button-spinner" aria-hidden="true" />}{saving ? "Saving…" : "Save Changes"}
                </button>
              </div>
              {notice.text && <p className={`form-notice notice-${notice.type}`} role={notice.type === "error" ? "alert" : "status"}>{notice.text}</p>}
              </form>
            )}
          </div>
        </section>

        <footer className="page-footer"><span>PREPARED FOR WHAT’S NEXT</span><span>Profile details are saved to your account.</span></footer>
      </div>
    </main>
  );
}

export default ProfilePage;
