require('dotenv').config();

const Sentry = require('@sentry/node');
Sentry.init({
  dsn: 'https://b9b4ddbbf1e8899b87e12bb698567716@o4511260506128384.ingest.us.sentry.io/4511260518580224',
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: 0.2, // capture 20% of requests for performance tracing
});

if (!process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET environment variable is not set.');
  process.exit(1);
}

const express        = require('express');
const { Pool }       = require('pg');
const cors           = require('cors');
const path           = require('path');
const bcrypt         = require('bcrypt');
const session        = require('express-session');
const PgSession      = require('connect-pg-simple')(session);
const passport       = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { Resend }     = require('resend');
const crypto         = require('crypto');
const Stripe         = require('stripe');
const rateLimit      = require('express-rate-limit');

const stripe = process.env.STRIPE_SECRET_KEY
  ? Stripe(process.env.STRIPE_SECRET_KEY)
  : null;
console.log('[startup] Stripe:', stripe ? 'configured ✓' : 'NOT configured — STRIPE_SECRET_KEY missing');

const APP_URL = process.env.APP_URL
  ? `https://${process.env.APP_URL.replace(/^https?:\/\//, '').replace(/\/$/, '')}`
  : 'http://localhost:3000';

const app = express();

// ── Database ──────────────────────────────────────────────────────────────────

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : new Pool({
      host: process.env.DB_HOST, port: process.env.DB_PORT,
      database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    });

// ── Email ─────────────────────────────────────────────────────────────────────

const emailEnabled = !!process.env.RESEND_API_KEY;
const resend       = emailEnabled ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM_EMAIL   = 'CastSync <support@cast-sync.com>';

async function sendConfirmationEmail(toEmail, data, orgName, seasonName, isUpdate = false) {
  if (!emailEnabled) return;
  const { first_name, last_name, phone, address, grade, technique_classes, injuries, absences, availability } = data;
  const availLines = (availability || []).map(a => `${a.day}: ${a.startTime} – ${a.endTime}`).join('<br>') || 'None provided';
  const row = (label, value) =>
    `<tr><td style="padding:8px 12px;font-weight:bold;color:#555;white-space:nowrap;vertical-align:top;border-bottom:1px solid #f0f0f0;">${label}</td>
         <td style="padding:8px 12px;color:#222;border-bottom:1px solid #f0f0f0;">${value || '—'}</td></tr>`;
  const heading = isUpdate ? 'Submission Updated' : 'Submission Received';
  const subjectTag = isUpdate ? 'Updated' : 'Received';
  const intro = isUpdate
    ? `Hi ${first_name}, your submission for <strong>${orgName} — ${seasonName}</strong> has been updated. Here's what we have on file.`
    : `Hi ${first_name}, here's a copy of your submission for <strong>${orgName} — ${seasonName}</strong>.`;
  try {
    await resend.emails.send({
      from:    FROM_EMAIL,
      to:      toEmail,
      subject: `CastSync Submission ${subjectTag} — ${orgName}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#222;">
        <h2 style="margin-bottom:4px;">${heading}</h2>
        <p style="color:#555;margin-top:0;">${intro}</p>
        <p style="color:#555;font-size:13px;">To update your information, log back in and resubmit — your previous submission will be replaced.</p>
        <table style="width:100%;border-collapse:collapse;border:1px solid #e0e0e0;border-radius:6px;overflow:hidden;margin-top:16px;">
          ${row('Name', `${first_name} ${last_name}`)}
          ${row('Email', toEmail)}
          ${row('Phone', phone)}
          ${row('Address', address)}
          ${row('Grade', grade)}
          ${row('Technique Classes', (technique_classes || '').replace(/\n/g, '<br>'))}
          ${row('Recent Injuries', (injuries || '').replace(/\n/g, '<br>'))}
          ${row('Known Absences', (absences || '').replace(/\n/g, '<br>'))}
          ${row('Availability', availLines)}
        </table>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
        <p style="color:#aaa;font-size:12px;margin:0;">CastSync — this is an automated message.</p>
      </div>`,
    });
    console.log(`Confirmation email sent to ${toEmail}`);
  } catch (err) {
    console.error('Email error:', err.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateJoinCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase(); // e.g. "A3F9C2"
}

// ── Middleware ────────────────────────────────────────────────────────────────

app.set('trust proxy', 1); // Railway sits behind a proxy — needed for secure cookies

app.use(cors());
// Raw body needed for Stripe webhook signature verification — must come before express.json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge:   7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production', // HTTPS-only in prod
    sameSite: 'lax',
  },
}));

// ── Passport / Google OAuth ───────────────────────────────────────────────────

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const r = await pool.query('SELECT id, email, role FROM users WHERE id = $1', [id]);
    done(null, r.rows[0] || false);
  } catch (err) { done(err); }
});

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${process.env.APP_URL}/auth/google/callback`,
    },
    async (accessToken, refreshToken, profile, done) => {
      const email = profile.emails[0].value.toLowerCase();
      try {
        let result = await pool.query(
          'SELECT id, email, role, google_id FROM users WHERE google_id = $1 OR email = $2',
          [profile.id, email]
        );
        if (result.rows.length > 0) {
          const user = result.rows[0];
          if (!user.google_id) await pool.query('UPDATE users SET google_id = $1 WHERE id = $2', [profile.id, user.id]);
          return done(null, user);
        }
        result = await pool.query(
          'INSERT INTO users (email, google_id, role) VALUES ($1, $2, $3) RETURNING id, email, role',
          [email, profile.id, 'auditionee']
        );
        done(null, result.rows[0]);
      } catch (err) { done(err); }
    }
  ));
}

app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.redirect('/login.html'));

// ── Auth helpers ──────────────────────────────────────────────────────────────

function requireAuth(role) {
  return (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
    if (role === 'master') {
      // Allow if their base role is master OR they are in director mode
      if (req.session.mode !== 'director' && req.session.role !== 'master') {
        return res.status(403).json({ error: 'Access denied.' });
      }
    } else if (role === 'auditionee') {
      // Allow if their base role is auditionee OR they are in auditionee mode
      if (req.session.mode === 'director' && req.session.role !== 'auditionee') {
        return res.status(403).json({ error: 'Access denied.' });
      }
    }
    next();
  };
}

// Middleware that injects org/season context for master routes
async function requireOrgContext(req, res, next) {
  if (!req.session.userId || req.session.role !== 'master') return res.status(403).json({ error: 'Access denied.' });
  const { orgId, seasonId } = req.session;
  if (!orgId || !seasonId) return res.status(400).json({ error: 'No active org/season. Please select one.' });
  // Verify this user belongs to this org
  const check = await pool.query(
    'SELECT id FROM org_members WHERE org_id = $1 AND user_id = $2',
    [orgId, req.session.userId]
  );
  if (check.rows.length === 0) return res.status(403).json({ error: 'Not a member of this org.' });
  req.orgId    = orgId;
  req.seasonId = seasonId;
  next();
}

// ── Google OAuth routes ───────────────────────────────────────────────────────

app.get('/auth/google', passport.authenticate('google', { scope: ['email', 'profile'] }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login.html?error=google' }),
  (req, res) => {
    req.session.userId = req.user.id;
    req.session.role   = req.user.role;
    req.session.email  = req.user.email;
    if (req.user.role === 'master') res.redirect('/org-select.html');
    else                            res.redirect('/auditionForm.html');
  }
);

// ── Auth routes ───────────────────────────────────────────────────────────────

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                   // 10 attempts per window
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many attempts. Please wait 15 minutes and try again.' },
});

app.post('/api/auth/signup', authLimiter, async (req, res) => {
  const { email, password, masterCode } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  if (password.length < 6)  return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const role = masterCode === process.env.MASTER_CODE ? 'master' : 'auditionee';
  try {
    const hash  = await bcrypt.hash(password, 12);
    const token = crypto.randomBytes(32).toString('hex');
    // email_verified defaults TRUE in schema — explicitly set FALSE for new email signups
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, role, email_verified, verification_token)
       VALUES ($1, $2, $3, FALSE, $4) RETURNING id, email, role`,
      [email.toLowerCase().trim(), hash, role, token]
    );
    const user = result.rows[0];

    if (!emailEnabled) {
      // No email configured (local dev) — auto-verify and log in
      await pool.query('UPDATE users SET email_verified = TRUE, verification_token = NULL WHERE id = $1', [user.id]);
      req.session.userId = user.id;
      req.session.role   = user.role;
      req.session.email  = user.email;
      return res.status(201).json({ id: user.id, email: user.email, role: user.role });
    }

    // Send verification email
    const verifyUrl = `${APP_URL}/verify-email.html?token=${token}`;
    resend.emails.send({
      from:    FROM_EMAIL,
      to:      user.email,
      subject: 'Verify your CastSync email',
      html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#222;">
        <h2 style="margin-bottom:4px;">Welcome to CastSync!</h2>
        <p style="color:#555;">Click the button below to verify your email and activate your account.</p>
        <p style="margin:28px 0;">
          <a href="${verifyUrl}"
             style="background:#111;color:#fff;padding:11px 26px;border-radius:7px;text-decoration:none;font-weight:600;font-size:15px;">
            Verify Email
          </a>
        </p>
        <p style="color:#9ca3af;font-size:12px;">
          This link expires in 24 hours. If you didn't sign up for CastSync, you can ignore this email.
        </p>
      </div>`,
    }).catch(err => console.error('Verification email error:', err.message));

    res.status(201).json({ needsVerification: true, email: user.email });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An account with that email already exists.' });
    console.error('Signup error:', err.message);
    res.status(500).json({ error: 'Could not create account.' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  try {
    const result = await pool.query(
      'SELECT id, email, password_hash, role, is_director, email_verified FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    const user = result.rows[0];
    if (!user || !user.password_hash) return res.status(401).json({ error: 'Incorrect email or password.' });
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Incorrect email or password.' });
    if (!user.email_verified) {
      return res.status(403).json({
        error: 'Please verify your email before logging in. Check your inbox for a verification link.',
        unverified: true,
        email: user.email,
      });
    }
    req.session.userId     = user.id;
    req.session.role       = user.role;
    req.session.email      = user.email;
    req.session.isDirector = user.is_director || user.role === 'master';
    req.session.mode       = (user.role === 'master' || user.is_director) ? 'director' : 'auditionee';
    res.json({ id: user.id, email: user.email, role: user.role, isDirector: req.session.isDirector });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ message: 'Logged out.' }));
});

// GET /api/auth/verify-email?token=xxx — validate email verification token, auto-login
app.get('/api/auth/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Token required.' });
  try {
    const result = await pool.query(
      `UPDATE users SET email_verified = TRUE, verification_token = NULL
       WHERE verification_token = $1
       RETURNING id, email, role, is_director`,
      [token]
    );
    if (!result.rows.length) {
      return res.status(400).json({ error: 'This verification link is invalid or has already been used.' });
    }
    const user = result.rows[0];
    req.session.userId     = user.id;
    req.session.role       = user.role;
    req.session.email      = user.email;
    req.session.isDirector = user.is_director || user.role === 'master';
    req.session.mode       = (user.role === 'master' || user.is_director) ? 'director' : 'auditionee';
    res.json({ ok: true, role: user.role, isDirector: req.session.isDirector });
  } catch (err) {
    console.error('Verify email error:', err.message);
    res.status(500).json({ error: 'Verification failed. Please try again.' });
  }
});

// POST /api/auth/resend-verification — resend the verification email
app.post('/api/auth/resend-verification', authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required.' });
  if (!emailEnabled) return res.status(503).json({ error: 'Email is not configured.' });
  try {
    const token = crypto.randomBytes(32).toString('hex');
    const result = await pool.query(
      `UPDATE users SET verification_token = $1
       WHERE email = $2 AND email_verified = FALSE
       RETURNING id`,
      [token, email.toLowerCase().trim()]
    );
    // Always return ok — don't reveal whether email exists
    if (result.rows.length) {
      const verifyUrl = `${APP_URL}/verify-email.html?token=${token}`;
      resend.emails.send({
        from:    FROM_EMAIL,
        to:      email.toLowerCase().trim(),
        subject: 'Verify your CastSync email',
        html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#222;">
          <h2 style="margin-bottom:4px;">Verify your email</h2>
          <p style="color:#555;">Click the button below to verify your email and access CastSync.</p>
          <p style="margin:28px 0;">
            <a href="${verifyUrl}"
               style="background:#111;color:#fff;padding:11px 26px;border-radius:7px;text-decoration:none;font-weight:600;font-size:15px;">
              Verify Email
            </a>
          </p>
          <p style="color:#9ca3af;font-size:12px;">This link expires in 24 hours.</p>
        </div>`,
      }).catch(err => console.error('Resend verification error:', err.message));
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Resend verification error:', err.message);
    res.status(500).json({ error: 'Could not send verification email.' });
  }
});

