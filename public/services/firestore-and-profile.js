// /public/services/firestore-and-profile.js
// Combined service for Firestore user operations + profile UI helpers.
// Usage: include in pages as module: <script type="module" src="../services/firestore-and-profile.js"></script>
// Requires /public/services/firebase-config.js and /public/services/auth-ui.js to also be loaded (auth-ui initializes Firebase App and Auth and keeps localStorage copy).

import { firebaseConfig } from './firebase-config.js';
import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-app.js';
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updateProfile
} from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js';
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
  collection,
  addDoc,
  query,
  where,
  getDocs,
  serverTimestamp 
} from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';

// ---------- Initialization helpers ----------
function initFirebaseOnce() {
  if (!getApps().length) {
    initializeApp(firebaseConfig);
  }
  const auth = getAuth();
  const db = getFirestore();
  return { auth, db };
}

const { auth, db } = initFirebaseOnce();

// ---------- Utility helpers ----------
function isEmail(text) {
  return typeof text === 'string' && text.includes('@');
}
function sanitizePhone(p) {
  return p ? p.replace(/[^+\d]/g, '') : p;
}

// Create a synthetic email when user supplies only a phone/wa number
function phoneToSyntheticEmail(phone) {
  const s = sanitizePhone(phone).replace(/\+/g, 'p'); // + -> p to keep safe
  return `ph_${s}@climbox.local`;
}

// ---------- Firestore user document structure (recommended) ----------
// Collection: users
// Doc id: uid (from Firebase Auth)
// Fields:
//   authEmail: string (email used for firebase auth - real or synthetic)
//   displayName: string
//   contacts: { emails: string[], phones: string[] }
//   notificationLocations: string[] (array of locationId)
//   createdAt: timestamp

// ---------- User creation (signup) ----------

export async function signUpUser({ displayName, contact, password }) {
    if (!displayName || !contact || !password) throw new Error('missing fields');
  
    const contactIsEmail = isEmail(contact);
    const authEmail = contactIsEmail ? contact : phoneToSyntheticEmail(contact);
  
    // quick uniqueness checks on userIndex (safer than scanning users)
    // But for dev, still check users collection name collisions
    const usersCol = collection(db, 'users');
    const qName = query(usersCol, where('displayName', '==', displayName));
    const snapName = await getDocs(qName);
    if (!snapName.empty) throw new Error('Display name already taken.');
  
    // Create Firebase Auth user
    const cred = await createUserWithEmailAndPassword(auth, authEmail, password);
    const user = cred.user;
    if (displayName) await updateProfile(user, { displayName });
  
    // Build initial user doc
    const userDoc = {
      authEmail,
      displayName,
      contacts: {
        emails: contactIsEmail ? [contact] : [],
        phones: contactIsEmail ? [] : [sanitizePhone(contact)]
      },
      notificationLocations: [],
      createdAt: serverTimestamp()
    };
    await setDoc(doc(db, 'users', user.uid), userDoc);

    // create userIndex entries (if allowed by rules)
    try {
      // displayName index (lowercased)
      const nameKey = `displayName_${displayName.toLowerCase()}`;
      await setDoc(doc(db, 'userIndex', nameKey), {
        uid: user.uid,
        authEmail,
        type: 'displayName'
      });
      // phone index if contact was phone
      if (!contactIsEmail) {
        const phoneKey = `phone_${sanitizePhone(contact)}`;
        await setDoc(doc(db, 'userIndex', phoneKey), {
          uid: user.uid,
          authEmail,
          type: 'phone'
        });
      }
    } catch (e) {
      // If index creation fails due to rules, log but don't break signup
      console.warn('userIndex creation failed (check rules):', e);
    }
  
    return { uid: user.uid, userDoc };
  }

