// /public/services/setup-users.js
// Usage (after page load and when firebase app is initialized):
//   import './services/setup-users.js'; 
//   // then in console: await window.createSampleUsers();
//   // to delete existing users: await window.deleteAllUsersDocs(); (BE CAREFUL)

import { getApp, getApps, initializeApp } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  getDocs,
  writeBatch,
  doc,
  setDoc,
  deleteDoc,
  serverTimestamp,
  query,
  limit
} from "https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js";

// If you already have /public/services/firebase-config.js exporting firebaseConfig,
// the script below will try to import it. If not, just paste your config here.
import { firebaseConfig } from "./firebase-config.js";

function initIfNeeded() {
  if (!getApps().length) {
    initializeApp(firebaseConfig);
  }
  return {
    auth: getAuth(),
    db: getFirestore()
  };
}

/**
 * Sample user documents to create.
 * If you want to reuse primary auth users, ensure corresponding Firebase Auth users exist.
 * These docs expect doc id == uid (so use unique uids).
 */
const SAMPLE_USERS = [
  {
    uid: "uid_demo_1",
    authEmail: "alice@example.com",
    displayName: "Alice",
    contacts: { emails: ["alice@example.com"], phones: ["+628111000111"] },
    notificationLocations: ["pulau_komodo"],
  },
  {
    uid: "uid_demo_2",
    authEmail: "bob@example.com",
    displayName: "Bob",
    contacts: { emails: ["bob@example.com"], phones: ["+628222000222"] },
    notificationLocations: ["pulau_komodo", "pulau_2"],
  },
  {
    uid: "uid_demo_3",
    authEmail: "charlie@example.com",
    displayName: "Charlie",
    contacts: { emails: ["charlie@example.com"], phones: [] },
    notificationLocations: []
  }
];

async function createUserDocs(sampleArr = SAMPLE_USERS) {
  const { db } = initIfNeeded();
  const batch = writeBatch(db);
  for (const u of sampleArr) {
    const userDocRef = doc(db, "users", u.uid);
    batch.set(userDocRef, {
      authEmail: u.authEmail,
      displayName: u.displayName,
      contacts: u.contacts || { emails: [], phones: [] },
      notificationLocations: u.notificationLocations || [],
      createdAt: serverTimestamp()
    });

    // also create userIndex entries (displayName and primary phone if exists)
    const nameKey = `displayName_${String(u.displayName).toLowerCase()}`;
    const nameIndexRef = doc(db, "userIndex", nameKey);
    batch.set(nameIndexRef, { uid: u.uid, authEmail: u.authEmail, type: "displayName" });

    if (u.contacts && u.contacts.phones && u.contacts.phones.length) {
      const phoneKey = `phone_${String(u.contacts.phones[0]).replace(/[^+\d]/g, "")}`;
      const phoneIndexRef = doc(db, "userIndex", phoneKey);
      batch.set(phoneIndexRef, { uid: u.uid, authEmail: u.authEmail, type: "phone" });
    }
  }
  await batch.commit();
  console.log("Sample users + userIndex created.");
}

/**
 * Delete all docs in a collection (batches of up to batchLimit).
 * WARNING: destructive. Use carefully.
 */
async function deleteAllDocsInCollection(collectionName, batchLimit = 400) {
  const { db } = initIfNeeded();
  const colRef = collection(db, collectionName);
  // fetch in batches
  let removed = 0;
  while (true) {
    const q = query(colRef, limit(batchLimit));
    const snap = await getDocs(q);
    if (snap.empty) break;
    const batch = writeBatch(db);
    snap.docs.forEach(d => batch.delete(doc(db, collectionName, d.id)));
    await batch.commit();
    removed += snap.size;
    console.log(`Deleted batch of ${snap.size} from ${collectionName}`);
    if (snap.size < batchLimit) break;
  }
  console.log(`Deletion finished. Total removed: ${removed}`);
}

// expose helpers to window for ad-hoc usage
window.createSampleUsers = async function(sampleArr) {
  try {
    await createUserDocs(sampleArr || SAMPLE_USERS);
    alert("createSampleUsers: success (check console)");
  } catch (err) {
    console.error("createSampleUsers error:", err);
    alert("createSampleUsers failed (see console). Check Firestore rules & auth.");
  }
};

window.deleteAllUsersDocs = async function() {
  if (!confirm("Delete ALL documents in 'users' collection? This is irreversible. Continue?")) return;
  try {
    await deleteAllDocsInCollection("users");
    alert("deleteAllUsersDocs: done (check console)");
  } catch (err) {
    console.error("deleteAllUsersDocs error:", err);
    alert("deleteAllUsersDocs failed (see console). Check Firestore rules & auth.");
  }
};

window.deleteAllUserIndexDocs = async function() {
  if (!confirm("Delete ALL documents in 'userIndex' collection? This is irreversible. Continue?")) return;
  try {
    await deleteAllDocsInCollection("userIndex");
    alert("deleteAllUserIndexDocs: done (check console)");
  } catch (err) {
    console.error("deleteAllUserIndexDocs error:", err);
    alert("deleteAllUserIndexDocs failed (see console). Check Firestore rules & auth.");
  }
};

// console.log("setup-users module loaded. Use window.createSampleUsers(), window.deleteAllUsersDocs(), window.deleteAllUserIndexDocs().");
