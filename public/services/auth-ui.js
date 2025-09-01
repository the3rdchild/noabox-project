// /public/services/auth-ui.js
// Load as module in your pages: <script type="module" src="../services/auth-ui.js"></script>

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut as fbSignOut } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

/**
 * Update the <li data-user-link> content and href depending on user.
 * Expected DOM snippet in header:
 * <li class="nav-item d-flex align-items-center" data-user-link>
 *   <a href="../pages/sign-in.html" class="nav-link ...">...</a>
 * </li>
 */
function updateUserLink(user) {
  const wrapper = document.querySelector('[data-user-link]');
  if (!wrapper) return;

  // find anchor inside li (if present), otherwise use wrapper
  let anchor = wrapper.querySelector('a');
  if (!anchor) {
    // create a fallback anchor
    anchor = document.createElement('a');
    anchor.className = 'nav-link text-body font-weight-bold px-0';
    wrapper.appendChild(anchor);
  }

  if (user) {
    // If logged in, point to profile and show avatar/name (if available)
    anchor.setAttribute('href', '../pages/profile.html');

    const displayName = user.displayName || user.email || 'Profile';
    const photoURL = user.photoURL || '';

    if (photoURL) {
      anchor.innerHTML = `
        <img src="${photoURL}" alt=""
             style="width:28px;height:28px;border-radius:50%;object-fit:cover;margin-right:6px;vertical-align:middle;">
        <span class="d-none d-sm-inline"></span>
      `;
    } else {
      // fallback to material icon + name on larger screens
      anchor.innerHTML = `
        <i class="material-symbols-rounded">account_circle</i>
        <span class="d-none d-sm-inline" style="margin-left:6px"></span>
      `;
    }
  } else {
    // Not logged in: link to sign-in and show icon only
    anchor.setAttribute('href', '../pages/sign-in.html');
    anchor.innerHTML = `<i class="material-symbols-rounded">account_circle</i>`;
  }
}

// keep a minimal local copy of user meta for UI convenience
function saveLocalUser(user) {
  if (user) {
    const meta = { uid: user.uid, email: user.email, displayName: user.displayName, photoURL: user.photoURL };
    localStorage.setItem('climbox_user', JSON.stringify(meta));
  } else {
    localStorage.removeItem('climbox_user');
  }
}

// listen auth state
onAuthStateChanged(auth, (user) => {
  updateUserLink(user);
  saveLocalUser(user);
});

// Expose helper functions to window for sign out etc.
window.climboxAuth = {
  signOut: async () => {
    try {
      await fbSignOut(auth);
      // optional redirect after sign out
      // location.href = '/pages/sign-in.html';
    } catch (err) {
      console.error('Sign out error', err);
      alert('Sign out failed. See console for details.');
    }
  },
  getCurrentUserMeta: () => {
    const raw = localStorage.getItem('climbox_user');
    return raw ? JSON.parse(raw) : null;
  }
};