// ---------- Sign in with flexible identifier (email | phone | displayName) ----------
export async function signInFlexible({ identifier, password }) {
  if (!identifier || !password) throw new Error('missing fields');

  // If identifier looks like email, try direct sign in first
  if (isEmail(identifier)) {
    return await signInWithEmailAndPassword(auth, identifier, password);
  }

  // Otherwise, search users collection for matching displayName or phone
  const usersCol = collection(db, 'users');
  // search displayName
  const qName = query(usersCol, where('displayName', '==', identifier));
  const qPhone = query(usersCol, where('contacts.phones', 'array-contains', sanitizePhone(identifier)));

  const [snapName, snapPhone] = await Promise.all([getDocs(qName), getDocs(qPhone)]);

  let docSnap = null;
  if (!snapName.empty) docSnap = snapName.docs[0];
  else if (!snapPhone.empty) docSnap = snapPhone.docs[0];

  if (!docSnap) throw new Error('User not found');

  const u = docSnap.data();
  const authEmail = u.authEmail;
  if (!authEmail) throw new Error('User has no auth email');

  // Attempt sign-in with the stored authEmail
  return await signInWithEmailAndPassword(auth, authEmail, password);
}

// ---------- Read/write user profile helpers ----------
export async function getCurrentUserDoc(uid) {
  if (!uid) return null;
  const d = await getDoc(doc(db, 'users', uid));
  return d.exists() ? d.data() : null;
}

export async function addContactEmail(uid, email) {
  if (!uid || !email) throw new Error('missing');
  await updateDoc(doc(db, 'users', uid), { 'contacts.emails': arrayUnion(email) });
}
export async function removeContactEmail(uid, email) {
  if (!uid || !email) throw new Error('missing');
  await updateDoc(doc(db, 'users', uid), { 'contacts.emails': arrayRemove(email) });
}
export async function addContactPhone(uid, phone) {
  if (!uid || !phone) throw new Error('missing');
  await updateDoc(doc(db, 'users', uid), { 'contacts.phones': arrayUnion(sanitizePhone(phone)) });
}
export async function removeContactPhone(uid, phone) {
  if (!uid || !phone) throw new Error('missing');
  await updateDoc(doc(db, 'users', uid), { 'contacts.phones': arrayRemove(sanitizePhone(phone)) });
}

export async function setNotificationLocation(uid, locationId, enabled) {
  if (!uid) throw new Error('missing uid');
  if (enabled) return await updateDoc(doc(db, 'users', uid), { notificationLocations: arrayUnion(locationId) });
  else return await updateDoc(doc(db, 'users', uid), { notificationLocations: arrayRemove(locationId) });
}

export async function overwriteNotificationLocations(uid, arr) {
  return await updateDoc(doc(db, 'users', uid), { notificationLocations: arr || [] });
}

// ---------- Profile UI wiring helpers ----------
// Expose functions that can be called from profile.html to render & bind UI elements

