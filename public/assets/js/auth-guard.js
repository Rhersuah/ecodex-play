/**
 * auth-guard.js — include this AFTER api.js on every protected page.
 * Set `window.REQUIRED_ROLE` before including this script, e.g.:
 *   <script>window.REQUIRED_ROLE = 'super_admin';</script>
 * It verifies the session with the server (source of truth), redirects to
 * sign-in if not authenticated, redirects away if the role doesn't match,
 * and exposes the logged-in user as window.CURRENT_USER for the page to use.
 */
(async function authGuard() {
  try {
    // Check system-wide status FIRST. If the site is in maintenance/updating/
    // shutdown, only a super_admin is allowed through — everyone else gets
    // bounced to the animated status page.
    const statusRes = await fetch('/api/system-status');
    const statusData = await statusRes.json();
    if (statusData.status && statusData.status !== 'online') {
      try {
        const meCheck = await api.get('/auth/me');
        if (meCheck.user.role !== 'super_admin') {
          window.location.href = '/status.html';
          return;
        }
      } catch (e) {
        window.location.href = '/status.html';
        return;
      }
    }

    const { user } = await api.get('/auth/me');
    const allowed = window.REQUIRED_ROLE
      ? (Array.isArray(window.REQUIRED_ROLE) ? window.REQUIRED_ROLE : [window.REQUIRED_ROLE])
      : null;
    if (allowed && !allowed.includes(user.role)) {
      const home = { super_admin: '/super-admin/super_admin.html', admin: '/admin/admin.html', user: '/user/user.html' };
      window.location.href = home[user.role] || '/signin-signup.html';
      return;
    }
    window.CURRENT_USER = user;
    document.dispatchEvent(new CustomEvent('auth-ready', { detail: user }));
  } catch (err) {
    if (err.code === 'MUST_CHANGE_PASSWORD') {
      window.location.href = '/signin-signup.html?setup=1';
      return;
    }
    window.location.href = '/signin-signup.html';
  }
})();

async function doLogout() {
  try { await api.post('/auth/logout'); } catch (e) { /* ignore network errors on logout */ }
  clearToken();
  window.location.href = '/signin-signup.html';
}
