const express = require('express');
const db = require('../db');
const {
  hashPassword, verifyPassword, signSessionToken, signSetupToken,
} = require('../auth');
const { requireAuth, requireSetupToken } = require('../middleware/requireAuth');

const router = express.Router();

function publicUser(u) {
  const { password_hash, ...rest } = u;
  return rest;
}

const crypto = require('crypto');
const liveEvents = require('../liveEvents');
const { sendVerificationEmail } = require('../utils/email');
const { makeUploader } = require('../utils/upload');
const idUpload = makeUploader('signup-ids');

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ------------------------------------------------------------------
// SIGN UP — users only. There is intentionally no way to sign up as
// admin or super_admin here. Admin accounts are created exclusively by
// a super_admin through /api/superadmin/admins.
//
// NEW ACCOUNTS ARE NOT USABLE YET: they must (1) verify their email with a
// code sent to the address they registered, then (2) be approved by an
// Admin or Super Admin. Only after both steps can they log in. This
// prevents fake/throwaway emails and gives staff a final human check.
//
// NOTE ON SESSIONS: the login token is returned in the JSON response body
// (not set as a cookie). The frontend stores it in sessionStorage, which
// is scoped per browser TAB — this means logging in as a different role
// in one tab never affects the session in another open tab.
// ------------------------------------------------------------------
router.post('/signup', idUpload.fields([{ name: 'idPhoto', maxCount: 1 }, { name: 'selfiePhoto', maxCount: 1 }]), async (req, res) => {
  const { fullName, email, mobile, address, username, password, confirmPassword } = req.body;

  if (!fullName || !email || !mobile || !address || !username || !password) {
    return res.status(400).json({ error: 'Please complete all required fields.' });
  }
  const idFile = req.files && req.files.idPhoto && req.files.idPhoto[0];
  const selfieFile = req.files && req.files.selfiePhoto && req.files.selfiePhoto[0];
  if (!idFile) {
    return res.status(400).json({ error: 'Please upload a valid ID for verification.' });
  }
  if (!selfieFile) {
    return res.status(400).json({ error: 'Please complete the live selfie verification step.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (confirmPassword !== undefined && password !== confirmPassword) {
    return res.status(400).json({ error: 'Password and confirm password do not match.' });
  }
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }

  try {
    const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
    if (existing) {
      return res.status(409).json({ error: 'This username or email is already taken.' });
    }

    const passwordHash = hashPassword(password);
    const code = generateCode();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // generous window since release now depends on staff review timing
    const idPhotoUrl = `/uploads/signup-ids/${idFile.filename}`;
    const selfiePhotoUrl = `/uploads/signup-ids/${selfieFile.filename}`;

    // Lightweight anomaly signal: same public IP + same browser/device string
    // signing up again while an earlier account from that combination is
    // still active (not already rejected). This is never shown or explained
    // to the person signing up — it only shows up as a quiet flag for staff
    // to review during account approval, since shared networks (offices,
    // households, mobile carriers) can legitimately share one IP.
    const rawIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const deviceSignature = crypto.createHash('sha256').update(rawIp + '|' + (req.headers['user-agent'] || '')).digest('hex');
    const priorFromSameDevice = db.prepare(`
      SELECT id FROM users WHERE role = 'user' AND signup_ip = ? AND approval_status != 'rejected'
    `).get(deviceSignature);
    const rejectionReason = priorFromSameDevice
      ? `Possible duplicate account — matches the device/IP signature already used by user #${priorFromSameDevice.id}.`
      : null;

    db.prepare(`
      INSERT INTO users (
        role, full_name, username, email, mobile, address, id_photo, selfie_photo, password_hash, balance, status,
        email_verified, email_verification_code, email_verification_expires_at, approval_status,
        signup_ip, rejection_reason
      )
      VALUES ('user', ?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', 0, ?, ?, 'pending_email', ?, ?)
    `).run(fullName, username, email, mobile, address, idPhotoUrl, selfiePhotoUrl, passwordHash, code, expiresAt, deviceSignature, rejectionReason);

    // NOTE: the code is intentionally NOT emailed or shown here. It is held
    // until an Admin reviews the signup and releases it, then Super Admin
    // gives final approval — only then does the code appear on the user's
    // verify-email screen. This is a manual, staff-mediated verification
    // flow rather than an automatic email-based one.
    liveEvents.broadcast('accounts', ['admin', 'super_admin']);
    res.status(201).json({
      requiresEmailVerification: true,
      email,
      message: 'Account created! Your signup is being reviewed by our team. Please keep this page open — your verification code will appear here once approved.',
    });
  } catch (err) {
    console.error('Signup failed:', err);
    res.status(500).json({ error: 'Something went wrong creating your account. Please try again.' });
  }
});

// Verifies the 6-digit code sent to the user's email. Once verified, the
// Polled by the signup page while the user waits — tells them whether
// Admin has released their code, whether Super Admin has given final
// approval to release it, and the code itself once fully released.
router.get('/code-status', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email is required.' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.status(404).json({ error: 'No account found with that email.' });
  if (user.email_verified) return res.json({ stage: 'already_verified' });

  if (!user.code_admin_approved_by) {
    return res.json({ stage: 'pending_admin' });
  }
  if (!user.code_super_admin_approved_by) {
    return res.json({ stage: 'pending_super_admin' });
  }
  res.json({ stage: 'released', code: user.email_verification_code });
});

