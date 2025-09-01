(function () {
  // ---------- Helper UI functions ----------
  function $(sel) { return document.querySelector(sel); }

  function showBtnLoading(btn, loading = true) {
    if (!btn) return;
    try {
      if (loading) {
        if (!btn.dataset.orig) btn.dataset.orig = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Loading';
      } else {
        btn.disabled = false;
        if (btn.dataset.orig) {
          btn.innerHTML = btn.dataset.orig;
          delete btn.dataset.orig;
        }
      }
    } catch (e) {
      console.warn('showBtnLoading error', e);
    }
  }

  // ---------- Sign Up ----------
  async function wireSignUp() {
    const btn = $('#signup-btn');
    if (!btn) return;
    btn.addEventListener('click', async (e) => {
      const nameEl = $('#signup-name');
      const emailEl = $('#signup-email');
      const pwEl = $('#signup-password');
      const name = nameEl?.value?.trim();
      const contact = emailEl?.value?.trim();
      const password = pwEl?.value;

      if (!name || !contact || !password) {
        alert('Isi semua field: nama, email/WA, dan password.');
        return;
      }

      showBtnLoading(btn, true);
      try {
        if (typeof window.climboxSignUp !== 'function') throw new Error('climboxSignUp not available');
        await window.climboxSignUp({ displayName: name, contact, password });
        location.href = '/pages/profile.html';
      } catch (err) {
        console.error(err);
        alert(err?.message || 'Signup gagal');
      } finally {
        showBtnLoading(btn, false);
      }
    });
  }

  // ---------- Sign In ----------
  async function wireSignIn() {
    const btn = $('#signin-btn');
    if (!btn) return;
    btn.addEventListener('click', async (e) => {
      const idEl = $('#signin-email');
      const pwEl = $('#signin-password');
      const identifier = idEl?.value?.trim();
      const password = pwEl?.value;

      if (!identifier || !password) {
        alert('Isi identifier (email/name/WA) dan password.');
        return;
      }

      showBtnLoading(btn, true);
      try {
        if (typeof window.climboxSignIn !== 'function') throw new Error('climboxSignIn not available');
        await window.climboxSignIn({ identifier, password });
        location.href = '/pages/profile.html';
      } catch (err) {
        console.error(err);
        alert(err?.message || 'Login gagal');
      } finally {
        showBtnLoading(btn, false);
      }
    });
  }

  // ---------- Community notification renderer ----------
  function renderCommunityNotif(containerEl, meta) {
    if (!containerEl) return;
    const joinLink = '../sign-up.html'; // link ke komunitas (ubah kalau perlu)

    // not logged in -> minimal heading only
    if (!meta) {
      containerEl.innerHTML = `
        <h6 class="text-uppercase text-body text-xs font-weight-bolder">Log-in untuk dapatkan notifikasi:</h6>
      `;
      return;
    }

    // logged in -> show full card with join link
    const displayName = meta.displayName || meta.email || meta.name || '';
    containerEl.innerHTML = `
      <h6 class="text-uppercase text-body text-xs font-weight-bolder">Log-in untuk dapatkan notifikasi:</h6>
      <p class="text-sm">
        Silahkan masuk ke dalam komunitas climbox-project untuk dapatkan notifikasi sensor serta informasi lebih lanjut melalui link dibawah ini:
      </p>
      <p class="text-sm">
        <a href="${joinLink}" class="text-primary text-bold">Link masuk ke dalam komunitas climbox-project</a>.
      </p>
      <p class="text-sm">
        *Gunakan nomor whatsapp yang aktif untuk masuk ke dalam komunitas
      </p>
    `;
  }

  // ---------- Profile UI (avatar + header + mount lists) ----------
  function wireProfileUI() {
    // only run on profile route (but still attempt render if community card present)
    const communityEl = document.getElementById('community-notif-card');

    let meta = null;
    try {
      meta = (window.climboxAuth && typeof window.climboxAuth.getCurrentUserMeta === 'function')
        ? window.climboxAuth.getCurrentUserMeta()
        : (window.climboxAuth && window.climboxAuth.currentUser) ? window.climboxAuth.currentUser : null;
    } catch (e) {
      console.warn('Error getting user meta', e);
      meta = null;
    }

    // If community element exists, render it according to meta (logged in/out)
    if (communityEl) {
      // fallback: if no meta but localStorage holds temporary user data, use that
      if (!meta && window.localStorage) {
        try {
          const local = localStorage.getItem('climbox_user');
          if (local) {
            const parsed = JSON.parse(local);
            if (parsed) meta = parsed;
          }
        } catch (e) { /* ignore */ }
      }
      renderCommunityNotif(communityEl, meta);
    }

    // If on profile page, update avatar/info area
    if (!location.pathname.includes('/profile.html') && !location.pathname.endsWith('/profile')) {
      return;
    }

    // If still no meta, show sign-in prompt in profile content area
    if (!meta) {
      // console.warn('No user meta in profile UI — rendering sign-in prompt');
      const wrapper = document.querySelector('.profile-container') || document.body;
      const target = wrapper.querySelector('.col-auto.my-auto .h-100') || wrapper.querySelector('.card-body') || wrapper;
      if (target) {
        target.innerHTML = `
          <h5 class="mb-1">Belum Masuk</h5>
          <p class="mb-0" style="color: black;">
            Silakan <a href="/pages/sign-in.html" style="color: #007bff; text-decoration: none;">masuk</a> untuk bergabung ke dalam komunitas kita dan mendapatkan notifikasi sensor melalui Whatsapp.
          </p>
        `;
      }
      return;
    }

    // avatar image element
    const avatarImg = document.querySelector('.avatar.avatar-xl.position-relative img');
    if (avatarImg) {
      try {
        const fallback = '/assets/img/userloggedin.png';
        avatarImg.src = meta.photoURL ? meta.photoURL : fallback;
        avatarImg.alt = meta.displayName || meta.email || 'User';
      } catch (e) {
        console.warn('avatar set error', e);
      }
    }

    // Update user info in the profile (safer selector + fallback)
    const userInfoBlock = document.querySelector('.col-auto.my-auto .h-100') || document.querySelector('.profile-user-info') || null;
    if (userInfoBlock) {
      const display = meta.displayName || meta.email || 'Pengguna';
      const emailOrContact = meta.email || meta.contact || '';
      userInfoBlock.innerHTML = `
        <a>
          <h5 class="mb-1">${escapeHtml(display)} [Terdaftar]</h5>
        </a>
        <p class="mb-0 font-weight-normal text-sm">
          ${escapeHtml(emailOrContact)}
        </p>
      `;
    }

    // mount profile lists (emails, phones, locations)
    if (typeof window.climboxMountProfileUI === 'function') {
      try { setTimeout(() => window.climboxMountProfileUI(), 50); } catch (e) { console.warn('climboxMountProfileUI error', e); }
    }

    // attach sign out button if any
    const btnSignOut = document.querySelector('[data-action="signout"]');
    if (btnSignOut) {
      btnSignOut.addEventListener('click', () => {
        try {
          if (window.climboxAuth && typeof window.climboxAuth.signOut === 'function') window.climboxAuth.signOut();
          else if (window.localStorage) { localStorage.removeItem('climbox_user'); location.href = '/'; }
        } catch (e) {
          console.warn('Sign out error', e);
        }
      });
    }
  }

  // small html escape for safety
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  }

  // ---------- Init wiring on DOM ready ----------
  document.addEventListener('DOMContentLoaded', () => {
    try {
      wireSignUp();
      wireSignIn();
      wireProfileUI();
    } catch (e) {
      console.error('auth-forms-and-profile-ui init error', e);
    }
  });

})();