// DELETE /api/auth/account — permanently delete the logged-in user's account
app.delete('/api/auth/account', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password is required to confirm deletion.' });
  try {
    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.session.userId]);
    const user   = result.rows[0];
    if (!user || !user.password_hash) return res.status(400).json({ error: 'Cannot delete an account without a password set. Contact support.' });
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(403).json({ error: 'Incorrect password.' });
    // Cascade deletes handle submissions, dancer_profiles, org_members, piece_casts, etc.
    await pool.query('DELETE FROM users WHERE id = $1', [req.session.userId]);
    req.session.destroy(() => res.json({ message: 'Account deleted.' }));
  } catch (err) {
    console.error('Account deletion error:', err.message);
    res.status(500).json({ error: 'Failed to delete account.' });
  }
});

// POST /api/auth/change-password — change password for logged-in user
app.post('/api/auth/change-password', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords are required.' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  try {
    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.session.userId]);
    const user   = result.rows[0];
    if (!user || !user.password_hash) return res.status(400).json({ error: 'Cannot change password for this account type.' });
    const match = await bcrypt.compare(currentPassword, user.password_hash);
    if (!match) return res.status(403).json({ error: 'Current password is incorrect.' });
    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.session.userId]);
    res.json({ message: 'Password updated.' });
  } catch (err) {
    console.error('Change password error:', err.message);
    res.status(500).json({ error: 'Failed to update password.' });
  }
});