// Renders contact lists and notification location switches.
// Parameters (ids/selectors):
//  - contactsContainer selector where contact items will be rendered
//  - locationsContainer selector where locations list will be rendered
//  - saveButtons or event hooking is done internally
export async function mountProfileUI({
  profileRootSelector = '#profile-root',
  emailsListSelector = '#profile-emails',
  phonesListSelector = '#profile-phones',
  locationsContainerSelector = '#profile-locations'
} = {}) {
  // get currently logged user
  const localMeta = window.climboxAuth?.getCurrentUserMeta?.();
  if (!localMeta || !localMeta.uid) {
    console.warn('No local user meta. Make sure auth-ui.js is loaded and user is signed in.');
    return;
  }
  const uid = localMeta.uid;
  const userDoc = await getCurrentUserDoc(uid);
  if (!userDoc) {
    console.warn('No user doc found for uid', uid);
    return;
  }
  
  // Render emails
  const emailsList = document.querySelector(emailsListSelector);
  const phonesList = document.querySelector(phonesListSelector);
  const locContainer = document.querySelector(locationsContainerSelector);
  if (emailsList) {
    emailsList.innerHTML = '';
    const arr = (userDoc.contacts && userDoc.contacts.emails) || [];
    arr.forEach((e) => {
      const li = document.createElement('li');
      li.className = 'list-group-item border-0 px-0 d-flex justify-content-between align-items-center';
      li.innerHTML = `
        <span class="text-truncate">${e}</span>
        <div>
          <button class="btn btn-sm btn-link text-danger" data-action="remove-email" data-email="${e}">Remove</button>
        </div>
      `;
      emailsList.appendChild(li);
    });

    // attach remove handlers
    emailsList.querySelectorAll('[data-action="remove-email"]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        const email = ev.currentTarget.dataset.email;
        try {
          await removeContactEmail(uid, email);
          ev.currentTarget.closest('li').remove();
        } catch (err) { console.error(err); alert('Failed to remove email'); }
      });
    });
  }

  if (phonesList) {
    phonesList.innerHTML = '';
    const arr = (userDoc.contacts && userDoc.contacts.phones) || [];
    arr.forEach((p) => {
      const li = document.createElement('li');
      li.className = 'list-group-item border-0 px-0 d-flex justify-content-between align-items-center';
      li.innerHTML = `
        <span class="text-truncate">${p}</span>
        <div>
          <button class="btn btn-sm btn-link text-danger" data-action="remove-phone" data-phone="${p}">Remove</button>
        </div>
      `;
      phonesList.appendChild(li);
    });
    phonesList.querySelectorAll('[data-action="remove-phone"]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        const phone = ev.currentTarget.dataset.phone;
        try {
          await removeContactPhone(uid, phone);
          ev.currentTarget.closest('li').remove();
        } catch (err) { console.error(err); alert('Failed to remove phone'); }
      });
    });
  }

  // Render locations from assets/data/locations.json
  if (locContainer) {
    locContainer.innerHTML = '';
    let locations = [];
    try {
      const res = await fetch('/assets/data/locations.json');
      locations = await res.json();
    } catch (err) {
      console.error('Failed loading locations.json', err);
    }

    const subscribed = new Set(userDoc.notificationLocations || []);

    locations.forEach((loc) => {
      const li = document.createElement('li');
      li.className = 'list-group-item border-0 px-0';
      const checked = subscribed.has(loc.locationId) ? 'checked' : '';
      li.innerHTML = `
        <div class="form-check form-switch ps-0">
          <input class="form-check-input ms-auto" type="checkbox" id="notif-${loc.locationId}" data-location-id="${loc.locationId}" ${checked}>
          <label class="form-check-label text-body ms-3 text-truncate w-80 mb-0" for="notif-${loc.locationId}">${loc.name}</label>
        </div>
      `;
      locContainer.appendChild(li);
    });

    // attach change handlers
    locContainer.querySelectorAll('input[type="checkbox"][data-location-id]').forEach((ch) => {
      ch.addEventListener('change', async (ev) => {
        const locId = ev.currentTarget.dataset.locationId;
        const enable = ev.currentTarget.checked;
        try {
          await setNotificationLocation(uid, locId, enable);
        } catch (err) {
          console.error(err);
          alert('Failed to update notification location');
          // revert UI
          ev.currentTarget.checked = !enable;
        }
      });
    });
  }
}

// ---------- Convenience: expose form handlers to window ----------
// sign-up form should call: window.climboxSignUp({displayName, contact, password})
window.climboxSignUp = async function ({ displayName, contact, password }) {
  try {
    const r = await signUpUser({ displayName, contact, password });
    // after signup, user will be already signed in via Firebase Auth
    // auth-ui.js's onAuthStateChanged will update nav
    return r;
  } catch (err) {
    console.error(err);
    throw err;
  }
};

// sign-in form should call: window.climboxSignIn({identifier, password})
window.climboxSignIn = async function ({ identifier, password }) {
  try {
    const cred = await signInFlexible({ identifier, password });
    return cred;
  } catch (err) {
    console.error(err);
    throw err;
  }
};

// profile mount helper exposed globally
window.climboxMountProfileUI = mountProfileUI;

// ---------- Notes & Next steps ----------
// - This module assumes Firestore "users" collection is readable for queries used during sign-in.
//   During development you may allow reads on users to enable flexible login (by displayName or phone).
//   For production, consider creating a lightweight "userIndex" collection that contains only non-sensitive
//   mapping documents (e.g. documents keyed by username or phone that map to authEmail) so you can allow
//   unauthenticated reads to that collection for login lookup, while keeping full user profiles restricted.
// - Changing the primary auth email after signup is not handled here (that requires re-authentication and
//   updating Firebase Auth record). We store extra emails in contacts.emails for notification use only.
// - Make sure to add Firestore Security Rules that only allow users to edit their own document (doc id == request.auth.uid)
//   and prevent wide-open writes. Example rules skeleton (dev only):
//     match /databases/{database}/documents {
//       match /users/{userId} {
//         allow read: if true; // <-- during dev for flexible login only. Tighten before prod.
//         allow write: if request.auth != null && request.auth.uid == userId;
//       }
//     }
// - If you want I can also generate example HTML snippets for sign-up, sign-in and profile forms wired to these functions.

// End of file