// account moves to "pending_approval" — still cannot log in until an
// Admin/Super Admin approves it.
router.post('/verify-email', (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Email and code are required.' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.status(404).json({ error: 'No account found with that email.' });
  if (user.email_verified) return res.status(409).json({ error: 'This email is already verified.' });
  if (user.email_verification_code !== code) return res.status(400).json({ error: 'Incorrect verification code.' });
  if (new Date(user.email_verification_expires_at) < new Date()) {
    return res.status(400).json({ error: 'This code has expired. Please request a new one.' });
  }

  db.prepare(`
    UPDATE users SET email_verified = 1, email_verification_code = NULL,
      approval_status = 'pending_approval', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(user.id);

  res.json({ ok: true, message: 'Email verified! Your account is now awaiting approval from an Admin or Super Admin.' });
});

router.post('/resend-verification', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.status(404).json({ error: 'No account found with that email.' });
  if (user.email_verified) return res.status(409).json({ error: 'This email is already verified.' });

  const code = generateCode();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    UPDATE users SET email_verification_code = ?, email_verification_expires_at = ?,
      code_admin_approved_by = NULL, code_super_admin_approved_by = NULL
    WHERE id = ?
  `).run(code, expiresAt, user.id);

  res.json({ ok: true, message: 'A new verification request has been submitted for review.' });
});

// ------------------------------------------------------------------
// LOG IN — works for all roles (user, admin, super_admin). Nothing
// about the role is hardcoded; it is whatever is stored in the DB row
// found by username/email.
// ------------------------------------------------------------------
router.post('/login', (req, res) => {
  const { identifier, password } = req.body;
  if (!identifier || !password) {
    return res.status(400).json({ error: 'Username/email and password are required.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(identifier, identifier);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect username/email or password.' });
  }
  if (user.status === 'banned') {
    return res.status(403).json({ error: 'This account is banned. Please contact support.' });
  }

  if (user.approval_status === 'pending_email') {
    return res.status(403).json({
      error: 'Please verify your email before logging in.',
      code: 'PENDING_EMAIL_VERIFICATION',
      email: user.email,
    });
  }
  if (user.approval_status === 'pending_approval') {
    return res.status(403).json({
      error: 'Your account is awaiting approval from an Admin or Super Admin. Please check back soon.',
      code: 'PENDING_APPROVAL',
    });
  }
  if (user.approval_status === 'rejected') {
    return res.status(403).json({ error: 'Your account application was not approved. Please contact support.' });
  }

  if (user.must_change_password) {
    // Narrow, short-lived token — only usable against /complete-setup.
    const setupToken = signSetupToken(user);
    return res.status(200).json({
      requiresSetup: true,
      setupToken,
      passwordResetOnly: !!user.password_reset_only,
      message: user.password_reset_only
        ? 'Your password was reset. Please set a new password to continue.'
        : 'You must set your permanent username and password before continuing.',
    });
  }

  const token = signSessionToken(user);
  res.json({ user: publicUser(user), token });
});