// POST /api/auth/forgot-password — generate a reset token and email it
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required.' });
  // Always respond 200 so we don't reveal whether an account exists
  res.json({ message: 'If that email exists, a reset link has been sent.' });
  try {
    const result = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (result.rows.length === 0) return; // silently do nothing
    const token   = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await pool.query(
      'UPDATE users SET reset_token=$1, reset_token_expires=$2 WHERE id=$3',
      [token, expires, result.rows[0].id]
    );
    if (!emailEnabled) return;
    await resend.emails.send({
      from:    FROM_EMAIL,
      to:      email.toLowerCase().trim(),
      subject: 'Reset your CastSync password',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;">
          <h2 style="margin-bottom:8px;">Reset your password</h2>
          <p>Click the link below to set a new password. This link expires in 1 hour.</p>
          <p style="margin:24px 0;">
            <a href="${APP_URL}/reset-password.html?token=${token}"
               style="background:#111;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;">
              Reset Password
            </a>
          </p>
          <p style="color:#888;font-size:13px;">If you didn't request this, you can safely ignore this email.</p>
        </div>`,
    });
  } catch (err) {
    console.error('Forgot password error:', err.message);
  }
});

// POST /api/auth/reset-password — validate token and set new password
app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and password required.' });
  if (password.length < 6)  return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  try {
    const result = await pool.query(
      'SELECT id FROM users WHERE reset_token=$1 AND reset_token_expires > NOW()',
      [token]
    );
    if (result.rows.length === 0) return res.status(400).json({ error: 'Invalid or expired reset link.' });
    const hash = await bcrypt.hash(password, 12);
    // Also mark email verified — if they can access their inbox, email is valid
    await pool.query(
      'UPDATE users SET password_hash=$1, reset_token=NULL, reset_token_expires=NULL, email_verified=TRUE WHERE id=$2',
      [hash, result.rows[0].id]
    );
    res.json({ message: 'Password updated.' });
  } catch (err) {
    console.error('Reset password error:', err.message);
    res.status(500).json({ error: 'Could not reset password.' });
  }
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
  res.json({
    id:         req.session.userId,
    email:      req.session.email,
    role:       req.session.role,
    isDirector: req.session.isDirector || req.session.role === 'master',
    mode:       req.session.mode || (req.session.role === 'master' ? 'director' : 'auditionee'),
    orgId:      req.session.orgId    || null,
    seasonId:   req.session.seasonId || null,
    orgName:    req.session.orgName  || null,
    seasonName: req.session.seasonName || null,
    roomCount:  req.session.roomCount || 1,
  });
});

app.post('/api/auth/upgrade', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
  const { masterCode } = req.body;
  if (!masterCode || masterCode !== process.env.MASTER_CODE)
    return res.status(403).json({ error: 'Incorrect access code.' });
  try {
    await pool.query('UPDATE users SET is_director = TRUE WHERE id = $1', [req.session.userId]);
    req.session.isDirector = true;
    req.session.mode = 'director';
    res.json({ message: 'Director access granted.', mode: 'director' });
  } catch (err) {
    console.error('Upgrade error:', err.message);
    res.status(500).json({ error: 'Could not upgrade account.' });
  }
});

// Switch between auditionee and director mode
app.post('/api/auth/switch-mode', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
  const { mode } = req.body;
  if (!['auditionee', 'director'].includes(mode))
    return res.status(400).json({ error: 'Invalid mode.' });
  if (mode === 'director' && !req.session.isDirector && req.session.role !== 'master')
    return res.status(403).json({ error: 'No director access.' });
  req.session.mode = mode;
  res.json({ mode });
});

// ── Org routes ────────────────────────────────────────────────────────────────

// GET /api/orgs — list all orgs this director belongs to (org-wide or production-specific)
app.get('/api/orgs', requireAuth('master'), async (req, res) => {
  try {
    // Primary: orgs where the user is an org-level member
    const orgResult = await pool.query(
      `SELECT o.id, o.name, o.join_code, om.role
       FROM orgs o
       JOIN org_members om ON om.org_id = o.id
       WHERE om.user_id = $1
       ORDER BY o.created_at DESC`,
      [req.session.userId]
    );

    // Secondary: orgs accessible only via season_members (production co-directors)
    // Wrapped in its own try so a missing season_members table doesn't break the whole route
    let seasonOrgRows = [];
    try {
      const smResult = await pool.query(
        `SELECT DISTINCT o.id, o.name, o.join_code, 'co-director' AS role
         FROM orgs o
         JOIN seasons s  ON s.org_id   = o.id
         JOIN season_members sm ON sm.season_id = s.id
         WHERE sm.user_id = $1`,
        [req.session.userId]
      );
      seasonOrgRows = smResult.rows;
    } catch (e) {
      console.warn('season_members query failed (table may not exist yet):', e.message);
    }

    // Merge — org_members takes priority; avoid duplicates
    const seen     = new Set(orgResult.rows.map(r => r.id));
    const combined = [...orgResult.rows, ...seasonOrgRows.filter(r => !seen.has(r.id))];
    res.json(combined);
  } catch (err) {
    console.error('GET /api/orgs error:', err.message);
    res.status(500).json({ error: 'Failed to fetch orgs.' });
  }
});

// GET /api/orgs/preview?join_code=XXX — public lookup by production join code
app.get('/api/orgs/preview', async (req, res) => {
  const { join_code } = req.query;
  if (!join_code || join_code.trim().length < 4) return res.json({ found: false });
  try {
    // Look up by season join code (production code)
    const result = await pool.query(
      `SELECT o.name AS org_name, s.name AS season_name
       FROM seasons s JOIN orgs o ON o.id = s.org_id
       WHERE UPPER(s.join_code) = UPPER($1) LIMIT 1`,
      [join_code.trim()]
    );
    if (result.rows.length === 0) return res.json({ found: false });
    res.json({ found: true, org_name: result.rows[0].org_name, season_name: result.rows[0].season_name });
  } catch (err) {
    res.json({ found: false });
  }
});

// DELETE /api/orgs/:id — owner deletes an org and all its data
app.delete('/api/orgs/:id', requireAuth('master'), async (req, res) => {
  try {
    const check = await pool.query(
      'SELECT id FROM org_members WHERE org_id = $1 AND user_id = $2 AND role = $3',
      [req.params.id, req.session.userId, 'owner']
    );
    if (check.rows.length === 0)
      return res.status(403).json({ error: 'Only the org owner can delete it.' });
    await pool.query('DELETE FROM orgs WHERE id = $1', [req.params.id]);
    res.json({ message: 'Organization deleted.' });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to delete organization.' });
  }
});

// POST /api/orgs — director creates a new org
app.post('/api/orgs', requireAuth('master'), async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Org name is required.' });
  const joinCode = generateJoinCode();
  try {
    // Enforce 20-org limit
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM org_members WHERE user_id = $1 AND role = $2',
      [req.session.userId, 'owner']
    );
    if (parseInt(countResult.rows[0].count) >= 20)
      return res.status(400).json({ error: 'You have reached the 20-organization limit. Delete an existing organization before creating a new one.' });

    const orgResult = await pool.query(
      'INSERT INTO orgs (name, join_code) VALUES ($1, $2) RETURNING id, name, join_code',
      [name.trim(), joinCode]
    );
    const org = orgResult.rows[0];
    await pool.query(
      'INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)',
      [org.id, req.session.userId, 'owner']
    );
    res.status(201).json({ org });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to create org.' });
  }
});

// PATCH /api/orgs/:id — update org name
app.patch('/api/orgs/:id', requireAuth('master'), async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  try {
    const check = await pool.query(
      'SELECT id FROM org_members WHERE org_id = $1 AND user_id = $2 AND role = $3',
      [req.params.id, req.session.userId, 'owner']
    );
    if (check.rows.length === 0) return res.status(403).json({ error: 'Only the org owner can rename it.' });
    await pool.query('UPDATE orgs SET name = $1 WHERE id = $2', [name.trim(), req.params.id]);
    res.json({ message: 'Org renamed.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to rename org.' });
  }
});

// POST /api/orgs/:orgId/seasons/:seasonId/invite — invite a co-director to one production
app.post('/api/orgs/:orgId/seasons/:seasonId/invite', requireAuth('master'), async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });
  try {
    const ownerCheck = await pool.query(
      'SELECT id FROM org_members WHERE org_id = $1 AND user_id = $2 AND role = $3',
      [req.params.orgId, req.session.userId, 'owner']
    );
    if (ownerCheck.rows.length === 0) return res.status(403).json({ error: 'Only the org owner can invite co-directors.' });

    const userResult = await pool.query(
      'SELECT id, role FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'No CastSync account found with that email. Ask them to sign up first.' });

    const inviteeId   = userResult.rows[0].id;
    const inviteeRole = userResult.rows[0].role;

    // Add to season_members
    await pool.query(
      'INSERT INTO season_members (season_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (season_id, user_id) DO NOTHING',
      [req.params.seasonId, inviteeId, 'editor']
    );

    // Auto-promote to master so they can access director pages without entering the access code
    if (inviteeRole !== 'master') {
      await pool.query(
        "UPDATE users SET role = 'master', is_director = TRUE WHERE id = $1",
        [inviteeId]
      );
    }

    res.json({ message: 'Co-director added to this production.' });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to invite co-director.' });
  }
});

// POST /api/session/org — director sets active org + season for their session
app.post('/api/session/org', requireAuth('master'), async (req, res) => {
  const { orgId, seasonId } = req.body;
  if (!orgId || !seasonId) return res.status(400).json({ error: 'orgId and seasonId required.' });
  try {
    // Verify org-wide membership OR production-specific membership
    const check = await pool.query(
      `SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2
       UNION ALL
       SELECT 1 FROM season_members WHERE season_id = $3 AND user_id = $2
       LIMIT 1`,
      [orgId, req.session.userId, seasonId]
    );
    if (check.rows.length === 0) return res.status(403).json({ error: 'Not a member of this org.' });

    const orgResult    = await pool.query('SELECT name FROM orgs WHERE id = $1', [orgId]);
    const seasonResult = await pool.query('SELECT name, COALESCE(room_count, 1) AS room_count FROM seasons WHERE id = $1 AND org_id = $2', [seasonId, orgId]);
    if (orgResult.rows.length === 0 || seasonResult.rows.length === 0)
      return res.status(404).json({ error: 'Org or season not found.' });

    req.session.orgId      = parseInt(orgId);
    req.session.seasonId   = parseInt(seasonId);
    req.session.orgName    = orgResult.rows[0].name;
    req.session.seasonName = seasonResult.rows[0].name;
    req.session.roomCount  = seasonResult.rows[0].room_count;
    res.json({ orgId, seasonId, orgName: req.session.orgName, seasonName: req.session.seasonName });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to set org context.' });
  }
});

// ── Season routes ─────────────────────────────────────────────────────────────

// GET /api/orgs/:orgId/seasons — filtered by user's access level
app.get('/api/orgs/:orgId/seasons', requireAuth('master'), async (req, res) => {
  try {
    // Check if user is an org-level member
    const isOrgMember = await pool.query(
      'SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2',
      [req.params.orgId, req.session.userId]
    );

    let seasonFilter = isOrgMember.rows.length > 0
      ? '' // org member sees all seasons
      : 'AND FALSE'; // fallback; will be overridden below if season_members works

    // Build the WHERE clause; if season_members doesn't exist yet, fall back to org_members only
    let query, params;
    if (isOrgMember.rows.length > 0) {
      // Org-level member: show all seasons in the org
      query  = `SELECT s.id, s.name, s.join_code, s.is_active, s.created_at,
                       (SELECT COUNT(*) FROM submissions WHERE season_id = s.id) AS submission_count
                FROM seasons s
                WHERE s.org_id = $1
                ORDER BY s.created_at DESC`;
      params = [req.params.orgId];
    } else {
      // Production co-director: only seasons in season_members
      query  = `SELECT s.id, s.name, s.join_code, s.is_active, s.created_at,
                       (SELECT COUNT(*) FROM submissions WHERE season_id = s.id) AS submission_count
                FROM seasons s
                JOIN season_members sm ON sm.season_id = s.id
                WHERE s.org_id = $1 AND sm.user_id = $2
                ORDER BY s.created_at DESC`;
      params = [req.params.orgId, req.session.userId];
    }

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('GET seasons error:', err.message);
    // If season_members doesn't exist, return all seasons for org members
    try {
      const fallback = await pool.query(
        `SELECT s.id, s.name, s.join_code, s.is_active, s.created_at,
                (SELECT COUNT(*) FROM submissions WHERE season_id = s.id) AS submission_count
         FROM seasons s
         JOIN org_members om ON om.org_id = s.org_id
         WHERE s.org_id = $1 AND om.user_id = $2
         ORDER BY s.created_at DESC`,
        [req.params.orgId, req.session.userId]
      );
      res.json(fallback.rows);
    } catch (err2) {
      res.status(500).json({ error: 'Failed to fetch seasons.' });
    }
  }
});

// ── Stripe routes ─────────────────────────────────────────────────────────────

// GET /api/subscription — return current user's plan status
app.get('/api/subscription', requireAuth('master'), async (req, res) => {
  try {
    const row = await pool.query(
      'SELECT plan_type, plan_expires_at FROM users WHERE id = $1',
      [req.session.userId]
    );
    const { plan_type, plan_expires_at } = row.rows[0] || {};
    const isAnnualActive = (plan_type === 'annual' || plan_type === 'free') &&
      (!plan_expires_at || new Date(plan_expires_at) > new Date());
    res.json({ planType: plan_type || 'none', planExpiresAt: plan_expires_at || null, isAnnualActive });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch subscription.' });
  }
});

// Helper: parse DISCOUNT_CODES env var → Map of CODE → percentage (integer)
// Format: "SAVE10:10,LAUNCH20:20"
function parseDiscountCodes() {
  const map = new Map();
  (process.env.DISCOUNT_CODES || '').split(',').forEach(entry => {
    const [code, pct] = entry.split(':');
    if (code && pct) map.set(code.trim().toUpperCase(), parseInt(pct, 10));
  });
  return map;
}

// POST /api/promo/check — validate any code; returns type ('free' | 'discount') + value
app.post('/api/promo/check', requireAuth('master'), (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code is required.' });
  const upper = code.trim().toUpperCase();

  const freeCodes = (process.env.PROMO_CODES || '').split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
  if (freeCodes.includes(upper)) {
    return res.json({ type: 'free' });
  }

  const discountMap = parseDiscountCodes();
  if (discountMap.has(upper)) {
    return res.json({ type: 'discount', percent: discountMap.get(upper) });
  }

  res.status(400).json({ error: 'Invalid or expired promo code.' });
});

// POST /api/promo/redeem — apply a free-access promo code to the user's account
app.post('/api/promo/redeem', requireAuth('master'), async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code is required.' });

  const freeCodes = (process.env.PROMO_CODES || '').split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
  if (!freeCodes.includes(code.trim().toUpperCase())) {
    return res.status(400).json({ error: 'Invalid or expired promo code.' });
  }

  try {
    await pool.query(
      `UPDATE users SET plan_type = 'free', plan_expires_at = NULL WHERE id = $1`,
      [req.session.userId]
    );
    res.json({ ok: true, message: 'Promo code applied! You have free unlimited access.' });
  } catch (err) {
    res.status(500).json({ error: 'Could not apply promo code.' });
  }
});

// POST /api/checkout/create-session — start Stripe checkout for a new production
app.post('/api/checkout/create-session', requireAuth('master'), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured.' });
  const { orgId, productionName, plan, discountCode } = req.body;
  if (!orgId || !productionName || !plan) return res.status(400).json({ error: 'orgId, productionName and plan required.' });
  if (!['payasyougo', 'annual'].includes(plan)) return res.status(400).json({ error: 'Invalid plan.' });

  try {
    // Derive base URL — strip any protocol the user may have included in APP_URL
    const proto   = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const host    = req.headers['x-forwarded-host']  || req.headers.host;
    const baseUrl = process.env.APP_URL
      ? `https://${process.env.APP_URL.replace(/^https?:\/\//, '').replace(/\/$/, '')}`
      : `${proto}://${host}`;

    // Reuse existing Stripe customer if this user has paid before
    const userRow = await pool.query('SELECT stripe_customer_id FROM users WHERE id = $1', [req.session.userId]);
    const existingCustomer = userRow.rows[0]?.stripe_customer_id;

    // Apply discount code if provided
    let discountPercent = 0;
    if (discountCode) {
      const discountMap = parseDiscountCodes();
      const pct = discountMap.get(discountCode.trim().toUpperCase());
      if (pct) discountPercent = pct;
    }

    const baseAmount   = plan === 'annual' ? 24900 : 7900;
    const unitAmount   = Math.round(baseAmount * (1 - discountPercent / 100));
    const productLabel = plan === 'annual'
      ? `CastSync Annual Pass — Unlimited Productions${discountPercent ? ` (${discountPercent}% off)` : ''}`
      : `CastSync Production — ${productionName}${discountPercent ? ` (${discountPercent}% off)` : ''}`;

    const sessionParams = {
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: unitAmount,
          product_data: { name: productLabel },
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${baseUrl}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${baseUrl}/plan-select.html?orgId=${orgId}&cancelled=1`,
      metadata: {
        org_id:          String(orgId),
        user_id:         String(req.session.userId),
        production_name: productionName,
        plan:            plan,
      },
    };
    if (existingCustomer) sessionParams.customer = existingCustomer;

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe session error:', err.message);
    res.status(500).json({ error: `Stripe error: ${err.message}` });
  }
});

// GET /api/checkout/complete?session_id=xxx — verify payment and create the season
app.get('/api/checkout/complete', requireAuth('master'), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured.' });
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'session_id required.' });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'Payment not completed.' });
    }

    const { org_id, production_name, plan } = session.metadata;

    // Activate annual plan if applicable
    if (plan === 'annual') {
      await pool.query(
        `UPDATE users SET plan_type = 'annual', plan_expires_at = NOW() + INTERVAL '1 year' WHERE id = $1`,
        [req.session.userId]
      );
    }

    // Persist Stripe customer ID so the billing portal can look them up later
    if (session.customer) {
      await pool.query(
        'UPDATE users SET stripe_customer_id = $1 WHERE id = $2 AND stripe_customer_id IS NULL',
        [session.customer, req.session.userId]
      );
    }

    // Idempotent: if this session already created a season, just return it
    const existing = await pool.query(
      'SELECT id FROM seasons WHERE stripe_session_id = $1',
      [session_id]
    );
    if (existing.rows.length > 0) {
      const s = existing.rows[0];
      req.session.orgId    = parseInt(org_id);
      req.session.seasonId = s.id;
      const orgR = await pool.query('SELECT name FROM orgs WHERE id = $1', [org_id]);
      const seaR = await pool.query('SELECT name FROM seasons WHERE id = $1', [s.id]);
      req.session.orgName    = orgR.rows[0]?.name;
      req.session.seasonName = seaR.rows[0]?.name;
      return res.json({ seasonId: s.id, plan: plan || 'payasyougo' });
    }

    // Create the season
    let row, inserted = false;
    while (!inserted) {
      try {
        const code = generateJoinCode();
        const result = await pool.query(
          'INSERT INTO seasons (org_id, name, is_active, join_code, stripe_session_id) VALUES ($1,$2,TRUE,$3,$4) RETURNING id, name',
          [org_id, production_name, code, session_id]
        );
        row = result.rows[0];
        inserted = true;
      } catch (e) {
        if (e.code !== '23505') throw e;
      }
    }

    req.session.orgId      = parseInt(org_id);
    req.session.seasonId   = row.id;
    const orgR = await pool.query('SELECT name FROM orgs WHERE id = $1', [org_id]);
    req.session.orgName    = orgR.rows[0]?.name;
    req.session.seasonName = row.name;
    req.session.roomCount  = 1;

    res.json({ seasonId: row.id, plan: plan || 'payasyougo' });
  } catch (err) {
    console.error('Checkout complete error:', err.message);
    res.status(500).json({ error: 'Could not finalize production.' });
  }
});

// POST /api/stripe/webhook — backup: create season if webhook fires before user returns
app.post('/api/stripe/webhook', async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.json({ received: true });

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.payment_status !== 'paid') return res.json({ received: true });

    const { org_id, production_name, plan, user_id } = session.metadata;
    const sessionId = session.id;

    try {
      // Activate annual plan if applicable
      if (plan === 'annual' && user_id) {
        await pool.query(
          `UPDATE users SET plan_type = 'annual', plan_expires_at = NOW() + INTERVAL '1 year' WHERE id = $1`,
          [user_id]
        );
      }

      // Persist Stripe customer ID
      if (user_id && session.customer) {
        await pool.query(
          'UPDATE users SET stripe_customer_id = $1 WHERE id = $2 AND stripe_customer_id IS NULL',
          [session.customer, user_id]
        );
      }

      // Idempotent — skip season creation if already handled by /api/checkout/complete
      const existing = await pool.query(
        'SELECT id FROM seasons WHERE stripe_session_id = $1',
        [sessionId]
      );
      if (existing.rows.length > 0) return res.json({ received: true });

      let inserted = false;
      while (!inserted) {
        try {
          const code = generateJoinCode();
          await pool.query(
            'INSERT INTO seasons (org_id, name, is_active, join_code, stripe_session_id) VALUES ($1,$2,TRUE,$3,$4)',
            [org_id, production_name, code, sessionId]
          );
          inserted = true;
        } catch (e) {
          if (e.code !== '23505') throw e;
        }
      }
      console.log(`Webhook: created production "${production_name}" for org ${org_id} (plan: ${plan || 'payasyougo'})`);
    } catch (err) {
      console.error('Webhook error:', err.message);
    }
  }

  res.json({ received: true });
});

// POST /api/orgs/:orgId/seasons — create a new production with its own join code
app.post('/api/orgs/:orgId/seasons', requireAuth('master'), async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Production name is required.' });
  try {
    let row, inserted = false;
    while (!inserted) {
      try {
        const code = generateJoinCode();
        const result = await pool.query(
          'INSERT INTO seasons (org_id, name, is_active, join_code) VALUES ($1, $2, TRUE, $3) RETURNING id, name, join_code',
          [req.params.orgId, name.trim(), code]
        );
        row = result.rows[0];
        inserted = true;
      } catch (e) {
        if (e.code !== '23505') throw e;
      }
    }
    res.status(201).json(row);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to create production.' });
  }
});

// POST /api/orgs/:orgId/seasons/free — create a production without payment (annual plan only)
app.post('/api/orgs/:orgId/seasons/free', requireAuth('master'), async (req, res) => {
  try {
    const planRow = await pool.query(
      'SELECT plan_type, plan_expires_at FROM users WHERE id = $1',
      [req.session.userId]
    );
    const { plan_type, plan_expires_at } = planRow.rows[0] || {};
    const hasAnnual = (plan_type === 'annual' || plan_type === 'free') &&
      (!plan_expires_at || new Date(plan_expires_at) > new Date());
    if (!hasAnnual) return res.status(403).json({ error: 'An active annual plan is required.' });

    // Verify membership in this org
    const memberCheck = await pool.query(
      'SELECT id FROM org_members WHERE org_id = $1 AND user_id = $2',
      [req.params.orgId, req.session.userId]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member of this organization.' });

    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Production name is required.' });

    let row, inserted = false;
    while (!inserted) {
      try {
        const code = generateJoinCode();
        const result = await pool.query(
          'INSERT INTO seasons (org_id, name, is_active, join_code) VALUES ($1,$2,TRUE,$3) RETURNING id, name, join_code',
          [req.params.orgId, name.trim(), code]
        );
        row = result.rows[0];
        inserted = true;
      } catch (e) {
        if (e.code !== '23505') throw e;
      }
    }
    res.status(201).json(row);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to create production.' });
  }
});

// PATCH /api/orgs/:orgId/seasons/:seasonId — rename a production
app.patch('/api/orgs/:orgId/seasons/:seasonId', requireAuth('master'), async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  try {
    const check = await pool.query(
      'SELECT id FROM org_members WHERE org_id = $1 AND user_id = $2 AND role = $3',
      [req.params.orgId, req.session.userId, 'owner']
    );
    if (check.rows.length === 0) return res.status(403).json({ error: 'Only the org owner can rename productions.' });
    await pool.query('UPDATE seasons SET name = $1 WHERE id = $2 AND org_id = $3', [name.trim(), req.params.seasonId, req.params.orgId]);
    res.json({ message: 'Production renamed.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to rename production.' });
  }
});

// DELETE /api/orgs/:orgId/seasons/:seasonId — delete a production
app.delete('/api/orgs/:orgId/seasons/:seasonId', requireAuth('master'), async (req, res) => {
  try {
    const check = await pool.query(
      'SELECT id FROM org_members WHERE org_id = $1 AND user_id = $2 AND role = $3',
      [req.params.orgId, req.session.userId, 'owner']
    );
    if (check.rows.length === 0) return res.status(403).json({ error: 'Only the org owner can delete productions.' });
    await pool.query('DELETE FROM seasons WHERE id = $1 AND org_id = $2', [req.params.seasonId, req.params.orgId]);
    res.json({ message: 'Production deleted.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete production.' });
  }
});

// ── Dancer profile routes (auditionee's reusable profile) ─────────────────────

// GET /api/profile — auditionee gets their own profile
app.get('/api/profile', requireAuth('auditionee'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM dancer_profiles WHERE user_id = $1', [req.session.userId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'No profile found.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile.' });
  }
});

// ── Submission routes ─────────────────────────────────────────────────────────

// POST /api/submissions — auditionee submits (or updates) for a specific org season
app.post('/api/submissions', requireAuth('auditionee'), async (req, res) => {
  const { join_code, first_name, last_name, phone, address, grade,
          technique_classes, injuries, absences, availability, audition_number } = req.body;

  if (!join_code)   return res.status(400).json({ error: 'Join code is required.' });
  if (!first_name || !last_name) return res.status(400).json({ error: 'Name is required.' });

  try {
    // Look up production by its join code
    const seasonLookup = await pool.query(
      `SELECT s.id AS season_id, s.name AS season_name, o.id AS org_id, o.name AS org_name
       FROM seasons s JOIN orgs o ON o.id = s.org_id
       WHERE UPPER(s.join_code) = UPPER($1) LIMIT 1`,
      [join_code.trim()]
    );
    if (seasonLookup.rows.length === 0)
      return res.status(404).json({ error: 'Invalid code. Please check with your director.' });

    const org    = { id: seasonLookup.rows[0].org_id,    name: seasonLookup.rows[0].org_name };
    const season = { id: seasonLookup.rows[0].season_id, name: seasonLookup.rows[0].season_name };

    // Upsert dancer profile (reusable across orgs)
    await pool.query(
      `INSERT INTO dancer_profiles (user_id, first_name, last_name, phone, address, grade, technique_classes, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         first_name=$2, last_name=$3, phone=$4, address=$5, grade=$6, technique_classes=$7, updated_at=NOW()`,
      [req.session.userId, first_name, last_name, phone||null, address||null, grade||null, technique_classes||null]
    );

    // Check for existing submission this season
    const existing = await pool.query(
      'SELECT id FROM submissions WHERE user_id = $1 AND season_id = $2',
      [req.session.userId, season.id]
    );

    const isUpdate = existing.rows.length > 0;

    const audNum = audition_number ? audition_number.toString().trim() : null;
    if (isUpdate) {
      await pool.query(
        `UPDATE submissions SET injuries=$1, absences=$2, availability=$3, audition_number=$4
         WHERE user_id=$5 AND season_id=$6`,
        [injuries||null, absences||null, JSON.stringify(availability||[]), audNum, req.session.userId, season.id]
      );
    } else {
      await pool.query(
        `INSERT INTO submissions (user_id, org_id, season_id, injuries, absences, availability, audition_number)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [req.session.userId, org.id, season.id, injuries||null, absences||null, JSON.stringify(availability||[]), audNum]
      );
    }

    // Get user email for confirmation
    const userResult = await pool.query('SELECT email FROM users WHERE id = $1', [req.session.userId]);
    const userEmail  = userResult.rows[0].email;

    sendConfirmationEmail(userEmail,
      { first_name, last_name, phone, address, grade, technique_classes, injuries, absences, availability },
      org.name, season.name, isUpdate
    );

    res.status(isUpdate ? 200 : 201).json({
      message: isUpdate ? 'Submission updated!' : 'Submission received!',
      org: org.name,
      season: season.name,
      isUpdate,
    });
  } catch (err) {
    console.error('Submission error:', err.message);
    res.status(500).json({ error: 'Failed to save submission.' });
  }
});

