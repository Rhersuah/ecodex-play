require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');

// Safety net — Express 4 does NOT automatically catch errors thrown inside
// async route handlers (unlike Express 5). A handler that forgets a
// try/catch around, say, a database call would otherwise become an
// unhandled promise rejection and crash the entire server, taking down
// every user's session at once. These two handlers make sure that never
// happens: the error is logged so it's still visible and fixable, but the
// process — and everyone else's active session — keeps running.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] Kept the server alive after:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] Kept the server alive after:', reason);
});

const bootstrapSuperAdmin = require('./src/utils/bootstrapSuperAdmin');
const db = require('./src/db');
const authRoutes = require('./src/routes/auth.routes');
const accountRoutes = require('./src/routes/account.routes');
const superadminRoutes = require('./src/routes/superadmin.routes');
const adminRoutes = require('./src/routes/admin.routes');
const userRoutes = require('./src/routes/user.routes');
const sharedRoutes = require('./src/routes/shared.routes');

const app = express();

// Runs once per process start. Creates the one-time super admin credential
// ONLY if no super_admin account exists yet in the database.
bootstrapSuperAdmin();

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : true,
  credentials: true,
}));

// Serve uploaded files (proof images, avatars, shop photos, QR codes).
// Uses the same DATA_DIR as the database, since most hosts (Render included)
// only allow one persistent disk per service.
const { UPLOADS_ROOT } = require('./src/utils/upload');
app.use('/uploads', express.static(UPLOADS_ROOT));

// ------------------------------------------------------------------
// SYSTEM STATUS LOCKOUT — when the Super Admin sets the site to
// maintenance/updating/shutdown, block every API call from anyone who
// isn't a super_admin. This is enforced here (not just hidden in the
// frontend) so it can't be bypassed by calling the API directly.
// ------------------------------------------------------------------
const { verifyToken } = require('./src/auth');
app.use('/api', (req, res, next) => {
  if (req.path === '/system-status' || req.path === '/public-stats' || req.path.startsWith('/superadmin')) return next();
  if (['/auth/login', '/auth/logout', '/auth/me', '/auth/complete-setup'].includes(req.path)) return next();

  const row = db.prepare('SELECT status, message FROM system_status WHERE id = 1').get();
  if (!row || row.status === 'online') return next();

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const payload = token ? verifyToken(token) : null;
  if (payload && payload.role === 'super_admin' && payload.scope !== 'complete-setup') return next();

  return res.status(503).json({
    error: row.message || 'The system is temporarily unavailable.',
    code: 'SYSTEM_' + row.status.toUpperCase(),
  });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/superadmin', superadminRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/user', userRoutes);
app.use('/api/shared', sharedRoutes);
app.use('/api/system-status', require('./src/routes/systemStatus.routes'));
app.use('/api/public-stats', require('./src/routes/publicStats.routes'));

// Serve the front-end (the actual HTML/CSS/JS pages you sent, now wired to the API above).
// Cache-Control: no-cache forces the browser to always revalidate with the
// server before using a cached copy — this means every code update you push
// takes effect immediately for everyone, without them needing to manually
// hard-refresh or clear their browser cache.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache');
  },
}));

// Fallback: unknown non-API routes go to the sign-in page.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'signin-signup.html'));
});

// Central error handler (also catches multer file-upload errors).
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'A server error occurred.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`E-Codex Play server running on http://localhost:${PORT}`);
  // Clean up any uploaded files past their configured retention period —
  // once now, then once a day for as long as the server keeps running.
  superadminRoutes.runStorageRetentionCleanup();
  setInterval(superadminRoutes.runStorageRetentionCleanup, 24 * 60 * 60 * 1000);
});