// ------------------------------------------------------------------
// COMPLETE SETUP — the ONLY thing a temp/forced account can do.
// Used by the one-time super admin credential to become a real,
// permanent, non-temporary account with its own chosen username/password.
// ------------------------------------------------------------------
router.post('/complete-setup', requireSetupToken, (req, res) => {
  const { newUsername, newPassword, confirmPassword, fullName, email, mobile } = req.body;
  const currentUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.setupUserId);
  if (!currentUser) return res.status(404).json({ error: 'Account not found.' });

  if (!newPassword) {
    return res.status(400).json({ error: 'A new password is required.' });
  }
  if (newPassword.length < 10) {
    return res.status(400).json({ error: 'The new password must be at least 10 characters.' });
  }
  if (confirmPassword !== undefined && newPassword !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }

  const passwordHash = hashPassword(newPassword);

  if (currentUser.password_reset_only) {
    // Only the password was forgotten — everything else about the account
    // (username, name, email, mobile) stays exactly as it was.
    db.prepare(`
      UPDATE users SET password_hash = ?, must_change_password = 0, is_temp_credential = 0,
        password_reset_only = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(passwordHash, req.setupUserId);
  } else {
    // Full one-time setup (brand-new temp credential): username is required too.
    if (!newUsername) {
      return res.status(400).json({ error: 'A new username and password are required.' });
    }
    const conflict = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(newUsername, req.setupUserId);
    if (conflict) return res.status(409).json({ error: 'This username is already taken.' });

    db.prepare(`
      UPDATE users
      SET username = ?, password_hash = ?, full_name = COALESCE(?, full_name),
          email = COALESCE(?, email), mobile = COALESCE(?, mobile),
          must_change_password = 0, is_temp_credential = 0, password_reset_only = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(newUsername, passwordHash, fullName || null, email || null, mobile || null, req.setupUserId);
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.setupUserId);
  const token = signSessionToken(user);
  res.json({ user: publicUser(user), token, message: 'Your account is ready to go.' });
});

router.post('/logout', (req, res) => {
  // Nothing to clear server-side — the frontend simply discards its
  // sessionStorage token. This endpoint exists for consistency/logging.
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ------------------------------------------------------------------
// GOOGLE / FACEBOOK LOGIN
//
// These require YOUR OWN app credentials from Google Cloud Console /
// Facebook Developers — they are tied to your business identity and
// cannot be generated on your behalf. Until GOOGLE_CLIENT_ID /
// FACEBOOK_CLIENT_ID are set in .env, these routes gracefully bounce the
// user back to the sign-in page with an explanation instead of crashing.
//
// Setup guide: see README.md section "Google/Facebook Login Setup".
//
// Because this is a full-page redirect flow (not a fetch/XHR we control),
// the session token can't be returned in a JSON body. Instead, after a
// successful login we redirect to /oauth-complete.html#token=...&role=...
// — the token travels in the URL FRAGMENT, which browsers never send to
// any server (not even ours), so it never appears in server logs. That
// page's script reads the fragment, stores the token in sessionStorage,
// then redirects to the correct dashboard.
// ------------------------------------------------------------------
const OAUTH_STATE_COOKIE = 'oauth_state';

function findOrCreateOAuthUser({ provider, providerId, email, fullName }) {
  let user = email ? db.prepare('SELECT * FROM users WHERE email = ?').get(email) : null;
  if (!user) {
    user = db.prepare('SELECT * FROM users WHERE oauth_provider = ? AND oauth_id = ?').get(provider, providerId);
  }
  if (user) {
    if (user.status === 'banned') return { error: 'This account is banned.' };
    if (!user.oauth_provider) {
      db.prepare("UPDATE users SET oauth_provider = ?, oauth_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
        .run(provider, providerId, user.id);
    }
    return { user };
  }

  // Brand-new account — ALWAYS created as role 'user', same rule as normal signup.
  let username = (email ? email.split('@')[0] : provider + providerId).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 20) || 'player';
  let attempt = username;
  let n = 0;
  while (db.prepare('SELECT id FROM users WHERE username = ?').get(attempt)) {
    n += 1;
    attempt = username + n;
  }
  username = attempt;

  const randomPasswordHash = hashPassword(crypto.randomBytes(24).toString('hex'));
  const info = db.prepare(`
    INSERT INTO users (role, full_name, username, email, password_hash, oauth_provider, oauth_id, status, email_verified, approval_status)
    VALUES ('user', ?, ?, ?, ?, ?, ?, 'active', 1, 'pending_approval')
  `).run(fullName || 'Player', username, email || null, randomPasswordHash, provider, providerId);

  return { user: db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid) };
}

router.get('/google/start', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return res.redirect('/signin-signup.html?oauthError=' + encodeURIComponent('Google Login is not configured yet. Please contact the Super Admin.'));
  }
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie(OAUTH_STATE_COOKIE, state, { httpOnly: true, maxAge: 5 * 60 * 1000, sameSite: 'lax' });
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
});