// GET /api/submissions/me — auditionee checks if they already submitted to a season (by join code)
app.get('/api/submissions/me', requireAuth('auditionee'), async (req, res) => {
  const { join_code } = req.query;
  if (!join_code) return res.status(400).json({ error: 'join_code required.' });
  try {
    const result = await pool.query(
      `SELECT sub.id, sub.injuries, sub.absences, sub.availability,
              dp.first_name, dp.last_name, dp.phone, dp.address, dp.grade, dp.technique_classes,
              s.name AS season_name, o.name AS org_name
       FROM submissions sub
       JOIN dancer_profiles dp ON dp.user_id = sub.user_id
       JOIN seasons s ON s.id = sub.season_id
       JOIN orgs o ON o.id = sub.org_id
       JOIN orgs ojc ON ojc.id = sub.org_id AND UPPER(ojc.join_code) = UPPER($1)
       WHERE sub.user_id = $2
       ORDER BY sub.created_at DESC LIMIT 1`,
      [join_code.trim(), req.session.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'No submission found.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch submission.' });
  }
});

// GET /api/my-submissions — auditionee's full submission history across all orgs
app.get('/api/my-submissions', requireAuth('auditionee'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT sub.created_at, o.name AS org_name, s.join_code, s.name AS season_name
       FROM submissions sub
       JOIN orgs o ON o.id = sub.org_id
       JOIN seasons s ON s.id = sub.season_id
       WHERE sub.user_id = $1
       ORDER BY sub.created_at DESC`,
      [req.session.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch submissions.' });
  }
});

// GET /api/publish — all pieces with casts + blocks for the current season (director)
app.get('/api/publish', requireAuth('master'), async (req, res) => {
  const { orgId, seasonId } = req.session;
  if (!orgId || !seasonId) return res.status(400).json({ error: 'No active org/season.' });
  try {
    const [orgRes, piecesRes, emailRes] = await Promise.all([
      pool.query('SELECT o.name AS org_name, s.name AS season_name FROM orgs o JOIN seasons s ON s.org_id=o.id WHERE o.id=$1 AND s.id=$2', [orgId, seasonId]),
      pool.query(
        `SELECT p.id, p.name, p.choreographer_name, p.choreographer_email,
           COALESCE(json_agg(DISTINCT jsonb_build_object('day',mb.day,'start_time',mb.start_time,'end_time',mb.end_time)) FILTER (WHERE mb.id IS NOT NULL),'[]') AS blocks,
           COALESCE(json_agg(DISTINCT jsonb_build_object('first_name',dp.first_name,'last_name',dp.last_name,'cast_role',pc.cast_role)) FILTER (WHERE pc.id IS NOT NULL),'[]') AS casts
         FROM pieces p
         LEFT JOIN master_blocks mb ON mb.piece_id=p.id
         LEFT JOIN piece_casts pc ON pc.piece_id=p.id
         LEFT JOIN dancer_profiles dp ON dp.user_id=pc.user_id
         WHERE p.season_id=$1 GROUP BY p.id ORDER BY p.created_at ASC`,
        [seasonId]
      ),
      pool.query(
        'SELECT DISTINCT u.email FROM submissions sub JOIN users u ON u.id=sub.user_id WHERE sub.org_id=$1 AND sub.season_id=$2',
        [orgId, seasonId]
      ),
    ]);
    const { org_name, season_name } = orgRes.rows[0] || {};
    res.json({
      org_name, season_name,
      pieces: piecesRes.rows,
      auditionee_count: emailRes.rows.length,
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to load publish data.' });
  }
});

// POST /api/publish/send — email cast results to all auditionees in the season
app.post('/api/publish/send', requireAuth('master'), async (req, res) => {
  if (!emailEnabled) return res.status(503).json({ error: 'Email is not configured on this server.' });
  const { blurb } = req.body;
  const { orgId, seasonId } = req.session;
  if (!orgId || !seasonId) return res.status(400).json({ error: 'No active org/season.' });
  try {
    const [orgRes, piecesRes, emailRes] = await Promise.all([
      pool.query('SELECT o.name AS org_name FROM orgs o WHERE o.id=$1', [orgId]),
      pool.query(
        `SELECT p.id, p.name, p.choreographer_name, p.choreographer_email,
           COALESCE(json_agg(DISTINCT jsonb_build_object('day',mb.day,'start_time',mb.start_time,'end_time',mb.end_time)) FILTER (WHERE mb.id IS NOT NULL),'[]') AS blocks,
           COALESCE(json_agg(DISTINCT jsonb_build_object('first_name',dp.first_name,'last_name',dp.last_name,'cast_role',pc.cast_role)) FILTER (WHERE pc.id IS NOT NULL),'[]') AS casts
         FROM pieces p
         LEFT JOIN master_blocks mb ON mb.piece_id=p.id
         LEFT JOIN piece_casts pc ON pc.piece_id=p.id
         LEFT JOIN dancer_profiles dp ON dp.user_id=pc.user_id
         WHERE p.season_id=$1 GROUP BY p.id ORDER BY p.created_at ASC`,
        [seasonId]
      ),
      pool.query(
        'SELECT DISTINCT u.email FROM submissions sub JOIN users u ON u.id=sub.user_id WHERE sub.org_id=$1 AND sub.season_id=$2',
        [orgId, seasonId]
      ),
    ]);
    const orgName = orgRes.rows[0]?.org_name || 'CastSync';
    const emails  = emailRes.rows.map(r => r.email);
    if (emails.length === 0) return res.status(400).json({ error: 'No auditionees to email.' });

    const html = buildCastingEmailHTML(orgName, blurb, piecesRes.rows);
    await Promise.all(emails.map(to =>
      resend.emails.send({ from: FROM_EMAIL, to, subject: `Casting Results — ${orgName}`, html })
        .catch(err => console.error(`Email to ${to} failed:`, err.message))
    ));
    res.json({ message: `Sent to ${emails.length} auditionee${emails.length === 1 ? '' : 's'}.` });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to send emails.' });
  }
});

function buildCastingEmailHTML(orgName, blurb, pieces) {
  const piecesHTML = pieces.map(p => {
    const blocks     = p.blocks  || [];
    const casts      = p.casts   || [];
    const members    = casts.filter(c => c.cast_role === 'member');
    const understudies = casts.filter(c => c.cast_role === 'understudy');
    const rehearsalStr = blocks.length
      ? blocks.map(b => `${b.day} ${b.start_time}–${b.end_time}`).join(', ')
      : 'TBD';
    const castLines = [
      ...members.map(c => `<p style="margin:2px 0;">${c.first_name} ${c.last_name}</p>`),
      ...understudies.map(c => `<p style="margin:2px 0;">${c.first_name} ${c.last_name} <span style="color:#888;">(understudy)</span></p>`),
    ].join('') || '<p style="color:#888;font-style:italic;">No cast assigned.</p>';
    return `
      <div style="margin-bottom:28px;padding-top:16px;border-top:1px solid #e0e0e0;">
        ${p.choreographer_name
          ? `<h3 style="margin:0 0 2px;">${p.choreographer_name}</h3>${p.choreographer_email ? `<p style="margin:0 0 8px;color:#555;font-size:14px;"><a href="mailto:${p.choreographer_email}" style="color:#555;">${p.choreographer_email}</a></p>` : ''}`
          : `<h3 style="margin:0 0 8px;color:#aaa;font-style:italic;">No choreographer listed</h3>`}
        <p style="margin:0 0 10px;color:#555;font-size:14px;">Rehearsals: ${rehearsalStr}</p>
        ${castLines}
      </div>`;
  }).join('');
  return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#222;padding:24px;">
    <h1 style="text-align:center;margin-bottom:4px;">${orgName}</h1>
    <p style="text-align:center;color:#555;margin-top:0;">Casting is now final.</p>
    ${blurb ? `<p style="color:#333;border-left:3px solid #ddd;padding:8px 12px;margin:16px 0;">${blurb.replace(/\n/g,'<br>')}</p>` : ''}
    ${piecesHTML}
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
    <p style="color:#aaa;font-size:12px;text-align:center;">CastSync — this is an automated message.</p>
  </div>`;
}

// POST /api/publish/toggle — director publishes or un-publishes casting for current season
app.post('/api/publish/toggle', requireAuth('master'), async (req, res) => {
  const { published } = req.body;
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  try {
    await pool.query('UPDATE seasons SET casting_published=$1 WHERE id=$2', [!!published, seasonId]);
    res.json({ published: !!published });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update publish state.' });
  }
});

// GET /api/publish/status — director checks current published state
app.get('/api/publish/status', requireAuth('master'), async (req, res) => {
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  try {
    const result = await pool.query('SELECT casting_published FROM seasons WHERE id=$1', [seasonId]);
    res.json({ published: result.rows[0]?.casting_published || false });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch publish state.' });
  }
});

// GET /api/my-casting — auditionee views published cast lists for all their submitted orgs
app.get('/api/my-casting', requireAuth('auditionee'), async (req, res) => {
  try {
    // Fetch the viewer's own name (any profile suffices; use most recent)
    const profileRes = await pool.query(
      `SELECT first_name, last_name FROM dancer_profiles WHERE user_id=$1 ORDER BY id DESC LIMIT 1`,
      [req.session.userId]
    );
    const viewer = profileRes.rows[0] || null;

    // All seasons the auditionee submitted to
    const subsResult = await pool.query(
      `SELECT sub.season_id, sub.org_id, o.name AS org_name, s.name AS season_name, s.casting_published
       FROM submissions sub
       JOIN seasons s ON s.id = sub.season_id
       JOIN orgs o ON o.id = sub.org_id
       WHERE sub.user_id = $1
       ORDER BY sub.created_at DESC`,
      [req.session.userId]
    );

    const results = [];
    for (const row of subsResult.rows) {
      const piecesResult = await pool.query(
        `SELECT p.id, p.name, p.color, p.choreographer_name, p.choreographer_email,
           COALESCE(json_agg(DISTINCT jsonb_build_object('day',mb.day,'start_time',mb.start_time,'end_time',mb.end_time)) FILTER (WHERE mb.id IS NOT NULL),'[]') AS blocks,
           COALESCE(json_agg(DISTINCT jsonb_build_object('first_name',dp.first_name,'last_name',dp.last_name,'cast_role',pc.cast_role)) FILTER (WHERE pc.id IS NOT NULL),'[]') AS casts,
           (SELECT cast_role FROM piece_casts WHERE piece_id=p.id AND user_id=$2) AS my_role
         FROM pieces p
         LEFT JOIN master_blocks mb ON mb.piece_id=p.id
         LEFT JOIN piece_casts pc ON pc.piece_id=p.id
         LEFT JOIN dancer_profiles dp ON dp.user_id=pc.user_id
         WHERE p.season_id=$1 GROUP BY p.id ORDER BY p.created_at ASC`,
        [row.season_id, req.session.userId]
      );
      results.push({
        org_name: row.org_name,
        season_name: row.season_name,
        casting_published: row.casting_published,
        pieces: piecesResult.rows,
      });
    }
    res.json({ viewer, orgs: results });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to load casting.' });
  }
});

// ── Master dancer routes (org/season scoped) ──────────────────────────────────

// GET /api/dancers — all submissions for current org/season
app.get('/api/dancers', requireAuth('master'), async (req, res) => {
  const { orgId, seasonId } = req.session;
  if (!orgId || !seasonId) return res.status(400).json({ error: 'No active org/season.' });
  try {
    const result = await pool.query(
      `SELECT dp.id AS profile_id, u.id AS user_id,
              dp.first_name, dp.last_name, u.email, dp.grade, sub.created_at,
              sub.audition_number,
              (SELECT COUNT(*) FROM piece_casts pc
               JOIN pieces p ON p.id = pc.piece_id
               WHERE pc.user_id = u.id AND p.season_id = $2) AS piece_count
       FROM submissions sub
       JOIN dancer_profiles dp ON dp.user_id = sub.user_id
       JOIN users u ON u.id = sub.user_id
       WHERE sub.org_id = $1 AND sub.season_id = $2
       ORDER BY dp.last_name ASC, dp.first_name ASC`,
      [orgId, seasonId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to fetch dancers.' });
  }
});

// DELETE /api/dancers/:userId/submission — remove one auditionee from current season
app.delete('/api/dancers/:userId/submission', requireAuth('master'), async (req, res) => {
  const { orgId, seasonId } = req.session;
  if (!orgId || !seasonId) return res.status(400).json({ error: 'No active org/season.' });
  try {
    const result = await pool.query(
      'DELETE FROM submissions WHERE user_id = $1 AND org_id = $2 AND season_id = $3 RETURNING id',
      [req.params.userId, orgId, seasonId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Submission not found.' });
    res.json({ message: 'Submission removed.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove submission.' });
  }
});

// DELETE /api/dancers — wipe all submissions for current season only
app.delete('/api/dancers', requireAuth('master'), async (req, res) => {
  const { orgId, seasonId } = req.session;
  if (!orgId || !seasonId) return res.status(400).json({ error: 'No active org/season.' });
  try {
    const result = await pool.query(
      'DELETE FROM submissions WHERE org_id = $1 AND season_id = $2 RETURNING id',
      [orgId, seasonId]
    );
    res.json({ message: `Cleared ${result.rowCount} submissions.` });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to clear submissions.' });
  }
});

// GET /api/dancers/search — search by name or audition number within current org/season
app.get('/api/dancers/search', requireAuth('master'), async (req, res) => {
  const { q } = req.query;
  const { orgId, seasonId } = req.session;
  if (!q || !orgId || !seasonId) return res.json([]);
  try {
    const result = await pool.query(
      `SELECT dp.id AS id, u.id AS user_id, dp.first_name, dp.last_name,
              sub.availability, sub.audition_number
       FROM submissions sub
       JOIN dancer_profiles dp ON dp.user_id = sub.user_id
       JOIN users u ON u.id = sub.user_id
       WHERE sub.org_id = $1 AND sub.season_id = $2
         AND (
           LOWER(dp.first_name || ' ' || dp.last_name) LIKE LOWER($3)
           OR LOWER(COALESCE(sub.audition_number, '')) LIKE LOWER($3)
         )
       ORDER BY dp.last_name, dp.first_name LIMIT 10`,
      [orgId, seasonId, `%${q.trim()}%`]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Search failed.' });
  }
});

// GET /api/dancers/:userId — master views one dancer's full profile
app.get('/api/dancers/:userId', requireAuth('master'), async (req, res) => {
  const { orgId, seasonId } = req.session;
  if (!orgId || !seasonId) return res.status(400).json({ error: 'No active org/season.' });
  try {
    const result = await pool.query(
      `SELECT dp.first_name, dp.last_name, u.email, dp.phone, dp.address, dp.grade,
              dp.technique_classes, sub.injuries, sub.absences, sub.availability
       FROM submissions sub
       JOIN dancer_profiles dp ON dp.user_id = sub.user_id
       JOIN users u ON u.id = sub.user_id
       WHERE sub.user_id = $1 AND sub.org_id = $2 AND sub.season_id = $3`,
      [req.params.userId, orgId, seasonId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Dancer not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to fetch dancer.' });
  }
});

// ── Pieces routes (season-scoped) ─────────────────────────────────────────────

app.get('/api/pieces', requireAuth('master'), async (req, res) => {
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  try {
    const result = await pool.query(
      'SELECT id, name, color, choreographer_name, choreographer_email, room FROM pieces WHERE season_id = $1 ORDER BY created_at ASC',
      [seasonId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch pieces.' });
  }
});

app.post('/api/pieces', requireAuth('master'), async (req, res) => {
  const { name, color } = req.body;
  const { seasonId } = req.session;
  if (!name || !color) return res.status(400).json({ error: 'Name and color required.' });
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  try {
    const result = await pool.query(
      'INSERT INTO pieces (name, color, season_id, master_id) VALUES ($1, $2, $3, $4) RETURNING id, name, color',
      [name, color, seasonId, req.session.userId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create piece.' });
  }
});

app.patch('/api/pieces/:id', requireAuth('master'), async (req, res) => {
  const { choreographer_name, choreographer_email, room } = req.body;
  try {
    await pool.query(
      'UPDATE pieces SET choreographer_name=$1, choreographer_email=$2, room=$3 WHERE id=$4 AND master_id=$5',
      [choreographer_name || null, choreographer_email || null, room || null, req.params.id, req.session.userId]
    );
    res.json({ message: 'Updated.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update piece.' });
  }
});

app.delete('/api/pieces/:id', requireAuth('master'), async (req, res) => {
  try {
    await pool.query('DELETE FROM pieces WHERE id = $1 AND master_id = $2', [req.params.id, req.session.userId]);
    res.json({ message: 'Piece deleted.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete piece.' });
  }
});

// ── Master block routes ───────────────────────────────────────────────────────

app.get('/api/master-blocks', requireAuth('master'), async (req, res) => {
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  try {
    const result = await pool.query(
      `SELECT mb.id, mb.piece_id, mb.day, mb.start_time, mb.end_time
       FROM master_blocks mb
       JOIN pieces p ON p.id = mb.piece_id
       WHERE p.season_id = $1 ORDER BY mb.created_at ASC`,
      [seasonId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch blocks.' });
  }
});

app.post('/api/master-blocks', requireAuth('master'), async (req, res) => {
  const { piece_id, day, start_time, end_time } = req.body;
  if (!piece_id || !day || !start_time || !end_time)
    return res.status(400).json({ error: 'All fields required.' });
  try {
    const result = await pool.query(
      'INSERT INTO master_blocks (piece_id, day, start_time, end_time) VALUES ($1,$2,$3,$4) RETURNING id',
      [piece_id, day, start_time, end_time]
    );
    res.status(201).json({ id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save block.' });
  }
});

app.put('/api/master-blocks/:id', requireAuth('master'), async (req, res) => {
  const { day, start_time, end_time } = req.body;
  try {
    await pool.query('UPDATE master_blocks SET day=$1, start_time=$2, end_time=$3 WHERE id=$4', [day, start_time, end_time, req.params.id]);
    res.json({ message: 'Block updated.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update block.' });
  }
});

app.delete('/api/master-blocks/:id', requireAuth('master'), async (req, res) => {
  try {
    await pool.query('DELETE FROM master_blocks WHERE id = $1', [req.params.id]);
    res.json({ message: 'Block deleted.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete block.' });
  }
});

// ── Contact form ──────────────────────────────────────────────────────────────

// POST /api/contact — log contact form submission; email when Resend is configured
app.post('/api/contact', async (req, res) => {
  const { name, email, subject, message } = req.body;
  if (!name || !email || !message) return res.status(400).json({ error: 'Name, email, and message are required.' });

  console.log(`[CONTACT] From: ${name} <${email}> | Subject: ${subject}\n${message}`);

  if (emailEnabled) {
    try {
      await resend.emails.send({
        from:    'CastSync Contact <noreply@cast-sync.com>',
        to:      'support@cast-sync.com',
        replyTo: email,
        subject: `[CastSync Contact] ${subject || 'New message'}`,
        text:    `Name: ${name}\nEmail: ${email}\nSubject: ${subject}\n\n${message}`,
      });
    } catch (err) {
      console.error('Contact email error:', err.message);
      // Still return success — message was logged
    }
  }

  res.json({ ok: true });
});

// ── Billing portal ────────────────────────────────────────────────────────────

// POST /api/billing/portal — create a Stripe Customer Portal session
app.post('/api/billing/portal', requireAuth('master'), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured.' });
  try {
    const result = await pool.query('SELECT stripe_customer_id FROM users WHERE id = $1', [req.session.userId]);
    const customerId = result.rows[0]?.stripe_customer_id;
    if (!customerId) return res.status(404).json({ error: 'No billing account found yet — complete a purchase first.' });

    const proto2     = req.headers['x-forwarded-proto'] || 'https';
    const host2      = req.headers['x-forwarded-host']  || req.headers.host;
    const baseUrl2   = process.env.APP_URL
      ? `https://${process.env.APP_URL.replace(/^https?:\/\//, '').replace(/\/$/, '')}`
      : `${proto2}://${host2}`;
    const returnUrl  = `${baseUrl2}/account.html`;
    const portalSession = await stripe.billingPortal.sessions.create({
      customer:   customerId,
      return_url: returnUrl,
    });
    res.json({ url: portalSession.url });
  } catch (err) {
    console.error('Billing portal error:', err.message);
    res.status(500).json({ error: 'Could not open billing portal.' });
  }
});

// ── Room count routes ─────────────────────────────────────────────────────────

// GET /api/season/room-count — return current season's room count
app.get('/api/season/room-count', requireAuth('master'), async (req, res) => {
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  try {
    const result = await pool.query(
      'SELECT COALESCE(room_count, 1) AS room_count FROM seasons WHERE id = $1',
      [seasonId]
    );
    res.json({ room_count: result.rows[0]?.room_count || 1 });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch room count.' });
  }
});

// PATCH /api/season/room-count — update current season's room count
app.patch('/api/season/room-count', requireAuth('master'), async (req, res) => {
  const { room_count } = req.body;
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  const n = parseInt(room_count);
  if (!n || n < 1 || n > 20) return res.status(400).json({ error: 'Room count must be between 1 and 20.' });
  try {
    await pool.query('UPDATE seasons SET room_count = $1 WHERE id = $2', [n, seasonId]);
    req.session.roomCount = n;
    res.json({ room_count: n });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update room count.' });
  }
});

// ── Dancer conflict route ─────────────────────────────────────────────────────

// GET /api/conflicts/dancers — check if any dancers are double-booked at a proposed time
// Query params: day, start_time, end_time, user_ids (comma-separated), exclude_piece_id (optional)
app.get('/api/conflicts/dancers', requireAuth('master'), async (req, res) => {
  const { day, start_time, end_time, user_ids, exclude_piece_id } = req.query;
  const { seasonId } = req.session;
  if (!seasonId || !day || !start_time || !end_time)
    return res.status(400).json({ error: 'Missing params.' });

  try {
    const userIdList = (user_ids || '').split(',').map(Number).filter(Boolean);
    if (!userIdList.length) return res.json([]);

    const excludeId = exclude_piece_id ? parseInt(exclude_piece_id) : null;

    // Get all pieces this season where these dancers are cast, plus their blocks on the given day
    const result = await pool.query(
      `SELECT pc.user_id, dp.first_name, dp.last_name, p.id AS piece_id, p.name AS piece_name,
              mb.start_time AS block_start, mb.end_time AS block_end
       FROM piece_casts pc
       JOIN pieces p ON p.id = pc.piece_id AND p.season_id = $1
       JOIN master_blocks mb ON mb.piece_id = p.id AND mb.day = $2
       JOIN dancer_profiles dp ON dp.user_id = pc.user_id
       WHERE pc.user_id = ANY($3)
         AND ($4::integer IS NULL OR p.id != $4::integer)`,
      [seasonId, day, userIdList, excludeId]
    );

    // Parse time string "H:MM AM/PM" → minutes since midnight
    function parseTime(str) {
      const [time, ampm] = str.trim().split(' ');
      const [h, m]       = time.split(':').map(Number);
      let hour = h;
      if (ampm === 'PM' && hour !== 12) hour += 12;
      if (ampm === 'AM' && hour === 12) hour = 0;
      return hour * 60 + m;
    }

    const newStart = parseTime(start_time);
    const newEnd   = parseTime(end_time);

    const conflicts = result.rows.filter(row => {
      const bs = parseTime(row.block_start);
      const be = parseTime(row.block_end);
      return newStart < be && newEnd > bs;
    });

    // Deduplicate — keep first conflict per dancer
    const seen   = new Set();
    const unique = conflicts.filter(c => {
      if (seen.has(c.user_id)) return false;
      seen.add(c.user_id);
      return true;
    });

    res.json(unique);
  } catch (err) {
    console.error('Dancer conflict check error:', err.message);
    res.status(500).json({ error: 'Failed to check conflicts.' });
  }
});

// ── Availability route (season-scoped) ───────────────────────────────────────

app.get('/api/availability/piece/:pieceId', requireAuth('master'), async (req, res) => {
  const { orgId, seasonId } = req.session;
  if (!orgId || !seasonId) return res.status(400).json({ error: 'No active org/season.' });

  function timeToMinutes(t) {
    const [time, ampm] = t.trim().split(' ');
    const [h, m] = time.split(':').map(Number);
    let hour = h;
    if (ampm === 'PM' && hour !== 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    return hour * 60 + m;
  }

  try {
    const blocksResult = await pool.query(
      'SELECT day, start_time, end_time FROM master_blocks WHERE piece_id = $1',
      [req.params.pieceId]
    );
    const pieceBlocks = blocksResult.rows;
    if (pieceBlocks.length === 0)
      return res.json({ piece_blocks: [], fully_available: [], partially_available: [] });

    const dancersResult = await pool.query(
      `SELECT dp.id, u.id AS user_id, dp.first_name, dp.last_name, sub.availability,
              sub.audition_number, pc.cast_role AS existing_cast_role
       FROM submissions sub
       JOIN dancer_profiles dp ON dp.user_id = sub.user_id
       JOIN users u ON u.id = sub.user_id
       LEFT JOIN piece_casts pc ON pc.piece_id = $3 AND pc.user_id = u.id
       WHERE sub.org_id = $1 AND sub.season_id = $2 AND sub.availability IS NOT NULL`,
      [orgId, seasonId, req.params.pieceId]
    );

    const fully = [], partially = [];
    dancersResult.rows.forEach(dancer => {
      const avail = dancer.availability || [];
      let covered = 0;
      pieceBlocks.forEach(block => {
        const bs = timeToMinutes(block.start_time), be = timeToMinutes(block.end_time);
        if (avail.some(ab => ab.day === block.day && timeToMinutes(ab.startTime) <= bs && timeToMinutes(ab.endTime) >= be))
          covered++;
      });
      const entry = {
        id: dancer.user_id,
        first_name: dancer.first_name,
        last_name: dancer.last_name,
        audition_number: dancer.audition_number || null,
        cast_role: dancer.existing_cast_role || null,
      };
      if (covered === pieceBlocks.length) fully.push(entry);
      else if (covered > 0)              partially.push(entry);
    });

    res.json({ piece_blocks: pieceBlocks, fully_available: fully, partially_available: partially });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to check availability.' });
  }
});

// ── Piece casts routes ────────────────────────────────────────────────────────

// GET /api/piece-casts — all casts for pieces in the current season
app.get('/api/piece-casts', requireAuth('master'), async (req, res) => {
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  try {
    const result = await pool.query(
      `SELECT pc.id, pc.piece_id, pc.user_id, pc.cast_role,
              p.name AS piece_name, p.color AS piece_color,
              dp.first_name, dp.last_name
       FROM piece_casts pc
       JOIN pieces p ON p.id = pc.piece_id
       JOIN dancer_profiles dp ON dp.user_id = pc.user_id
       WHERE p.season_id = $1
       ORDER BY p.created_at ASC, pc.cast_role ASC, dp.last_name ASC, dp.first_name ASC`,
      [seasonId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to fetch casts.' });
  }
});

// POST /api/piece-casts — add (or update role of) a dancer in a piece's cast
app.post('/api/piece-casts', requireAuth('master'), async (req, res) => {
  const { piece_id, user_id, cast_role } = req.body;
  if (!piece_id || !user_id || !cast_role) return res.status(400).json({ error: 'piece_id, user_id, and cast_role required.' });
  if (!['member', 'understudy'].includes(cast_role)) return res.status(400).json({ error: 'cast_role must be member or understudy.' });
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  try {
    // Verify piece belongs to this season
    const pieceCheck = await pool.query('SELECT id FROM pieces WHERE id = $1 AND season_id = $2', [piece_id, seasonId]);
    if (pieceCheck.rows.length === 0) return res.status(403).json({ error: 'Piece not in active season.' });

    const result = await pool.query(
      `INSERT INTO piece_casts (piece_id, user_id, cast_role)
       VALUES ($1, $2, $3)
       ON CONFLICT (piece_id, user_id) DO UPDATE SET cast_role = EXCLUDED.cast_role
       RETURNING id, cast_role`,
      [piece_id, user_id, cast_role]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to add to cast.' });
  }
});

// DELETE /api/piece-casts/:id — remove a dancer from a piece's cast
app.delete('/api/piece-casts/:id', requireAuth('master'), async (req, res) => {
  try {
    await pool.query('DELETE FROM piece_casts WHERE id = $1', [req.params.id]);
    res.json({ message: 'Removed from cast.' });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to remove from cast.' });
  }
});

// ── Auto-migration ────────────────────────────────────────────────────────────

async function runMigrations() {
  // Step 1: base tables
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        email         VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255),
        google_id     VARCHAR(255) UNIQUE,
        role          VARCHAR(50) NOT NULL DEFAULT 'auditionee',
        created_at    TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS orgs (
        id         SERIAL PRIMARY KEY,
        name       VARCHAR(255) NOT NULL,
        join_code  VARCHAR(20)  NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS org_members (
        id         SERIAL PRIMARY KEY,
        org_id     INTEGER REFERENCES orgs(id) ON DELETE CASCADE,
        user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
        role       VARCHAR(20) NOT NULL DEFAULT 'owner',
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (org_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS seasons (
        id         SERIAL PRIMARY KEY,
        org_id     INTEGER REFERENCES orgs(id) ON DELETE CASCADE,
        name       VARCHAR(255) NOT NULL,
        is_active  BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS dancer_profiles (
        id                SERIAL PRIMARY KEY,
        user_id           INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE,
        first_name        VARCHAR(100),
        last_name         VARCHAR(100),
        phone             VARCHAR(50),
        address           TEXT,
        grade             VARCHAR(50),
        technique_classes TEXT,
        updated_at        TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS submissions (
        id           SERIAL PRIMARY KEY,
        user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
        org_id       INTEGER REFERENCES orgs(id) ON DELETE CASCADE,
        season_id    INTEGER REFERENCES seasons(id) ON DELETE CASCADE,
        injuries     TEXT,
        absences     TEXT,
        availability JSONB,
        created_at   TIMESTAMP DEFAULT NOW(),
        UNIQUE (user_id, season_id)
      );
      CREATE TABLE IF NOT EXISTS pieces (
        id         SERIAL PRIMARY KEY,
        name       VARCHAR(255) NOT NULL,
        color      VARCHAR(50),
        master_id  INTEGER REFERENCES users(id) ON DELETE CASCADE,
        season_id  INTEGER REFERENCES seasons(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS master_blocks (
        id         SERIAL PRIMARY KEY,
        piece_id   INTEGER REFERENCES pieces(id) ON DELETE CASCADE,
        day        VARCHAR(20),
        start_time VARCHAR(20),
        end_time   VARCHAR(20),
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS piece_casts (
        id         SERIAL PRIMARY KEY,
        piece_id   INTEGER REFERENCES pieces(id) ON DELETE CASCADE,
        user_id    INTEGER REFERENCES users(id)  ON DELETE CASCADE,
        cast_role  VARCHAR(20) NOT NULL DEFAULT 'member',
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (piece_id, user_id)
      );
    `);
    console.log('Migration step 1 (base tables) complete.');
  } catch (err) { console.error('Migration step 1 error:', err.message); }

  // Step 2: safe column additions
  try {
    await pool.query(`
      DO $$ BEGIN
        ALTER TABLE users ADD COLUMN google_id VARCHAR(255) UNIQUE;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN
        ALTER TABLE pieces ADD COLUMN season_id INTEGER REFERENCES seasons(id) ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN
        ALTER TABLE users ADD COLUMN is_director BOOLEAN NOT NULL DEFAULT FALSE;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN
        ALTER TABLE pieces ADD COLUMN choreographer_name VARCHAR(255);
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN
        ALTER TABLE pieces ADD COLUMN choreographer_email VARCHAR(255);
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN
        ALTER TABLE seasons ADD COLUMN casting_published BOOLEAN NOT NULL DEFAULT FALSE;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN
        ALTER TABLE users ADD COLUMN reset_token VARCHAR(64);
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN
        ALTER TABLE users ADD COLUMN reset_token_expires TIMESTAMP;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN
        ALTER TABLE seasons ADD COLUMN join_code VARCHAR(20) UNIQUE;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN
        ALTER TABLE submissions ADD COLUMN audition_number VARCHAR(20);
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
    `);
    console.log('Migration step 2 (column additions) complete.');
  } catch (err) { console.error('Migration step 2 error:', err.message); }

  // Step 3: backfill join codes for productions that don't have one yet
  try {
    const nullSeasons = await pool.query('SELECT id FROM seasons WHERE join_code IS NULL');
    for (const row of nullSeasons.rows) {
      let done = false;
      while (!done) {
        try {
          const code = generateJoinCode();
          await pool.query('UPDATE seasons SET join_code = $1 WHERE id = $2', [code, row.id]);
          done = true;
        } catch (e) {
          if (e.code !== '23505') throw e; // retry only on unique collision
        }
      }
    }
    console.log('Migration step 3 (join code backfill) complete.');
  } catch (err) { console.error('Migration step 3 error:', err.message); }

  // Step 4: season_members table for production-level co-directors
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS season_members (
        id         SERIAL PRIMARY KEY,
        season_id  INTEGER REFERENCES seasons(id) ON DELETE CASCADE,
        user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
        role       VARCHAR(20) NOT NULL DEFAULT 'editor',
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (season_id, user_id)
      );
    `);
    console.log('Migration step 4 (season_members) complete.');
  } catch (err) { console.error('Migration step 4 error:', err.message); }

  // Step 5: room_count on seasons (multi-room conflict detection)
  try {
    await pool.query(`
      DO $$ BEGIN
        ALTER TABLE seasons ADD COLUMN room_count INTEGER NOT NULL DEFAULT 1;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
    `);
    console.log('Migration step 5 (room_count) complete.');
  } catch (err) { console.error('Migration step 5 error:', err.message); }

  // Step 6: stripe_session_id on seasons (payment tracking)
  try {
    await pool.query(`
      DO $$ BEGIN
        ALTER TABLE seasons ADD COLUMN stripe_session_id VARCHAR(255) UNIQUE;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
    `);
    console.log('Migration step 6 (stripe_session_id) complete.');
  } catch (err) { console.error('Migration step 6 error:', err.message); }

  // Step 7: room on pieces (multi-room support)
  try {
    await pool.query(`
      DO $$ BEGIN
        ALTER TABLE pieces ADD COLUMN room VARCHAR(100);
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
    `);
    console.log('Migration step 7 (pieces.room) complete.');
  } catch (err) { console.error('Migration step 7 error:', err.message); }

  // Step 8: stripe_customer_id on users (billing portal)
  try {
    await pool.query(`
      DO $$ BEGIN
        ALTER TABLE users ADD COLUMN stripe_customer_id VARCHAR(100);
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
    `);
    console.log('Migration step 8 (users.stripe_customer_id) complete.');
  } catch (err) { console.error('Migration step 8 error:', err.message); }

  // Step 9: plan_type + plan_expires_at on users (annual subscription)
  try {
    await pool.query(`
      DO $$ BEGIN
        ALTER TABLE users ADD COLUMN plan_type VARCHAR(20) NOT NULL DEFAULT 'none';
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN
        ALTER TABLE users ADD COLUMN plan_expires_at TIMESTAMP;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
    `);
    console.log('Migration step 9 (users.plan_type / plan_expires_at) complete.');
  } catch (err) { console.error('Migration step 9 error:', err.message); }

  // Step 10: email verification columns on users
  try {
    await pool.query(`
      DO $$ BEGIN
        ALTER TABLE users ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT TRUE;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN
        ALTER TABLE users ADD COLUMN verification_token VARCHAR(100);
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
    `);
    console.log('Migration step 10 (email_verified / verification_token) complete.');
  } catch (err) { console.error('Migration step 10 error:', err.message); }

  console.log('All migrations complete.');
}

// ── Sentry error handler (must be after all routes) ──────────────────────────
Sentry.setupExpressErrorHandler(app);

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server running at http://localhost:${PORT}`);
  if (!process.env.GOOGLE_CLIENT_ID) console.log('  → Google OAuth not configured');
  if (!emailEnabled)                  console.log('  → Email not configured (set RESEND_API_KEY)');
  await runMigrations();
});
