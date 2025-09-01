import { firebaseConfig } from "./firebase-config.js";
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js";

function redirectIfLoggedIn() {
  // Avoid redirect loop if we're already on profile
  const p = location.pathname || '';
  if (p.endsWith('/profile.html') || p.endsWith('/profile')) return false;

  // Fast synchronous check: prefer the helper from auth-ui if available
  const helperMeta = (window.climboxAuth && typeof window.climboxAuth.getCurrentUserMeta === 'function')
    ? window.climboxAuth.getCurrentUserMeta()
    : null;

  const localMeta = (() => {
    try {
      const raw = localStorage.getItem('climbox_user');
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  })();

  const meta = helperMeta || localMeta;
  if (meta && meta.uid) {
    // Redirect to profile (absolute path used to be safe from relative pages)
    location.href = '/pages/profile.html';
    return true;
  }
  return false;
}

// Run fast check first. If no redirect yet, attach auth listener as fallback
if (!redirectIfLoggedIn()) {
  // initialize firebase app only if not initialized already
  if (!getApps().length) {
    initializeApp(firebaseConfig);
  }
  const auth = getAuth();

  // This handles the case where user has a valid session but localStorage wasn't set yet
  onAuthStateChanged(auth, (user) => {
    if (user) {
      location.href = '/pages/profile.html';
    }
  });
}