router.get('/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!state || state !== req.cookies[OAUTH_STATE_COOKIE]) {
      return res.redirect('/signin-signup.html?oauthError=' + encodeURIComponent('Invalid Google login attempt. Please try again.'));
    }
    res.clearCookie(OAUTH_STATE_COOKIE);

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('No access token received from Google.');

    const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await profileRes.json();

    const { user, error } = findOrCreateOAuthUser({
      provider: 'google', providerId: profile.sub, email: profile.email, fullName: profile.name,
    });
    if (error) return res.redirect('/signin-signup.html?oauthError=' + encodeURIComponent(error));
    if (user.approval_status === 'pending_approval') {
      return res.redirect('/signin-signup.html?oauthError=' + encodeURIComponent('Your account is awaiting approval from an Admin or Super Admin.'));
    }
    if (user.approval_status === 'rejected') {
      return res.redirect('/signin-signup.html?oauthError=' + encodeURIComponent('Your account application was not approved.'));
    }

    const token = signSessionToken(user);
    res.redirect(`/oauth-complete.html#token=${encodeURIComponent(token)}&role=${user.role}`);
  } catch (err) {
    console.error('Google OAuth error:', err);
    res.redirect('/signin-signup.html?oauthError=' + encodeURIComponent('There was a problem with Google login. Please try again.'));
  }
});

router.get('/facebook/start', (req, res) => {
  const clientId = process.env.FACEBOOK_CLIENT_ID;
  const redirectUri = process.env.FACEBOOK_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return res.redirect('/signin-signup.html?oauthError=' + encodeURIComponent('Facebook Login is not configured yet. Please contact the Super Admin.'));
  }
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie(OAUTH_STATE_COOKIE, state, { httpOnly: true, maxAge: 5 * 60 * 1000, sameSite: 'lax' });
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'email,public_profile',
    state,
  });
  res.redirect('https://www.facebook.com/v19.0/dialog/oauth?' + params.toString());
});

router.get('/facebook/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!state || state !== req.cookies[OAUTH_STATE_COOKIE]) {
      return res.redirect('/signin-signup.html?oauthError=' + encodeURIComponent('Invalid Facebook login attempt. Please try again.'));
    }
    res.clearCookie(OAUTH_STATE_COOKIE);

    const tokenParams = new URLSearchParams({
      client_id: process.env.FACEBOOK_CLIENT_ID,
      client_secret: process.env.FACEBOOK_CLIENT_SECRET,
      redirect_uri: process.env.FACEBOOK_REDIRECT_URI,
      code,
    });
    const tokenRes = await fetch('https://graph.facebook.com/v19.0/oauth/access_token?' + tokenParams.toString());
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('No access token received from Facebook.');

    const profileRes = await fetch(
      `https://graph.facebook.com/me?fields=id,name,email&access_token=${tokenData.access_token}`
    );
    const profile = await profileRes.json();

    const { user, error } = findOrCreateOAuthUser({
      provider: 'facebook', providerId: profile.id, email: profile.email, fullName: profile.name,
    });
    if (error) return res.redirect('/signin-signup.html?oauthError=' + encodeURIComponent(error));
    if (user.approval_status === 'pending_approval') {
      return res.redirect('/signin-signup.html?oauthError=' + encodeURIComponent('Your account is awaiting approval from an Admin or Super Admin.'));
    }
    if (user.approval_status === 'rejected') {
      return res.redirect('/signin-signup.html?oauthError=' + encodeURIComponent('Your account application was not approved.'));
    }

    const token = signSessionToken(user);
    res.redirect(`/oauth-complete.html#token=${encodeURIComponent(token)}&role=${user.role}`);
  } catch (err) {
    console.error('Facebook OAuth error:', err);
    res.redirect('/signin-signup.html?oauthError=' + encodeURIComponent('There was a problem with Facebook login. Please try again.'));
  }
});

module.exports = router;
