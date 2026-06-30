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

async function sendConfirmationEmail(toEmail, secondaryEmail, data, orgName, seasonName, isUpdate = false) {
  if (!emailEnabled) return;
  const { first_name, last_name, phone, address, grade, technique_classes, injuries, absences, availability } = data;
  const recipients = [toEmail, secondaryEmail].filter(Boolean);
  const availLines = (availability || []).map(a =>
    `${a.day}: ${a.startTime} – ${a.endTime}${a.category ? ` (${CATEGORY_LABELS[a.category] || a.category})` : ''}`
  ).join('<br>') || 'None provided';
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
      to:      recipients,
      subject: `CastSync Submission ${subjectTag} — ${orgName}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#222;">
        <h2 style="margin-bottom:4px;">${heading}</h2>
        <p style="color:#555;margin-top:0;">${intro}</p>
        <p style="color:#555;font-size:13px;">To update your information, log back in and resubmit — your previous submission will be replaced.</p>
        <table style="width:100%;border-collapse:collapse;border:1px solid #e0e0e0;border-radius:6px;overflow:hidden;margin-top:16px;">
          ${row('Name', `${first_name} ${last_name}`)}
          ${row('Email', toEmail)}
          ${row('Secondary Email', secondaryEmail)}
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

function timeToMinutes(t) {
  const [time, ampm] = t.trim().split(' ');
  const [h, m] = time.split(':').map(Number);
  let hour = h;
  if (ampm === 'PM' && hour !== 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  return hour * 60 + m;
}

// Detailed weekly schedule mode (seasons.availability_mode = 'detailed'): blocks carry
// a category. Simple grid mode (the only mode that ever existed before, and still the
// default) never sets category at all. A block with no category always counts as
// available, so every existing submission keeps working with zero migration and no
// reader needs to know which mode produced the data, only whether each block is tagged.
const AVAILABILITY_CATEGORIES = ['academic_class', 'dance_class', 'work', 'available', 'other'];
const CATEGORY_LABELS = { academic_class: 'Academic Class', dance_class: 'Dance Class', work: 'Work', available: 'Available To Rehearse', other: 'Other' };

function isAvailableBlock(block) {
  return !block.category || block.category === 'available';
}

const AVAILABILITY_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const AVAILABILITY_WINDOW_START = 480;  // 8:00 AM, in minutes
const AVAILABILITY_WINDOW_END   = 1380; // 11:00 PM, in minutes

function minutesToTimeString(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hr   = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${m.toString().padStart(2, '0')} ${ampm}`;
}

// Detailed mode only: every day must tile [8:00 AM, 11:00 PM) exactly, no gaps or
// overlaps, every block tagged with a real category. Returns an error string naming
// the day and problem, or null if valid. Client-side painting can't produce an invalid
// state, but this never trusts the client.
function validateDetailedAvailability(availability) {
  for (const day of AVAILABILITY_DAYS) {
    const intervals = [];
    for (const b of availability.filter(b => b.day === day)) {
      if (!AVAILABILITY_CATEGORIES.includes(b.category)) return `${day}: every block needs a valid category.`;
      const start = timeToMinutes(b.startTime), end = timeToMinutes(b.endTime);
      if (!(end > start)) return `${day}: a block's end time must be after its start time.`;
      intervals.push({ start, end });
    }
    intervals.sort((a, b) => a.start - b.start);
    let expected = AVAILABILITY_WINDOW_START;
    for (const iv of intervals) {
      if (iv.start > expected) return `${day}: there's a gap before ${minutesToTimeString(iv.start)}.`;
      if (iv.start < expected) return `${day}: two blocks overlap around ${minutesToTimeString(iv.start)}.`;
      expected = iv.end;
    }
    if (expected < AVAILABILITY_WINDOW_END) return `${day}: the schedule doesn't reach all the way to 11:00 PM.`;
  }
  return null;
}

// Formats a Date as YYYY-MM-DD using its LOCAL calendar fields, never toISOString()
// (which reports in UTC and can shift the date near midnight depending on server
// timezone). Every date constructed/compared in generateOccurrences goes through this
// pair with dateFromYMD, mirroring the existing `${date}T00:00:00` pattern already used
// for attendance's day-of-week lookup (see GET /api/season/attendance below).
function ymd(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function dateFromYMD(dateStr) {
  return new Date(`${dateStr}T00:00:00`);
}

// Generates dated rehearsal occurrences for [startDateStr, endDateStr] (inclusive) by
// walking the weekly master_blocks template day-by-day and layering master_block_exceptions
// on top. The template is never modified here; this is a read-only computed view.
async function generateOccurrences(seasonId, startDateStr, endDateStr) {
  const blocksResult = await pool.query(
    `SELECT mb.id AS master_block_id, mb.piece_id, mb.day, mb.start_time, mb.end_time, mb.room_id,
            p.name AS piece_name, p.color AS piece_color
     FROM master_blocks mb JOIN pieces p ON p.id = mb.piece_id
     WHERE p.season_id = $1`,
    [seasonId]
  );
  const blockById = new Map(blocksResult.rows.map(b => [b.master_block_id, b]));
  const exceptionsResult = await pool.query(
    `SELECT mbe.id, mbe.piece_id, mbe.master_block_id, to_char(mbe.original_date,'YYYY-MM-DD') AS original_date,
            mbe.type, to_char(mbe.new_date,'YYYY-MM-DD') AS new_date, mbe.new_start_time, mbe.new_end_time, mbe.note, mbe.room_id,
            p.name AS piece_name, p.color AS piece_color
     FROM master_block_exceptions mbe JOIN pieces p ON p.id = mbe.piece_id
     WHERE mbe.season_id = $1`,
    [seasonId]
  );

  // Indexed by "<master_block_id>|<original_date>" for O(1) lookup per template candidate.
  const exceptionByKey = new Map();
  for (const e of exceptionsResult.rows) {
    if (e.master_block_id) exceptionByKey.set(`${e.master_block_id}|${e.original_date}`, e);
  }

  const occurrences = [];

  // Pass 1: walk every calendar day in range, emit each template block's occurrence on
  // days matching its weekday, unless a cancelled/moved exception overrides that exact
  // (master_block_id, date) pair. A moved block's NEW slot is not emitted here; it's
  // surfaced in pass 2 below, which has no coupling to this day-loop. Do not merge the
  // two passes: a moved block's new_date can fall outside [startDateStr, endDateStr]'s
  // corresponding original-date walk entirely (e.g. moved from last week into this one).
  let cursor = dateFromYMD(startDateStr);
  const end  = dateFromYMD(endDateStr);
  while (cursor <= end) {
    const dateStr   = ymd(cursor);
    const dayOfWeek = cursor.toLocaleDateString('en-US', { weekday: 'long' });
    for (const block of blocksResult.rows) {
      if (block.day !== dayOfWeek) continue;
      const exc = exceptionByKey.get(`${block.master_block_id}|${dateStr}`);
      if (exc && (exc.type === 'cancelled' || exc.type === 'moved')) continue;
      occurrences.push({
        date: dateStr, piece_id: block.piece_id, piece_name: block.piece_name, piece_color: block.piece_color,
        start_time: block.start_time, end_time: block.end_time, room_id: block.room_id,
        source: 'template', master_block_id: block.master_block_id,
      });
    }
    cursor.setDate(cursor.getDate() + 1); // never millisecond arithmetic -- stays correct across DST transitions
  }

  // Pass 2: every moved/added exception whose new_date falls in range, regardless of
  // whether its original_date was in range. A moved block landing on a day where that
  // same piece also has a separate, untouched template block is correct (two real
  // rehearsals that day), not a duplicate to dedupe. piece_name/piece_color come from the
  // exception row's own join to pieces, not blocksResult, since 'added' rows have no
  // master_block_id to look a template block up by.
  for (const e of exceptionsResult.rows) {
    if ((e.type === 'moved' || e.type === 'added') && e.new_date >= startDateStr && e.new_date <= endDateStr) {
      // A moved rehearsal keeps its template's room by default unless the move itself
      // specified a different one; an added (one-time, no template) rehearsal has only
      // whatever room it was given directly.
      const fallbackRoomId = e.type === 'moved' ? blockById.get(e.master_block_id)?.room_id ?? null : null;
      occurrences.push({
        date: e.new_date, piece_id: e.piece_id, piece_name: e.piece_name, piece_color: e.piece_color,
        start_time: e.new_start_time, end_time: e.new_end_time, room_id: e.room_id ?? fallbackRoomId,
        source: e.type, exception_id: e.id, master_block_id: e.master_block_id, note: e.note,
      });
    }
  }

  occurrences.sort((a, b) => a.date === b.date ? timeToMinutes(a.start_time) - timeToMinutes(b.start_time) : (a.date < b.date ? -1 : 1));
  return occurrences;
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
  const googleCallbackURL = `${APP_URL}/auth/google/callback`;
  console.log('[startup] Google callbackURL:', googleCallbackURL);
  passport.use(new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: googleCallbackURL,
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
        // Welcome email for new Google signups
        if (emailEnabled) {
          resend.emails.send({
            from: 'CastSync <noreply@cast-sync.com>',
            to:   email,
            subject: 'Welcome to CastSync!',
            html: `
              <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#111;">
                <div style="font-family:'Georgia',serif;font-size:22px;font-weight:700;margin-bottom:24px;">CastSync</div>
                <p style="font-size:15px;line-height:1.6;">Welcome! Your account is all set up.</p>
                <p style="font-size:14px;color:#6b7280;line-height:1.6;">You can now submit audition forms, view your cast results, and — if you have a director access code — manage your own productions.</p>
                <div style="margin:28px 0;">
                  <a href="${APP_URL}/auditionForm.html"
                     style="background:#111111;color:#fff;padding:12px 24px;border-radius:8px;
                            text-decoration:none;font-weight:600;font-size:14px;display:inline-block;">
                    Get Started
                  </a>
                </div>
                <p style="font-size:12px;color:#9ca3af;">Questions? Reply to this email or visit <a href="${APP_URL}/contact.html" style="color:#9ca3af;">cast-sync.com/contact</a>.</p>
              </div>`,
          }).catch(() => {}); // don't block login if email fails
        }
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

    // Activate 10-day trial for new director accounts
    if (role === 'master') {
      await pool.query(
        `UPDATE users SET plan_type = 'trial', plan_expires_at = NOW() + INTERVAL '10 days' WHERE id = $1`,
        [user.id]
      );
    }

    if (!emailEnabled) {
      // No email configured (local dev) — auto-verify and log in
      await pool.query('UPDATE users SET email_verified = TRUE, verification_token = NULL WHERE id = $1', [user.id]);
      req.session.userId = user.id;
      req.session.role   = user.role;
      req.session.email  = user.email;
      return res.status(201).json({ id: user.id, email: user.email, role: user.role, trialActivated: role === 'master' });
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

    res.status(201).json({ needsVerification: true, email: user.email, trialActivated: role === 'master' });
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

// GET /api/auth/account-settings: Account page data not carried in the session
// (display name, Google-link status, a pending email change, notification prefs)
app.get('/api/auth/account-settings', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
  try {
    const result = await pool.query(
      `SELECT name, google_id IS NOT NULL AS google_linked, pending_email, notification_prefs
       FROM users WHERE id = $1`,
      [req.session.userId]
    );
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'Account not found.' });
    res.json({
      name: row.name,
      googleLinked: row.google_linked,
      pendingEmail: row.pending_email,
      notificationPrefs: row.notification_prefs || {},
    });
  } catch (err) {
    console.error('Account settings error:', err.message);
    res.status(500).json({ error: 'Failed to load account settings.' });
  }
});

// PATCH /api/auth/name: set or clear the logged-in user's display name
app.patch('/api/auth/name', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
  const name = (req.body.name || '').trim();
  try {
    await pool.query('UPDATE users SET name = $1 WHERE id = $2', [name || null, req.session.userId]);
    res.json({ name: name || null });
  } catch (err) {
    console.error('Update name error:', err.message);
    res.status(500).json({ error: 'Failed to update name.' });
  }
});

// PATCH /api/auth/notification-prefs: merge a partial set of category toggles into
// the logged-in user's preferences (missing keys are left as-is; checked at send time
// by emailAllowed() near getDirectorEmails)
app.patch('/api/auth/notification-prefs', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
  const allowedKeys = ['casting_updates', 'absence_requests', 'schedule_changes', 'production_notes'];
  const updates = {};
  for (const key of allowedKeys) {
    if (typeof req.body[key] === 'boolean') updates[key] = req.body[key];
  }
  try {
    const result = await pool.query(
      'UPDATE users SET notification_prefs = notification_prefs || $1::jsonb WHERE id = $2 RETURNING notification_prefs',
      [JSON.stringify(updates), req.session.userId]
    );
    res.json({ notificationPrefs: result.rows[0]?.notification_prefs || {} });
  } catch (err) {
    console.error('Update notification prefs error:', err.message);
    res.status(500).json({ error: 'Failed to update notification preferences.' });
  }
});

// POST /api/auth/change-email: request an email change; the NEW address must confirm
// it's real and reachable before the change takes effect (mirrors forgot-password's
// token pattern, but on a dedicated column so it can't collide with signup verification)
app.post('/api/auth/change-email', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
  const { password, newEmail } = req.body;
  if (!password || !newEmail) return res.status(400).json({ error: 'Password and new email are required.' });
  const normalizedEmail = newEmail.toLowerCase().trim();
  try {
    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.session.userId]);
    const user   = result.rows[0];
    if (!user || !user.password_hash) return res.status(400).json({ error: 'Cannot change email for this account type.' });
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(403).json({ error: 'Incorrect password.' });

    const taken = await pool.query('SELECT id FROM users WHERE email = $1 AND id != $2', [normalizedEmail, req.session.userId]);
    if (taken.rows.length > 0) return res.status(400).json({ error: 'That email is already in use.' });

    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      'UPDATE users SET pending_email = $1, email_change_token = $2 WHERE id = $3',
      [normalizedEmail, token, req.session.userId]
    );

    if (emailEnabled) {
      await resend.emails.send({
        from:    FROM_EMAIL,
        to:      normalizedEmail,
        subject: 'Confirm your new CastSync email',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;">
            <h2 style="margin-bottom:8px;">Confirm your new email</h2>
            <p>Click the link below to finish changing your CastSync login email to this address.</p>
            <p style="margin:24px 0;">
              <a href="${APP_URL}/confirm-email-change.html?token=${token}"
                 style="background:#111;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;">
                Confirm Email Change
              </a>
            </p>
            <p style="color:#888;font-size:13px;">If you didn't request this, you can safely ignore this email -- your login email won't change until this link is clicked.</p>
          </div>`,
      }).catch(err => console.error('Change-email confirmation send error:', err.message));
    }
    res.json({ message: 'Confirmation email sent to your new address.', pendingEmail: normalizedEmail });
  } catch (err) {
    console.error('Change email error:', err.message);
    res.status(500).json({ error: 'Failed to start email change.' });
  }
});

// GET /api/auth/confirm-email-change: finalize a pending email change. Does not touch
// req.session: this link is normally opened from an email client, not necessarily the
// same browser session that requested the change.
app.get('/api/auth/confirm-email-change', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Token required.' });
  try {
    const result = await pool.query(
      `UPDATE users SET email = pending_email, pending_email = NULL, email_change_token = NULL
       WHERE email_change_token = $1
       RETURNING email`,
      [token]
    );
    if (!result.rows.length) return res.status(400).json({ error: 'This confirmation link is invalid or has already been used.' });
    res.json({ ok: true, email: result.rows[0].email });
  } catch (err) {
    console.error('Confirm email change error:', err.message);
    res.status(500).json({ error: 'Failed to confirm email change.' });
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
    const userRow = await pool.query(
      'UPDATE users SET password_hash=$1, reset_token=NULL, reset_token_expires=NULL, email_verified=TRUE WHERE id=$2 RETURNING email',
      [hash, result.rows[0].id]
    );
    // Security notification
    if (emailEnabled && userRow.rows[0]?.email) {
      resend.emails.send({
        from: FROM_EMAIL,
        to:   userRow.rows[0].email,
        subject: 'Your CastSync password was changed',
        html: `
          <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#111;">
            <div style="font-family:'Georgia',serif;font-size:22px;font-weight:700;margin-bottom:24px;">CastSync</div>
            <p style="font-size:15px;line-height:1.6;">Your CastSync password was just changed successfully.</p>
            <p style="font-size:14px;color:#6b7280;">If you made this change, no action is needed.</p>
            <p style="font-size:14px;color:#6b7280;">If you did <strong>not</strong> make this change, contact us immediately at <a href="mailto:support@cast-sync.com" style="color:#111;">support@cast-sync.com</a>.</p>
          </div>`,
      }).catch(() => {});
    }
    // Destroy any existing session so the user logs in fresh as the correct account
    req.session.destroy(() => {
      res.json({ message: 'Password updated.' });
    });
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
      `SELECT o.name AS org_name, s.name AS season_name, s.form_schema, s.availability_mode
       FROM seasons s JOIN orgs o ON o.id = s.org_id
       WHERE UPPER(s.join_code) = UPPER($1) LIMIT 1`,
      [join_code.trim()]
    );
    if (result.rows.length === 0) return res.json({ found: false });
    res.json({
      found: true,
      org_name: result.rows[0].org_name,
      season_name: result.rows[0].season_name,
      form_schema: result.rows[0].form_schema || [],
      availability_mode: result.rows[0].availability_mode || 'grid',
    });
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
  const { email, can_see_other_blocks } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });
  try {
    // Verify the requester is the org owner
    const ownerCheck = await pool.query(
      'SELECT id FROM org_members WHERE org_id = $1 AND user_id = $2 AND role = $3',
      [req.params.orgId, req.session.userId, 'owner']
    );
    if (ownerCheck.rows.length === 0) return res.status(403).json({ error: 'Only the org owner can invite co-directors.' });

    // Get org + season names for the notification email
    const infoResult = await pool.query(
      `SELECT o.name AS org_name, s.name AS season_name
       FROM orgs o JOIN seasons s ON s.id = $1 AND s.org_id = o.id
       WHERE o.id = $2`,
      [req.params.seasonId, req.params.orgId]
    );
    const orgName    = infoResult.rows[0]?.org_name    || 'your organization';
    const seasonName = infoResult.rows[0]?.season_name || 'a production';

    // Get owner email for the notification
    const ownerResult = await pool.query('SELECT email FROM users WHERE id = $1', [req.session.userId]);
    const ownerEmail  = ownerResult.rows[0]?.email || 'A director';

    const normalizedEmail = email.toLowerCase().trim();
    let inviteeId;
    let isNewUser = false;

    // Look up existing user
    const userResult = await pool.query('SELECT id, role FROM users WHERE email = $1', [normalizedEmail]);

    if (userResult.rows.length > 0) {
      // Existing user — promote to master if needed
      inviteeId = userResult.rows[0].id;
      if (userResult.rows[0].role !== 'master') {
        await pool.query("UPDATE users SET role = 'master', is_director = TRUE WHERE id = $1", [inviteeId]);
      }
    } else {
      // No account yet — create one so they can access director pages after setting a password
      isNewUser = true;
      const newUser = await pool.query(
        `INSERT INTO users (email, role, is_director, email_verified)
         VALUES ($1, 'master', TRUE, TRUE) RETURNING id`,
        [normalizedEmail]
      );
      inviteeId = newUser.rows[0].id;
    }

    // Add to season_members (update can_see_other_blocks if re-inviting)
    await pool.query(
      `INSERT INTO season_members (season_id, user_id, role, can_see_other_blocks)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (season_id, user_id) DO UPDATE SET can_see_other_blocks = EXCLUDED.can_see_other_blocks`,
      [req.params.seasonId, inviteeId, 'editor', !!can_see_other_blocks]
    );

    // Send notification email
    if (emailEnabled) {
      const actionURL   = isNewUser ? `${APP_URL}/forgot-password.html` : `${APP_URL}/login.html`;
      const actionLabel = isNewUser ? 'Set Up Your Account' : 'Go to CastSync';
      const bodyText    = isNewUser
        ? `${ownerEmail} has invited you to join CastSync as a co-director for <strong>${seasonName}</strong> at <strong>${orgName}</strong>. Click below to set up your password and get started.`
        : `${ownerEmail} has added you as a co-director for <strong>${seasonName}</strong> at <strong>${orgName}</strong> on CastSync. You now have full access to that production's scheduling and casting.`;

      await resend.emails.send({
        from: 'CastSync <noreply@cast-sync.com>',
        to:   normalizedEmail,
        subject: `You've been added as a co-director on CastSync`,
        html: `
          <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#111;">
            <div style="font-family:'Georgia',serif;font-size:22px;font-weight:700;margin-bottom:24px;">CastSync</div>
            <p style="font-size:15px;line-height:1.6;">${bodyText}</p>
            <p style="font-size:13px;color:#6b7280;margin-top:0;">You'll only see this production — not the owner's other work.</p>
            <div style="margin:28px 0;">
              <a href="${actionURL}"
                 style="background:#111111;color:#fff;padding:12px 24px;border-radius:8px;
                        text-decoration:none;font-weight:600;font-size:14px;display:inline-block;">
                ${actionLabel}
              </a>
            </div>
            <p style="font-size:12px;color:#9ca3af;">If you didn't expect this email, you can ignore it.</p>
          </div>`,
      });
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
      query  = `SELECT s.id, s.name, s.join_code, s.is_active, s.status, s.created_at,
                       (SELECT COUNT(*) FROM submissions WHERE season_id = s.id) AS submission_count
                FROM seasons s
                WHERE s.org_id = $1
                ORDER BY s.created_at DESC`;
      params = [req.params.orgId];
    } else {
      // Production co-director: only seasons in season_members
      query  = `SELECT s.id, s.name, s.join_code, s.is_active, s.status, s.created_at,
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
        `SELECT s.id, s.name, s.join_code, s.is_active, s.status, s.created_at,
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

// GET /api/orgs/:orgId/form-template — org-wide default audition form (reused as a
// starting point whenever a new production is created)
app.get('/api/orgs/:orgId/form-template', requireAuth('master'), async (req, res) => {
  try {
    const isOrgMember = await pool.query(
      'SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2',
      [req.params.orgId, req.session.userId]
    );
    if (isOrgMember.rows.length === 0) return res.status(403).json({ error: 'Not a member of this organization.' });

    const result = await pool.query('SELECT default_form_schema FROM orgs WHERE id = $1', [req.params.orgId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Organization not found.' });
    res.json({ form_schema: result.rows[0].default_form_schema || [] });
  } catch (err) {
    console.error('GET org form-template error:', err.message);
    res.status(500).json({ error: 'Failed to load form template.' });
  }
});

// PUT /api/orgs/:orgId/form-template — director edits the org-wide default form
app.put('/api/orgs/:orgId/form-template', requireAuth('master'), async (req, res) => {
  const { form_schema } = req.body;
  if (!Array.isArray(form_schema)) return res.status(400).json({ error: 'form_schema must be an array.' });
  try {
    const isOrgMember = await pool.query(
      'SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2',
      [req.params.orgId, req.session.userId]
    );
    if (isOrgMember.rows.length === 0) return res.status(403).json({ error: 'Not a member of this organization.' });

    await pool.query('UPDATE orgs SET default_form_schema = $1 WHERE id = $2', [JSON.stringify(form_schema), req.params.orgId]);
    res.json({ form_schema });
  } catch (err) {
    console.error('PUT org form-template error:', err.message);
    res.status(500).json({ error: 'Failed to save form template.' });
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
    const isAnnualActive = (plan_type === 'annual' || plan_type === 'free' || plan_type === 'trial') &&
      (!plan_expires_at || new Date(plan_expires_at) > new Date());
    const isTrial = plan_type === 'trial' && plan_expires_at && new Date(plan_expires_at) > new Date();
    const daysRemaining = isTrial
      ? Math.max(0, Math.ceil((new Date(plan_expires_at) - new Date()) / (1000 * 60 * 60 * 24)))
      : null;
    res.json({ planType: plan_type || 'none', planExpiresAt: plan_expires_at || null, isAnnualActive, isTrial, daysRemaining });
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

// POST /api/promo/check — validate any code; returns type ('free' | 'annual' | 'discount') + value
app.post('/api/promo/check', requireAuth('master'), (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code is required.' });
  const upper = code.trim().toUpperCase();

  const freeCodes = (process.env.PROMO_CODES || '').split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
  if (freeCodes.includes(upper)) {
    return res.json({ type: 'free' });
  }

  const annualCodes = (process.env.ANNUAL_CODES || '').split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
  if (annualCodes.includes(upper)) {
    return res.json({ type: 'annual' });
  }

  const discountMap = parseDiscountCodes();
  if (discountMap.has(upper)) {
    return res.json({ type: 'discount', percent: discountMap.get(upper) });
  }

  res.status(400).json({ error: 'Invalid or expired promo code.' });
});

// POST /api/promo/redeem — apply a free-access or annual promo code to the user's account
app.post('/api/promo/redeem', requireAuth('master'), async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code is required.' });
  const upper = code.trim().toUpperCase();

  const freeCodes = (process.env.PROMO_CODES || '').split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
  const annualCodes = (process.env.ANNUAL_CODES || '').split(',').map(c => c.trim().toUpperCase()).filter(Boolean);

  const isFree   = freeCodes.includes(upper);
  const isAnnual = annualCodes.includes(upper);

  if (!isFree && !isAnnual) {
    return res.status(400).json({ error: 'Invalid or expired promo code.' });
  }

  try {
    if (isAnnual) {
      await pool.query(
        `UPDATE users SET plan_type = 'annual', plan_expires_at = NOW() + INTERVAL '1 year' WHERE id = $1`,
        [req.session.userId]
      );
      res.json({ ok: true, message: 'Promo code applied! You have one full year of Pro access.' });
    } else {
      await pool.query(
        `UPDATE users SET plan_type = 'free', plan_expires_at = NULL WHERE id = $1`,
        [req.session.userId]
      );
      res.json({ ok: true, message: 'Promo code applied! You have free unlimited access.' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Could not apply promo code.' });
  }
});

// POST /api/checkout/create-session — start Stripe checkout for a new production
app.post('/api/checkout/create-session', requireAuth('master'), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured.' });
  const { orgId, productionName, plan, discountCode, formSource } = req.body;
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
        form_source:     formSource || 'org_default',
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

    const { org_id, production_name, plan, form_source } = session.metadata;

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
      return res.json({ seasonId: s.id, plan: plan || 'payasyougo', form_source: form_source || 'org_default' });
    }

    // Create the season
    let row, inserted = false;
    while (!inserted) {
      try {
        const code = generateJoinCode();
        const result = await pool.query(
          `INSERT INTO seasons (org_id, name, is_active, join_code, stripe_session_id, form_schema)
           VALUES ($1,$2,TRUE,$3,$4,
             CASE WHEN $5 = 'blank' THEN '[]'::jsonb ELSE (SELECT default_form_schema FROM orgs WHERE id = $1) END)
           RETURNING id, name`,
          [org_id, production_name, code, session_id, form_source || 'org_default']
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

    res.json({ seasonId: row.id, plan: plan || 'payasyougo', form_source: form_source || 'org_default' });
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

    const { org_id, production_name, plan, user_id, form_source } = session.metadata;
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
            `INSERT INTO seasons (org_id, name, is_active, join_code, stripe_session_id, form_schema)
             VALUES ($1,$2,TRUE,$3,$4,
               CASE WHEN $5 = 'blank' THEN '[]'::jsonb ELSE (SELECT default_form_schema FROM orgs WHERE id = $1) END)`,
            [org_id, production_name, code, sessionId, form_source || 'org_default']
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
  const { name, form_source } = req.body;
  if (!name) return res.status(400).json({ error: 'Production name is required.' });
  try {
    let row, inserted = false;
    while (!inserted) {
      try {
        const code = generateJoinCode();
        const result = await pool.query(
          `INSERT INTO seasons (org_id, name, is_active, join_code, form_schema)
           VALUES ($1, $2, TRUE, $3,
             CASE WHEN $4 = 'blank' THEN '[]'::jsonb ELSE (SELECT default_form_schema FROM orgs WHERE id = $1) END)
           RETURNING id, name, join_code`,
          [req.params.orgId, name.trim(), code, form_source || 'org_default']
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
    const hasAnnual = (plan_type === 'annual' || plan_type === 'free' || plan_type === 'trial') &&
      (!plan_expires_at || new Date(plan_expires_at) > new Date());
    if (!hasAnnual) return res.status(403).json({ error: 'An active annual plan is required.' });

    // Verify membership in this org
    const memberCheck = await pool.query(
      'SELECT id FROM org_members WHERE org_id = $1 AND user_id = $2',
      [req.params.orgId, req.session.userId]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member of this organization.' });

    const { name, form_source } = req.body;
    if (!name) return res.status(400).json({ error: 'Production name is required.' });

    let row, inserted = false;
    while (!inserted) {
      try {
        const code = generateJoinCode();
        const result = await pool.query(
          `INSERT INTO seasons (org_id, name, is_active, join_code, form_schema)
           VALUES ($1,$2,TRUE,$3,
             CASE WHEN $4 = 'blank' THEN '[]'::jsonb ELSE (SELECT default_form_schema FROM orgs WHERE id = $1) END)
           RETURNING id, name, join_code`,
          [req.params.orgId, name.trim(), code, form_source || 'org_default']
        );
        row = result.rows[0];
        inserted = true;
      } catch (e) {
        if (e.code !== '23505') throw e;
      }
    }

    // Mock auditionees are no longer auto-copied into newly created productions --
    // mock identity is per-production now (see /seed-mock), so a director chooses
    // per-production whether to seed demo data rather than a new show silently
    // inheriting another one's test data.

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
    // Every page's header reads the cached req.session.seasonName (via /api/auth/me), so
    // without this the renaming director would see the old name everywhere until they
    // log out, even though the DB is already correct.
    if (req.session.seasonId == req.params.seasonId) req.session.seasonName = name.trim();
    res.json({ message: 'Production renamed.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to rename production.' });
  }
});

// PATCH /api/orgs/:orgId/seasons/:seasonId/my-schedule-enabled: enable/disable the
// "My Rehearsals" auditionee portal for this production. Intentionally a separate route
// from the rename PATCH so each settings concern has a clear, narrow surface area.
app.patch('/api/orgs/:orgId/seasons/:seasonId/my-schedule-enabled', requireAuth('master'), async (req, res) => {
  const { orgId, seasonId } = req.params;
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean.' });
  try {
    const check = await pool.query(
      'SELECT id FROM org_members WHERE org_id = $1 AND user_id = $2',
      [orgId, req.session.userId]
    );
    if (check.rows.length === 0) return res.status(403).json({ error: 'Not a member of this organization.' });
    await pool.query(
      'UPDATE seasons SET my_schedule_enabled = $1 WHERE id = $2 AND org_id = $3',
      [enabled, seasonId, orgId]
    );
    res.json({ enabled });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update My Rehearsals setting.' });
  }
});

// PATCH /api/orgs/:orgId/seasons/:seasonId/status — archive or activate a production
app.patch('/api/orgs/:orgId/seasons/:seasonId/status', requireAuth('master'), async (req, res) => {
  const { status } = req.body;
  if (!['active', 'archived'].includes(status)) return res.status(400).json({ error: 'status must be active or archived.' });
  try {
    const check = await pool.query(
      'SELECT id FROM org_members WHERE org_id = $1 AND user_id = $2 AND role = $3',
      [req.params.orgId, req.session.userId, 'owner']
    );
    if (check.rows.length === 0) return res.status(403).json({ error: 'Only the org owner can change production status.' });
    await pool.query('UPDATE seasons SET status = $1 WHERE id = $2 AND org_id = $3', [status, req.params.seasonId, req.params.orgId]);
    res.json({ status });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update production status.' });
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
          technique_classes, injuries, absences, availability, audition_number,
          custom_responses, secondary_email } = req.body;

  if (!join_code)   return res.status(400).json({ error: 'Join code is required.' });
  if (!first_name || !last_name) return res.status(400).json({ error: 'Name is required.' });

  try {
    // Look up production by its join code
    const seasonLookup = await pool.query(
      `SELECT s.id AS season_id, s.name AS season_name, s.availability_mode, o.id AS org_id, o.name AS org_name
       FROM seasons s JOIN orgs o ON o.id = s.org_id
       WHERE UPPER(s.join_code) = UPPER($1) LIMIT 1`,
      [join_code.trim()]
    );
    if (seasonLookup.rows.length === 0)
      return res.status(404).json({ error: 'Invalid code. Please check with your director.' });

    const org    = { id: seasonLookup.rows[0].org_id,    name: seasonLookup.rows[0].org_name };
    const season = { id: seasonLookup.rows[0].season_id, name: seasonLookup.rows[0].season_name };

    if (seasonLookup.rows[0].availability_mode === 'detailed') {
      const validationError = validateDetailedAvailability(availability || []);
      if (validationError) return res.status(400).json({ error: validationError });
    }

    // Upsert dancer profile (reusable across orgs)
    await pool.query(
      `INSERT INTO dancer_profiles (user_id, first_name, last_name, phone, address, grade, technique_classes, secondary_email, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         first_name=$2, last_name=$3, phone=$4, address=$5, grade=$6, technique_classes=$7, secondary_email=$8, updated_at=NOW()`,
      [req.session.userId, first_name, last_name, phone||null, address||null, grade||null, technique_classes||null, secondary_email||null]
    );

    // Check for existing submission this season
    const existing = await pool.query(
      'SELECT id FROM submissions WHERE user_id = $1 AND season_id = $2',
      [req.session.userId, season.id]
    );

    const isUpdate = existing.rows.length > 0;

    // Trial cap: new submissions only; block at 15 real (non-mock) auditionees per production
    if (!isUpdate) {
      const ownerRow = await pool.query(
        `SELECT u.plan_type, u.plan_expires_at
         FROM org_members om JOIN users u ON u.id = om.user_id
         WHERE om.org_id = $1 AND om.role = 'owner' LIMIT 1`,
        [org.id]
      );
      if (ownerRow.rows.length > 0) {
        const { plan_type: ownerPlan, plan_expires_at: ownerExpiry } = ownerRow.rows[0];
        const isTrial = ownerPlan === 'trial' && ownerExpiry && new Date(ownerExpiry) > new Date();
        if (isTrial) {
          const countResult = await pool.query(
            `SELECT COUNT(*) FROM submissions s JOIN users u ON u.id = s.user_id
             WHERE s.season_id = $1 AND u.is_mock = FALSE`,
            [season.id]
          );
          if (parseInt(countResult.rows[0].count) >= 15) {
            return res.status(403).json({
              error: 'This production has reached its 15-auditionee trial limit. Please contact the director for more information.',
              trialLimitReached: true,
            });
          }
        }
      }
    }

    const audNum = audition_number ? audition_number.toString().trim() : null;
    const customResponsesJson = JSON.stringify(custom_responses || {});
    if (isUpdate) {
      await pool.query(
        `UPDATE submissions SET injuries=$1, absences=$2, availability=$3, audition_number=$4, custom_responses=$5
         WHERE user_id=$6 AND season_id=$7`,
        [injuries||null, absences||null, JSON.stringify(availability||[]), audNum, customResponsesJson, req.session.userId, season.id]
      );
    } else {
      await pool.query(
        `INSERT INTO submissions (user_id, org_id, season_id, injuries, absences, availability, audition_number, custom_responses)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [req.session.userId, org.id, season.id, injuries||null, absences||null, JSON.stringify(availability||[]), audNum, customResponsesJson]
      );
    }

    // Get user email for confirmation
    const userResult = await pool.query('SELECT email FROM users WHERE id = $1', [req.session.userId]);
    const userEmail  = userResult.rows[0].email;

    emailAllowed(req.session.userId, 'casting_updates').then(allowed => {
      if (allowed) sendConfirmationEmail(userEmail, secondary_email,
        { first_name, last_name, phone, address, grade, technique_classes, injuries, absences, availability },
        org.name, season.name, isUpdate
      );
    });

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
           COALESCE(json_agg(DISTINCT jsonb_build_object('first_name',dp.first_name,'last_name',dp.last_name,'cast_role',pc.cast_role,'role_name',pc.role_name)) FILTER (WHERE pc.id IS NOT NULL),'[]') AS casts
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
           COALESCE(json_agg(DISTINCT jsonb_build_object('first_name',dp.first_name,'last_name',dp.last_name,'cast_role',pc.cast_role,'role_name',pc.role_name)) FILTER (WHERE pc.id IS NOT NULL),'[]') AS casts
         FROM pieces p
         LEFT JOIN master_blocks mb ON mb.piece_id=p.id
         LEFT JOIN piece_casts pc ON pc.piece_id=p.id
         LEFT JOIN dancer_profiles dp ON dp.user_id=pc.user_id
         WHERE p.season_id=$1 GROUP BY p.id ORDER BY p.created_at ASC`,
        [seasonId]
      ),
      pool.query(
        `SELECT DISTINCT u.id AS user_id, u.email, dp.secondary_email
         FROM submissions sub JOIN users u ON u.id=sub.user_id
         LEFT JOIN dancer_profiles dp ON dp.user_id = u.id
         WHERE sub.org_id=$1 AND sub.season_id=$2`,
        [orgId, seasonId]
      ),
    ]);
    const orgName = orgRes.rows[0]?.org_name || 'CastSync';
    if (emailRes.rows.length === 0) return res.status(400).json({ error: 'No auditionees to email.' });

    const html = buildCastingEmailHTML(orgName, blurb, piecesRes.rows);
    let sentCount = 0;
    await Promise.all(emailRes.rows.map(async ({ user_id, email, secondary_email }) => {
      if (!(await emailAllowed(user_id, 'casting_updates'))) return;
      sentCount++;
      return resend.emails.send({ from: FROM_EMAIL, to: [email, secondary_email].filter(Boolean), subject: `Casting Results — ${orgName}`, html })
        .catch(err => console.error(`Email to ${email} failed:`, err.message));
    }));
    res.json({ message: `Sent to ${sentCount} auditionee${sentCount === 1 ? '' : 's'}.` });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to send emails.' });
  }
});

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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
      ...members.map(c => `<p style="margin:2px 0;">${c.first_name} ${c.last_name}${c.role_name ? `, ${escapeHtml(c.role_name)}` : ''}</p>`),
      ...understudies.map(c => `<p style="margin:2px 0;">${c.first_name} ${c.last_name}${c.role_name ? `, ${escapeHtml(c.role_name)}` : ''} <span style="color:#888;">(understudy)</span></p>`),
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
           COALESCE(json_agg(DISTINCT jsonb_build_object('first_name',dp.first_name,'last_name',dp.last_name,'cast_role',pc.cast_role,'role_name',pc.role_name)) FILTER (WHERE pc.id IS NOT NULL),'[]') AS casts,
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

// ── My Schedule (auditionee) ─────────────────────────────────────────────────

// GET /api/my-schedule/status: lightweight check so every auditionee page can decide
// whether to show the "My Rehearsals" nav link without fetching the full schedule.
// Returns { available: bool } -- true only when BOTH my_schedule_enabled AND
// casting_published are true for the auditionee's current org/season.
app.get('/api/my-schedule/status', requireAuth('auditionee'), async (req, res) => {
  const { orgId, seasonId } = req.session;
  if (!orgId || !seasonId) return res.json({ available: false });
  try {
    const result = await pool.query(
      'SELECT my_schedule_enabled, casting_published FROM seasons WHERE id = $1 AND org_id = $2',
      [seasonId, orgId]
    );
    const row = result.rows[0];
    res.json({ available: !!(row?.my_schedule_enabled && row?.casting_published) });
  } catch (err) {
    res.json({ available: false });
  }
});

// GET /api/my-schedule: the full dated rehearsal list for this auditionee, scoped to
// pieces they are cast in for their current org/season. Reuses generateOccurrences()
// (the same function the Master Schedule page uses) and filters the result -- no
// separate scheduling system.
app.get('/api/my-schedule', requireAuth('auditionee'), async (req, res) => {
  const { orgId, seasonId, userId } = req.session;
  if (!orgId || !seasonId) return res.status(400).json({ error: 'No active org/season.' });
  try {
    const seasonRes = await pool.query(
      `SELECT name, casting_published, my_schedule_enabled,
              to_char(start_date,'YYYY-MM-DD') AS start_date,
              to_char(end_date,'YYYY-MM-DD') AS end_date
       FROM seasons WHERE id = $1 AND org_id = $2`,
      [seasonId, orgId]
    );
    const season = seasonRes.rows[0];
    if (!season) return res.status(404).json({ error: 'Season not found.' });

    if (!season.my_schedule_enabled || !season.casting_published) {
      return res.json({ available: false });
    }

    // No date range set yet -- feature is on but director hasn't configured the schedule window.
    if (!season.start_date || !season.end_date) {
      return res.json({ available: true, season_name: season.name, rehearsals: [], pieces: {} });
    }

    const castRes = await pool.query(
      `SELECT pc.piece_id FROM piece_casts pc
       JOIN pieces p ON p.id = pc.piece_id
       WHERE pc.user_id = $1 AND p.season_id = $2`,
      [userId, seasonId]
    );
    const myPieceIds = new Set(castRes.rows.map(r => r.piece_id));

    if (myPieceIds.size === 0) {
      return res.json({ available: true, season_name: season.name, rehearsals: [], pieces: {} });
    }

    const all = await generateOccurrences(seasonId, season.start_date, season.end_date);
    const mine = all.filter(o => myPieceIds.has(o.piece_id));

    // Fetch metadata for just the pieces this auditionee is in -- one query, not per-row.
    const [piecesRes, roomsRes] = await Promise.all([
      pool.query(
        `SELECT id, name, color, choreographer_name FROM pieces WHERE id = ANY($1)`,
        [Array.from(myPieceIds)]
      ),
      pool.query(
        `SELECT id, name FROM rooms WHERE season_id = $1`,
        [seasonId]
      ),
    ]);
    const pieceMap = Object.fromEntries(piecesRes.rows.map(p => [p.id, p]));
    const roomMap  = Object.fromEntries(roomsRes.rows.map(r => [r.id, r.name]));

    const rehearsals = mine.map(o => ({
      date:               o.date,
      piece_id:           o.piece_id,
      start_time:         o.start_time,
      end_time:           o.end_time,
      room_name:          o.room_id ? (roomMap[o.room_id] || null) : null,
      note:               o.note || null,
      source:             o.source,
    }));

    res.json({ available: true, season_name: season.name, rehearsals, pieces: pieceMap });
  } catch (err) {
    console.error('My schedule error:', err.message);
    res.status(500).json({ error: 'Failed to load rehearsal schedule.' });
  }
});

// ── Absence requests ─────────────────────────────────────────────────────────
// Lightweight request workflow: an auditionee submits a date/time/reason and,
// once casting is published, which of their own pieces it affects (or TBD before
// that). Directors/co-directors review and update status; the auditionee and, if
// a piece is set, that piece's choreographer get emailed on submission and on every
// status change. Choreographers are notified by email only (pieces.choreographer_email)
// since there's no choreographer account/role yet; notifyChoreographerForPiece is the
// one place that lookup happens, so adding real accounts later is a one-function change.

const ABSENCE_STATUSES = ['pending', 'approved', 'denied'];
const ABSENCE_STATUS_LABELS = { pending: 'Pending', approved: 'Approved', denied: 'Denied' };

// Returns { email, userId } pairs (not bare emails) so callers can check each
// recipient's own notification preference before sending -- see emailAllowed below.
async function getDirectorEmails(orgId, seasonId) {
  const [orgMembers, seasonMembers] = await Promise.all([
    pool.query(`SELECT DISTINCT u.id AS user_id, u.email FROM org_members om JOIN users u ON u.id = om.user_id WHERE om.org_id = $1`, [orgId]),
    pool.query(`SELECT DISTINCT u.id AS user_id, u.email FROM season_members sm JOIN users u ON u.id = sm.user_id WHERE sm.season_id = $1`, [seasonId]),
  ]);
  const seen = new Map();
  [...orgMembers.rows, ...seasonMembers.rows].forEach(r => seen.set(r.email, { email: r.email, userId: r.user_id }));
  return [...seen.values()];
}

// Notification preferences are an opt-out model (missing key = enabled), so every
// existing user keeps getting every email until they explicitly turn a category off.
// No userId (e.g. a choreographer, who has no real account) always passes -- there's
// no preference to check.
async function emailAllowed(userId, category) {
  if (!userId) return true;
  try {
    const r = await pool.query('SELECT notification_prefs FROM users WHERE id = $1', [userId]);
    return r.rows[0]?.notification_prefs?.[category] !== false;
  } catch (err) {
    console.error('emailAllowed error:', err.message);
    return true;
  }
}

async function notifyChoreographerForPiece(pieceId, subject, html) {
  if (!emailEnabled || !pieceId) return;
  try {
    const result = await pool.query('SELECT choreographer_email FROM pieces WHERE id = $1', [pieceId]);
    const email = result.rows[0]?.choreographer_email;
    if (!email) return;
    await resend.emails.send({ from: FROM_EMAIL, to: email, subject, html }).catch(err => console.error('Choreographer email error:', err.message));
  } catch (err) { console.error('notifyChoreographerForPiece error:', err.message); }
}

// Returns { email, userId } pairs. Secondary emails share the cast member's own userId
// and preference -- there's only one person to ask, even though they have two inboxes.
async function getCastEmailsForPiece(pieceId) {
  const result = await pool.query(
    `SELECT u.id AS user_id, u.email, dp.secondary_email FROM piece_casts pc
     JOIN users u ON u.id = pc.user_id
     LEFT JOIN dancer_profiles dp ON dp.user_id = u.id
     WHERE pc.piece_id = $1`,
    [pieceId]
  );
  const seen = new Map();
  result.rows.forEach(r => {
    [r.email, r.secondary_email].filter(Boolean).forEach(email => seen.set(email, { email, userId: r.user_id }));
  });
  return [...seen.values()];
}

// Notifies everyone a rehearsal schedule change (cancel/move/add/undo) affects: every
// cast member of the piece (primary + secondary email), every director/co-director of
// the production, and the choreographer if one is on file. Mirrors the absence-request
// notification pattern exactly, just with a different recipient mix (cast instead of
// the single auditionee who filed the request).
async function notifyPieceScheduleChange(pieceId, orgId, seasonId, subject, html) {
  if (!emailEnabled || !pieceId) return;
  try {
    const [castRecipients, directorRecipients] = await Promise.all([
      getCastEmailsForPiece(pieceId),
      getDirectorEmails(orgId, seasonId),
    ]);
    const seen = new Map();
    [...castRecipients, ...directorRecipients].forEach(r => seen.set(r.email, r));
    for (const { email, userId } of seen.values()) {
      if (!(await emailAllowed(userId, 'schedule_changes'))) continue;
      resend.emails.send({ from: FROM_EMAIL, to: email, subject, html }).catch(err => console.error('Schedule change email error:', err.message));
    }
    notifyChoreographerForPiece(pieceId, subject, html);
  } catch (err) { console.error('notifyPieceScheduleChange error:', err.message); }
}

function formatDateLong(dateStr) {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function scheduleChangeEmailHTML(orgName, seasonName, pieceName, bodyText) {
  return `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#222;">
    <h3 style="margin-bottom:4px;">Schedule Update</h3>
    <p style="color:#555;font-size:13px;margin-top:0;">${orgName}, ${seasonName} &middot; ${pieceName}</p>
    <p>${bodyText}</p>
    <p style="color:#aaa;font-size:12px;">This is an automated message from CastSync.</p>
  </div>`;
}

// GET /api/my-absence-context: every production the auditionee submitted to, with
// casting-published status and the pieces they're actually cast in (for the form's
// piece-or-TBD picker)
app.get('/api/my-absence-context', requireAuth('auditionee'), async (req, res) => {
  try {
    const subsResult = await pool.query(
      `SELECT sub.org_id, sub.season_id, o.name AS org_name, s.name AS season_name, s.casting_published
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
        `SELECT p.id, p.name FROM pieces p
         JOIN piece_casts pc ON pc.piece_id = p.id
         WHERE p.season_id = $1 AND pc.user_id = $2
         ORDER BY p.name`,
        [row.season_id, req.session.userId]
      );
      results.push({
        org_id: row.org_id,
        season_id: row.season_id,
        org_name: row.org_name,
        season_name: row.season_name,
        casting_published: row.casting_published,
        my_pieces: piecesResult.rows,
      });
    }
    res.json(results);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to load production context.' });
  }
});

// POST /api/absence-requests: auditionee submits a new request
app.post('/api/absence-requests', requireAuth('auditionee'), async (req, res) => {
  const { season_id, absence_date, start_time, end_time, reason, piece_id, documentation_link } = req.body;
  if (!season_id || !absence_date || !start_time || !end_time || !reason || !reason.trim()) {
    return res.status(400).json({ error: 'season_id, absence_date, start_time, end_time, and reason are required.' });
  }
  const docLink = documentation_link ? documentation_link.trim() : '';
  if (docLink && !/^https?:\/\//i.test(docLink)) {
    return res.status(400).json({ error: 'Documentation link must start with http:// or https://.' });
  }
  try {
    const seasonRow = await pool.query(
      `SELECT s.org_id, s.name AS season_name, s.casting_published, o.name AS org_name
       FROM seasons s JOIN orgs o ON o.id = s.org_id
       JOIN submissions sub ON sub.season_id = s.id AND sub.user_id = $2
       WHERE s.id = $1`,
      [season_id, req.session.userId]
    );
    if (seasonRow.rows.length === 0) return res.status(403).json({ error: 'You have not submitted to this production.' });
    const { org_id, org_name, season_name, casting_published } = seasonRow.rows[0];

    // Only honor piece_id once casting is published, and only for a piece this
    // dancer is actually cast in, regardless of what the client sent.
    let finalPieceId = null;
    if (casting_published && piece_id) {
      const pieceCheck = await pool.query(
        `SELECT p.id, p.name FROM pieces p JOIN piece_casts pc ON pc.piece_id = p.id
         WHERE p.id = $1 AND p.season_id = $2 AND pc.user_id = $3`,
        [piece_id, season_id, req.session.userId]
      );
      if (pieceCheck.rows.length > 0) finalPieceId = pieceCheck.rows[0].id;
    }

    const result = await pool.query(
      `INSERT INTO absence_requests (user_id, org_id, season_id, absence_date, start_time, end_time, reason, piece_id, documentation_link)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [req.session.userId, org_id, season_id, absence_date, start_time, end_time, reason.trim(), finalPieceId, docLink || null]
    );
    const requestId = result.rows[0].id;

    const profileRow = await pool.query('SELECT first_name, last_name FROM dancer_profiles WHERE user_id = $1', [req.session.userId]);
    const dancerName = profileRow.rows[0] ? `${profileRow.rows[0].first_name} ${profileRow.rows[0].last_name}` : 'A dancer';
    const userRow = await pool.query('SELECT email, secondary_email FROM users u LEFT JOIN dancer_profiles dp ON dp.user_id = u.id WHERE u.id = $1', [req.session.userId]);
    const { email: dancerEmail, secondary_email: dancerSecondaryEmail } = userRow.rows[0] || {};
    const pieceLabel = finalPieceId
      ? (await pool.query('SELECT name FROM pieces WHERE id = $1', [finalPieceId])).rows[0]?.name
      : 'TBD / not yet assigned';
    const docLinkHtml = docLink
      ? `<p style="color:#555;font-size:13px;">Documentation: <a href="${docLink}">${docLink}</a></p>`
      : '';

    if (emailEnabled && await emailAllowed(req.session.userId, 'absence_requests')) {
      const recipients = [dancerEmail, dancerSecondaryEmail].filter(Boolean);
      resend.emails.send({
        from: FROM_EMAIL,
        to: recipients,
        subject: `Absence Request Received for ${org_name}`,
        html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#222;">
          <h3 style="margin-bottom:4px;">Absence Request Received</h3>
          <p style="color:#555;font-size:13px;margin-top:0;">${org_name}, ${season_name}</p>
          <p>We've received your absence request for <strong>${absence_date}</strong>, ${start_time} to ${end_time}.</p>
          <p style="color:#555;font-size:13px;">Reason: ${reason.trim()}</p>
          <p style="color:#555;font-size:13px;">Piece: ${pieceLabel}</p>
          ${docLinkHtml}
          <p style="color:#aaa;font-size:12px;">You'll get an email when your director updates the status. This is an automated message.</p>
        </div>`,
      }).catch(err => console.error('Absence confirmation email error:', err.message));
    }

    if (emailEnabled) {
      getDirectorEmails(org_id, season_id).then(async directorRecipients => {
        for (const { email, userId } of directorRecipients) {
          if (!email || !(await emailAllowed(userId, 'absence_requests'))) continue;
          resend.emails.send({
            from: FROM_EMAIL,
            to: email,
            subject: `New Absence Request from ${dancerName} for ${org_name}`,
            html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#222;">
              <h3 style="margin-bottom:4px;">New Absence Request</h3>
              <p style="color:#555;font-size:13px;margin-top:0;">${org_name}, ${season_name}</p>
              <p><strong>${dancerName}</strong> requested an absence for <strong>${absence_date}</strong>, ${start_time} to ${end_time}.</p>
              <p style="color:#555;font-size:13px;">Reason: ${reason.trim()}</p>
              <p style="color:#555;font-size:13px;">Piece: ${pieceLabel}</p>
              ${docLinkHtml}
              <p style="color:#aaa;font-size:12px;">Review and update its status on the Absence Requests tab.</p>
            </div>`,
          }).catch(err => console.error('Director absence-notify email error:', err.message));
        }
      });

      if (finalPieceId) {
        notifyChoreographerForPiece(finalPieceId, `Absence Request for ${pieceLabel} in ${org_name}`,
          `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#222;">
            <h3 style="margin-bottom:4px;">Absence Request</h3>
            <p style="color:#555;font-size:13px;margin-top:0;">${org_name}, ${season_name} · ${pieceLabel}</p>
            <p><strong>${dancerName}</strong> requested an absence for <strong>${absence_date}</strong>, ${start_time} to ${end_time}.</p>
            <p style="color:#555;font-size:13px;">Reason: ${reason.trim()}</p>
            ${docLinkHtml}
          </div>`
        );
      }
    }

    res.status(201).json({ id: requestId });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to save absence request.' });
  }
});

// GET /api/my-absence-requests: auditionee's own past requests, across every production
app.get('/api/my-absence-requests', requireAuth('auditionee'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ar.id, ar.absence_date, ar.start_time, ar.end_time, ar.reason, ar.status, ar.created_at,
              ar.documentation_link, o.name AS org_name, s.name AS season_name, p.name AS piece_name
       FROM absence_requests ar
       JOIN orgs o ON o.id = ar.org_id
       JOIN seasons s ON s.id = ar.season_id
       LEFT JOIN pieces p ON p.id = ar.piece_id
       WHERE ar.user_id = $1
       ORDER BY ar.created_at DESC`,
      [req.session.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to load your absence requests.' });
  }
});

// ── Master dancer routes (org/season scoped) ──────────────────────────────────

// GET /api/dancers — all submissions for current org/season
app.get('/api/dancers', requireAuth('master'), async (req, res) => {
  const { orgId, seasonId } = req.session;
  if (!orgId || !seasonId) return res.status(400).json({ error: 'No active org/season.' });
  try {
    const result = await pool.query(
      `SELECT dp.id AS profile_id, u.id AS user_id, u.is_mock,
              dp.first_name, dp.last_name, u.email, dp.phone, dp.address,
              dp.grade, dp.technique_classes, sub.injuries, sub.absences,
              sub.created_at, sub.audition_number, sub.custom_responses,
              (SELECT COUNT(*) FROM piece_casts pc
               JOIN pieces p ON p.id = pc.piece_id
               WHERE pc.user_id = u.id AND p.season_id = $2) AS piece_count,
              (SELECT COUNT(*) FROM piece_casts pc2
               JOIN pieces p2 ON p2.id = pc2.piece_id
               JOIN seasons s2 ON s2.id = p2.season_id
               WHERE pc2.user_id = u.id AND s2.org_id = $1
                 AND (s2.status IS NULL OR s2.status = 'active')) AS org_piece_count
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

// POST /api/orgs/:orgId/seasons/:seasonId/seed-mock — seed 15 mock auditionees into ALL productions for this org
// Three availability patterns, not one uniform "open every day" block for all 15 --
// otherwise there's nothing for a director to actually exercise when testing
// Availability Analysis / Master Schedule / Cast Builder / Casting against this data,
// since every dancer would be equally free at every hour.
function mockAvailabilityPattern(index) {
  const wideOpen = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
    .map(day => ({ day, startTime: '9:00 AM', endTime: '9:00 PM' }));
  const weekdayEvenings = ['Monday','Tuesday','Wednesday','Thursday','Friday']
    .map(day => ({ day, startTime: '4:00 PM', endTime: '9:00 PM' }));
  const weekendHeavy = [
    { day: 'Tuesday',  startTime: '5:00 PM', endTime: '9:00 PM' },
    { day: 'Thursday', startTime: '5:00 PM', endTime: '9:00 PM' },
    { day: 'Saturday', startTime: '9:00 AM', endTime: '9:00 PM' },
    { day: 'Sunday',   startTime: '9:00 AM', endTime: '9:00 PM' },
  ];
  if (index < 10) return wideOpen;        // dancers 1-10
  if (index < 13) return weekdayEvenings; // dancers 11-13
  return weekendHeavy;                    // dancers 14-15
}

// POST /api/orgs/:orgId/seasons/:seasonId/seed-mock: 15 mock auditionees for THIS
// production only. Mock identity is season-scoped (mock-N-s{seasonId}@...) specifically
// so this can be repeated independently per production -- seeding one show never
// touches, blocks, or duplicates into any other production in the same org.
app.post('/api/orgs/:orgId/seasons/:seasonId/seed-mock', requireAuth('master'), async (req, res) => {
  const { orgId, seasonId } = req.params;
  try {
    const memberCheck = await pool.query(
      'SELECT id FROM org_members WHERE org_id = $1 AND user_id = $2',
      [orgId, req.session.userId]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member of this organization.' });

    const seasonCheck = await pool.query('SELECT id FROM seasons WHERE id = $1 AND org_id = $2', [seasonId, orgId]);
    if (seasonCheck.rows.length === 0) return res.status(404).json({ error: 'Production not found in this organization.' });

    const existingMocks = await pool.query(
      `SELECT COUNT(*) FROM users WHERE email LIKE $1 AND is_mock = TRUE`,
      [`mock-%-s${seasonId}@trial.castsync.app`]
    );
    if (parseInt(existingMocks.rows[0].count) > 0) {
      return res.status(409).json({ error: 'This production already has mock auditionees. Clear them first if you want to reseed.' });
    }

    const mockDancers = [
      { first: 'Ava',      last: 'Chen',      grade: '11th', technique: 'Ballet, Jazz'          },
      { first: 'Marcus',   last: 'Rivera',    grade: '10th', technique: 'Contemporary, Hip Hop'  },
      { first: 'Priya',    last: 'Patel',     grade: '12th', technique: 'Ballet, Modern'         },
      { first: 'Jordan',   last: 'Williams',  grade: '9th',  technique: 'Jazz, Tap'              },
      { first: 'Sofia',    last: 'Martinez',  grade: '11th', technique: 'Contemporary, Ballet'   },
      { first: 'Elijah',   last: 'Thompson',  grade: '10th', technique: 'Hip Hop, Jazz'          },
      { first: 'Mei',      last: 'Lin',       grade: '12th', technique: 'Ballet, Contemporary'   },
      { first: 'Caden',    last: 'Harris',    grade: '9th',  technique: 'Jazz, Modern'           },
      { first: 'Aaliyah',  last: 'Johnson',   grade: '11th', technique: 'Contemporary, Tap'      },
      { first: 'Ethan',    last: 'Nguyen',    grade: '10th', technique: 'Ballet, Hip Hop'        },
      { first: 'Zoe',      last: 'Davis',     grade: '12th', technique: 'Jazz, Ballet'           },
      { first: 'Liam',     last: 'Brown',     grade: '9th',  technique: 'Modern, Contemporary'   },
      { first: 'Amara',    last: 'Wilson',    grade: '11th', technique: 'Ballet, Jazz'           },
      { first: 'Tyler',    last: 'Anderson',  grade: '10th', technique: 'Hip Hop, Modern'        },
      { first: 'Isabella', last: 'Garcia',    grade: '12th', technique: 'Contemporary, Ballet'   },
    ];

    let created = 0;
    for (let i = 0; i < mockDancers.length; i++) {
      const { first, last, grade, technique } = mockDancers[i];
      const email       = `mock-${i + 1}-s${seasonId}@trial.castsync.app`;
      const fakeHash    = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 8);
      const availability = JSON.stringify(mockAvailabilityPattern(i));

      const userResult = await pool.query(
        `INSERT INTO users (email, password_hash, role, email_verified, is_mock)
         VALUES ($1, $2, 'auditionee', TRUE, TRUE)
         ON CONFLICT (email) DO UPDATE SET is_mock = TRUE
         RETURNING id`,
        [email, fakeHash]
      );
      const userId = userResult.rows[0].id;

      await pool.query(
        `INSERT INTO dancer_profiles (user_id, first_name, last_name, grade, technique_classes, updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (user_id) DO UPDATE SET first_name=$2, last_name=$3, grade=$4, technique_classes=$5, updated_at=NOW()`,
        [userId, first, last, grade, technique]
      );

      // "M" prefix so a mock audition number never visually collides with a real one
      // (e.g. a real Audition #1 alongside a mock also showing "1").
      await pool.query(
        `INSERT INTO submissions (user_id, org_id, season_id, availability, audition_number)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id, season_id) DO NOTHING`,
        [userId, orgId, seasonId, availability, `M${i + 1}`]
      );
      created++;
    }
    res.json({ created, message: `${created} mock auditionees added to this production.` });
  } catch (err) {
    console.error('Seed mock error:', err.message);
    res.status(500).json({ error: 'Failed to seed mock auditionees.' });
  }
});

// DELETE /api/orgs/:orgId/seasons/:seasonId/mock-auditionees: fully remove this
// production's mock auditionees -- deletes the actual users rows (not just their
// submissions), which cascades dancer_profiles and submissions automatically. Unlike
// the per-row "Remove" button, this doesn't leave the underlying mock account behind.
app.delete('/api/orgs/:orgId/seasons/:seasonId/mock-auditionees', requireAuth('master'), async (req, res) => {
  const { orgId, seasonId } = req.params;
  try {
    const memberCheck = await pool.query(
      'SELECT id FROM org_members WHERE org_id = $1 AND user_id = $2',
      [orgId, req.session.userId]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member of this organization.' });

    const result = await pool.query(
      `DELETE FROM users WHERE email LIKE $1 AND is_mock = TRUE`,
      [`mock-%-s${seasonId}@trial.castsync.app`]
    );
    res.json({ removed: result.rowCount, message: `${result.rowCount} mock auditionees removed.` });
  } catch (err) {
    console.error('Clear mock error:', err.message);
    res.status(500).json({ error: 'Failed to remove mock auditionees.' });
  }
});

// POST /api/orgs/:orgId/seasons/:seasonId/seed-tour — create 5 mock dancers + 2 pieces + 3 blocks for the guided tour
app.post('/api/orgs/:orgId/seasons/:seasonId/seed-tour', requireAuth('master'), async (req, res) => {
  const { orgId, seasonId } = req.params;
  try {
    const memberCheck = await pool.query(
      'SELECT id FROM org_members WHERE org_id = $1 AND user_id = $2',
      [orgId, req.session.userId]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member.' });

    // Skip seeding if the production already has any content (real or demo)
    const existing = await pool.query(
      `SELECT (SELECT COUNT(*) FROM pieces WHERE season_id = $1) +
              (SELECT COUNT(*) FROM submissions WHERE season_id = $1) AS total`,
      [seasonId]
    );
    if (parseInt(existing.rows[0].total) > 0) return res.json({ alreadySeeded: true });

    const tourDancers = [
      { first: 'Jamie', last: 'Lee' }, { first: 'Alex', last: 'Kim' },
      { first: 'Sam',   last: 'Park'}, { first: 'Morgan', last: 'Chen' },
      { first: 'Riley', last: 'Nguyen' },
    ];
    const avail = JSON.stringify(
      ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
        .map(day => ({ day, startTime: '9:00 AM', endTime: '9:00 PM' }))
    );
    for (let i = 0; i < tourDancers.length; i++) {
      const { first, last } = tourDancers[i];
      const email    = `tour-${i + 1}-s${seasonId}@tour.castsync.app`;
      const fakeHash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 8);
      const ur = await pool.query(
        `INSERT INTO users (email, password_hash, role, email_verified, is_mock)
         VALUES ($1,$2,'auditionee',TRUE,TRUE) ON CONFLICT (email) DO UPDATE SET is_mock=TRUE RETURNING id`,
        [email, fakeHash]
      );
      const uid = ur.rows[0].id;
      await pool.query(
        `INSERT INTO dancer_profiles (user_id, first_name, last_name, updated_at)
         VALUES ($1,$2,$3,NOW()) ON CONFLICT (user_id) DO UPDATE SET first_name=$2, last_name=$3, updated_at=NOW()`,
        [uid, first, last]
      );
      await pool.query(
        `INSERT INTO submissions (user_id, org_id, season_id, availability, audition_number)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id, season_id) DO NOTHING`,
        [uid, orgId, seasonId, avail, String(i + 1)]
      );
    }

    const pA = await pool.query(
      `INSERT INTO pieces (name, color, season_id, master_id) VALUES ('Piece A','#e74c3c',$1,$2) RETURNING id`,
      [seasonId, req.session.userId]
    );
    const pB = await pool.query(
      `INSERT INTO pieces (name, color, season_id, master_id) VALUES ('Piece B','#3498db',$1,$2) RETURNING id`,
      [seasonId, req.session.userId]
    );
    const pidA = pA.rows[0].id, pidB = pB.rows[0].id;
    await pool.query(`INSERT INTO master_blocks (piece_id,day,start_time,end_time) VALUES ($1,'Monday','3:00 PM','5:00 PM')`,   [pidA]);
    await pool.query(`INSERT INTO master_blocks (piece_id,day,start_time,end_time) VALUES ($1,'Wednesday','3:00 PM','5:00 PM')`,[pidA]);
    await pool.query(`INSERT INTO master_blocks (piece_id,day,start_time,end_time) VALUES ($1,'Tuesday','4:00 PM','6:00 PM')`,  [pidB]);

    res.json({ seeded: true, pieceAId: pidA, pieceBId: pidB });
  } catch (err) {
    console.error('Seed tour error:', err.message);
    res.status(500).json({ error: 'Failed to seed tour data.' });
  }
});

// DELETE /api/orgs/:orgId/seasons/:seasonId/tour-cleanup — wipe all tour-seeded data
app.delete('/api/orgs/:orgId/seasons/:seasonId/tour-cleanup', requireAuth('master'), async (req, res) => {
  const { orgId, seasonId } = req.params;
  try {
    const memberCheck = await pool.query(
      'SELECT id FROM org_members WHERE org_id = $1 AND user_id = $2',
      [orgId, req.session.userId]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member.' });

    const { pieceIds } = req.body || {};
    if (pieceIds && pieceIds.length > 0) {
      await pool.query(
        `DELETE FROM pieces WHERE id = ANY($1::int[]) AND master_id = $2`,
        [pieceIds, req.session.userId]
      );
    } else {
      await pool.query(
        `DELETE FROM pieces WHERE season_id = $1 AND master_id = $2 AND name IN ('Piece A','Piece B')`,
        [seasonId, req.session.userId]
      );
    }
    await pool.query(
      `DELETE FROM submissions s USING users u
       WHERE s.user_id = u.id AND s.season_id = $1 AND u.email LIKE $2`,
      [seasonId, `tour-%-s${seasonId}@tour.castsync.app`]
    );
    res.json({ cleaned: true });
  } catch (err) {
    console.error('Tour cleanup error:', err.message);
    res.status(500).json({ error: 'Cleanup failed.' });
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
              dp.technique_classes, dp.secondary_email, sub.injuries, sub.absences, sub.availability, sub.audition_number,
              sub.custom_responses
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

// PATCH /api/dancers/:userId/audition-number — director updates a dancer's audition number
app.patch('/api/dancers/:userId/audition-number', requireAuth('master'), async (req, res) => {
  const { orgId, seasonId } = req.session;
  if (!orgId || !seasonId) return res.status(400).json({ error: 'No active org/season.' });
  const { audition_number } = req.body;
  try {
    const result = await pool.query(
      `UPDATE submissions SET audition_number=$1
       WHERE user_id=$2 AND org_id=$3 AND season_id=$4 RETURNING audition_number`,
      [audition_number || null, req.params.userId, orgId, seasonId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Submission not found.' });
    res.json({ audition_number: result.rows[0].audition_number });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update audition number.' });
  }
});

// GET /api/dancers/:userId/pieces — all pieces a dancer is cast in across the org
app.get('/api/dancers/:userId/pieces', requireAuth('master'), async (req, res) => {
  const { orgId, seasonId } = req.session;
  if (!orgId) return res.status(400).json({ error: 'No active org.' });
  try {
    const result = await pool.query(
      `SELECT p.id, p.name, p.color, s.name AS season_name, s.id AS season_id,
              pc.cast_role, pc.role_name,
              (s.id = $2) AS is_current_season
       FROM piece_casts pc
       JOIN pieces p ON p.id = pc.piece_id
       JOIN seasons s ON s.id = p.season_id
       WHERE pc.user_id = $1 AND s.org_id = $3
         AND (s.status IS NULL OR s.status = 'active')
       ORDER BY (s.id = $2) DESC, s.name ASC, p.name ASC`,
      [req.params.userId, seasonId || 0, orgId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to fetch dancer pieces.' });
  }
});

// ── Pieces routes (season-scoped) ─────────────────────────────────────────────

app.get('/api/pieces', requireAuth('master'), async (req, res) => {
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  try {
    const result = await pool.query(
      `SELECT p.id, p.name, p.color, p.choreographer_name, p.choreographer_email, p.room,
              COALESCE(json_agg(DISTINCT jsonb_build_object('day',mb.day,'start_time',mb.start_time,'end_time',mb.end_time,'room_id',mb.room_id,'room_name',r.name))
                FILTER (WHERE mb.id IS NOT NULL), '[]') AS blocks
       FROM pieces p
       LEFT JOIN master_blocks mb ON mb.piece_id = p.id
       LEFT JOIN rooms r ON r.id = mb.room_id
       WHERE p.season_id = $1
       GROUP BY p.id
       ORDER BY p.created_at ASC`,
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
  const { choreographer_name, choreographer_email, room, name } = req.body;
  if (name !== undefined && !name.trim()) return res.status(400).json({ error: 'Piece name cannot be empty.' });

  // Only touch fields actually present in the request, distinguishing "not sent"
  // (leave alone, e.g. the rename button only sends `name`) from "sent as empty
  // string" (clear it, e.g. casting.html's choreographer auto-save on blur).
  const sets = [];
  const values = [];
  if (choreographer_name !== undefined)  { sets.push(`choreographer_name = $${sets.length + 1}`);  values.push(choreographer_name || null); }
  if (choreographer_email !== undefined) { sets.push(`choreographer_email = $${sets.length + 1}`); values.push(choreographer_email || null); }
  if (room !== undefined)                { sets.push(`room = $${sets.length + 1}`);                values.push(room || null); }
  if (name !== undefined)                { sets.push(`name = $${sets.length + 1}`);                values.push(name.trim()); }
  if (sets.length === 0) return res.status(400).json({ error: 'No fields to update.' });

  try {
    const result = await pool.query(
      `UPDATE pieces SET ${sets.join(', ')} WHERE id=$${values.length + 1} AND master_id=$${values.length + 2} RETURNING id, name`,
      [...values, req.params.id, req.session.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Piece not found.' });
    res.json({ message: 'Updated.', name: result.rows[0].name });
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
      `SELECT mb.id, mb.piece_id, mb.day, mb.start_time, mb.end_time, mb.room_id
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
  const { piece_id, day, start_time, end_time, room_id } = req.body;
  if (!piece_id || !day || !start_time || !end_time)
    return res.status(400).json({ error: 'All fields required.' });
  try {
    const result = await pool.query(
      'INSERT INTO master_blocks (piece_id, day, start_time, end_time, room_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [piece_id, day, start_time, end_time, room_id || null]
    );
    res.status(201).json({ id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save block.' });
  }
});

// Partial update: omit a field to leave it untouched (same convention as PATCH
// /api/season/production-dates) -- needed so a room-only edit from the schedule's
// delete/move menu doesn't null out day/start_time/end_time, and vice versa for the
// drag-resize flow which never sends room_id.
app.put('/api/master-blocks/:id', requireAuth('master'), async (req, res) => {
  const { day, start_time, end_time, room_id } = req.body;
  const sets = [];
  const values = [];
  if (day !== undefined)        { sets.push(`day = $${sets.length + 1}`);        values.push(day); }
  if (start_time !== undefined) { sets.push(`start_time = $${sets.length + 1}`);  values.push(start_time); }
  if (end_time !== undefined)   { sets.push(`end_time = $${sets.length + 1}`);    values.push(end_time); }
  if (room_id !== undefined)    { sets.push(`room_id = $${sets.length + 1}`);     values.push(room_id || null); }
  if (sets.length === 0) return res.status(400).json({ error: 'No fields to update.' });
  try {
    await pool.query(`UPDATE master_blocks SET ${sets.join(', ')} WHERE id = $${values.length + 1}`, [...values, req.params.id]);
    res.json({ message: 'Block updated.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update block.' });
  }
});

app.delete('/api/master-blocks/all', requireAuth('master'), async (req, res) => {
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  try {
    // Delete in dependency order: casts → blocks → pieces → placeholders
    await pool.query('DELETE FROM piece_casts  WHERE piece_id IN (SELECT id FROM pieces WHERE season_id=$1)', [seasonId]);
    await pool.query('DELETE FROM master_blocks WHERE piece_id IN (SELECT id FROM pieces WHERE season_id=$1)', [seasonId]);
    await pool.query('DELETE FROM pieces        WHERE season_id=$1', [seasonId]);
    await pool.query('DELETE FROM schedule_placeholders WHERE season_id=$1', [seasonId]);
    res.json({ message: 'Season board cleared.' });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to clear board.' });
  }
});

app.delete('/api/master-blocks/:id', requireAuth('master'), async (req, res) => {
  try {
    // A block with recorded exceptions (cancelled/moved dates) carries history a director
    // may not realize they're about to lose; block the delete and name the count rather
    // than cascading it away silently.
    const exceptionCheck = await pool.query(
      'SELECT COUNT(*) FROM master_block_exceptions WHERE master_block_id = $1',
      [req.params.id]
    );
    const exceptionCount = parseInt(exceptionCheck.rows[0].count);
    if (exceptionCount > 0) {
      return res.status(409).json({ error: `This rehearsal has ${exceptionCount} recorded schedule change${exceptionCount === 1 ? '' : 's'}. Remove ${exceptionCount === 1 ? 'it' : 'those'} first.` });
    }
    await pool.query('DELETE FROM master_blocks WHERE id = $1', [req.params.id]);
    res.json({ message: 'Block deleted.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete block.' });
  }
});

// GET /api/master-blocks/occurrences?start=YYYY-MM-DD&end=YYYY-MM-DD: dated rehearsal
// occurrences for a range, generated from the weekly template (master_blocks) with any
// master_block_exceptions applied on top. The template stays the only thing directors
// edit; this is a read-only computed view. Works for any range regardless of whether the
// production's own start_date/end_date are set; the production date range is a frontend
// navigation constraint, not a backend one.
app.get('/api/master-blocks/occurrences', requireAuth('master'), async (req, res) => {
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  const { start, end } = req.query;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '')) {
    return res.status(400).json({ error: 'start and end must be YYYY-MM-DD dates.' });
  }
  if (end < start) return res.status(400).json({ error: 'end must not be before start.' });
  // Sanity guard against a malformed query param requesting an enormous range, not a real
  // product constraint (generateOccurrences itself has no inherent range limit).
  if ((new Date(`${end}T00:00:00`) - new Date(`${start}T00:00:00`)) / 86400000 > 120) {
    return res.status(400).json({ error: 'Range cannot exceed 120 days.' });
  }
  try {
    const occurrences = await generateOccurrences(seasonId, start, end);
    res.json(occurrences);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to generate occurrences.' });
  }
});

// POST /api/master-blocks/:id/exceptions: cancel or move a single dated occurrence of an
// existing template block. Idempotent (ON CONFLICT...DO UPDATE) since there's no UI for
// this yet and re-running the same call during testing/iteration should just update, not 409.
app.post('/api/master-blocks/:id/exceptions', requireAuth('master'), async (req, res) => {
  const { seasonId, orgId, userId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  const { original_date, type, new_date, new_start_time, new_end_time, note, room_id } = req.body;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(original_date || '')) return res.status(400).json({ error: 'original_date must be a YYYY-MM-DD date.' });
  if (!['cancelled', 'moved'].includes(type)) return res.status(400).json({ error: "type must be 'cancelled' or 'moved'." });
  if (type === 'moved' && (!new_date || !new_start_time || !new_end_time)) {
    return res.status(400).json({ error: "type 'moved' requires new_date, new_start_time, and new_end_time." });
  }
  try {
    const blockCheck = await pool.query(
      `SELECT mb.piece_id, mb.start_time, mb.end_time, p.name AS piece_name, s.name AS season_name, o.name AS org_name, s.start_date, s.end_date
       FROM master_blocks mb JOIN pieces p ON p.id = mb.piece_id
       JOIN seasons s ON s.id = p.season_id JOIN orgs o ON o.id = s.org_id
       WHERE mb.id = $1 AND p.season_id = $2`,
      [req.params.id, seasonId]
    );
    if (blockCheck.rows.length === 0) return res.status(404).json({ error: 'Block not found in your active season.' });
    const { piece_id: pieceId, piece_name: pieceName, season_name: seasonName, org_name: orgName, start_time: usualStart, end_time: usualEnd, start_date, end_date } = blockCheck.rows[0];
    // Same reasoning as one-time rehearsals: a single-date cancel/move only ever becomes
    // visible again on Master Schedule once a week containing its date is being viewed,
    // which requires production start/end dates. The UI already hides these options
    // without dates set; this is the matching server-side guard.
    if (!start_date || !end_date) {
      return res.status(400).json({ error: "Set your production's start and end dates in Production Settings before changing a single date." });
    }
    const result = await pool.query(
      `INSERT INTO master_block_exceptions (season_id, piece_id, master_block_id, original_date, type, new_date, new_start_time, new_end_time, note, created_by, room_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (master_block_id, original_date) DO UPDATE SET
         type = EXCLUDED.type, new_date = EXCLUDED.new_date, new_start_time = EXCLUDED.new_start_time,
         new_end_time = EXCLUDED.new_end_time, note = EXCLUDED.note, created_by = EXCLUDED.created_by, room_id = EXCLUDED.room_id
       RETURNING id`,
      [seasonId, pieceId, req.params.id, original_date, type, new_date || null, new_start_time || null, new_end_time || null, note || null, userId, room_id || null]
    );

    const niceOriginal = formatDateLong(original_date);
    if (type === 'cancelled') {
      notifyPieceScheduleChange(pieceId, orgId, seasonId,
        `Rehearsal Cancelled: ${pieceName} on ${niceOriginal}`,
        scheduleChangeEmailHTML(orgName, seasonName, pieceName,
          `<strong>${pieceName}</strong>'s rehearsal on <strong>${niceOriginal}</strong> (${usualStart} &ndash; ${usualEnd}) has been cancelled. This is a one-time change; the regular weekly schedule is not affected.`)
      );
    } else {
      const niceNew = formatDateLong(new_date);
      notifyPieceScheduleChange(pieceId, orgId, seasonId,
        `Rehearsal Moved: ${pieceName}`,
        scheduleChangeEmailHTML(orgName, seasonName, pieceName,
          `<strong>${pieceName}</strong>'s rehearsal usually on <strong>${niceOriginal}</strong> has been moved to <strong>${niceNew}</strong>, ${new_start_time} &ndash; ${new_end_time}, for this week only. The regular weekly schedule is not affected.`)
      );
    }

    res.status(201).json({ id: result.rows[0].id });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to save schedule exception.' });
  }
});

// POST /api/pieces/:pieceId/one-time-rehearsals: add a one-time rehearsal with no weekly
// template tie at all (master_block_id stays NULL).
app.post('/api/pieces/:pieceId/one-time-rehearsals', requireAuth('master'), async (req, res) => {
  const { seasonId, orgId, userId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  const { date, start_time, end_time, note, room_id } = req.body;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'date must be a YYYY-MM-DD date.' });
  if (!start_time || !end_time) return res.status(400).json({ error: 'start_time and end_time are required.' });
  try {
    const pieceCheck = await pool.query(
      `SELECT p.id, p.name AS piece_name, s.name AS season_name, o.name AS org_name, s.start_date, s.end_date
       FROM pieces p JOIN seasons s ON s.id = p.season_id JOIN orgs o ON o.id = s.org_id
       WHERE p.id = $1 AND p.season_id = $2`,
      [req.params.pieceId, seasonId]
    );
    if (pieceCheck.rows.length === 0) return res.status(404).json({ error: 'Piece not found in your active season.' });
    const { piece_name: pieceName, season_name: seasonName, org_name: orgName, start_date, end_date } = pieceCheck.rows[0];
    // A one-time rehearsal only ever becomes visible again on Master Schedule once a
    // week containing its date is actually being viewed, which requires the production's
    // start/end dates to be set -- without them, this would create an exception with no
    // way to see or manage it afterward.
    if (!start_date || !end_date) {
      return res.status(400).json({ error: "Set your production's start and end dates in Production Settings before adding a one-time rehearsal." });
    }
    const result = await pool.query(
      `INSERT INTO master_block_exceptions (season_id, piece_id, master_block_id, original_date, type, new_date, new_start_time, new_end_time, note, created_by, room_id)
       VALUES ($1,$2,NULL,$3,'added',$3,$4,$5,$6,$7,$8) RETURNING id`,
      [seasonId, req.params.pieceId, date, start_time, end_time, note || null, userId, room_id || null]
    );

    const niceDate = formatDateLong(date);
    notifyPieceScheduleChange(req.params.pieceId, orgId, seasonId,
      `New One-Time Rehearsal: ${pieceName} on ${niceDate}`,
      scheduleChangeEmailHTML(orgName, seasonName, pieceName,
        `A one-time rehearsal has been added for <strong>${pieceName}</strong> on <strong>${niceDate}</strong>, ${start_time} &ndash; ${end_time}.${note ? ` Note: ${note}` : ''}`)
    );

    res.status(201).json({ id: result.rows[0].id });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to save one-time rehearsal.' });
  }
});

// DELETE /api/master-blocks/exceptions/:exceptionId: remove an exception (a cancelled or
// moved date reverts to template behavior; a one-time addition is removed outright).
app.delete('/api/master-blocks/exceptions/:exceptionId', requireAuth('master'), async (req, res) => {
  const { seasonId, orgId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  try {
    // Fetch the exception before deleting it -- the notification content depends on
    // what kind of change is being undone, and that information disappears once the
    // row is gone.
    const excRow = await pool.query(
      `SELECT mbe.id, mbe.type, mbe.piece_id, mbe.new_start_time, mbe.new_end_time,
              to_char(mbe.original_date, 'YYYY-MM-DD') AS original_date,
              to_char(mbe.new_date, 'YYYY-MM-DD') AS new_date,
              p.name AS piece_name, s.name AS season_name, o.name AS org_name
       FROM master_block_exceptions mbe
       JOIN pieces p ON p.id = mbe.piece_id
       JOIN seasons s ON s.id = mbe.season_id JOIN orgs o ON o.id = s.org_id
       WHERE mbe.id = $1 AND mbe.season_id = $2`,
      [req.params.exceptionId, seasonId]
    );
    if (excRow.rows.length === 0) return res.status(404).json({ error: 'Exception not found in your active season.' });
    const exc = excRow.rows[0];

    await pool.query('DELETE FROM master_block_exceptions WHERE id = $1', [req.params.exceptionId]);

    const niceOriginal = formatDateLong(exc.original_date);
    let subject, bodyHtml;
    if (exc.type === 'cancelled') {
      subject = `Rehearsal Restored: ${exc.piece_name} on ${niceOriginal}`;
      bodyHtml = `Good news: <strong>${exc.piece_name}</strong>'s rehearsal on <strong>${niceOriginal}</strong> is back on as scheduled.`;
    } else if (exc.type === 'moved') {
      subject = `Rehearsal Schedule Restored: ${exc.piece_name}`;
      bodyHtml = `<strong>${exc.piece_name}</strong>'s rehearsal on <strong>${niceOriginal}</strong> is back to its usual time. The move to <strong>${formatDateLong(exc.new_date)}</strong> has been cancelled.`;
    } else {
      subject = `One-Time Rehearsal Removed: ${exc.piece_name}`;
      bodyHtml = `The one-time rehearsal for <strong>${exc.piece_name}</strong> on <strong>${niceOriginal}</strong> has been removed.`;
    }
    notifyPieceScheduleChange(exc.piece_id, orgId, seasonId, subject, scheduleChangeEmailHTML(exc.org_name, exc.season_name, exc.piece_name, bodyHtml));

    res.json({ message: 'Exception removed.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove exception.' });
  }
});

// GET /api/orgs/:orgId/master-schedule — all blocks from ALL active productions in this org
// Used by the org-level print view. Requires org membership.
app.get('/api/orgs/:orgId/master-schedule', requireAuth('master'), async (req, res) => {
  try {
    const check = await pool.query(
      'SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2',
      [req.params.orgId, req.session.userId]
    );
    if (check.rows.length === 0) return res.status(403).json({ error: 'Not a member of this org.' });

    const result = await pool.query(
      `SELECT mb.id, mb.day, mb.start_time, mb.end_time,
              p.name AS piece_name, p.color AS piece_color,
              s.name AS season_name, s.id AS season_id
       FROM master_blocks mb
       JOIN pieces p ON p.id = mb.piece_id
       JOIN seasons s ON s.id = p.season_id
       WHERE s.org_id = $1 AND (s.status IS NULL OR s.status = 'active')
       ORDER BY s.name ASC, p.name ASC, mb.day ASC, mb.start_time ASC`,
      [req.params.orgId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to fetch org master schedule.' });
  }
});

// GET /api/master-blocks/org — read-only blocks from OTHER active productions in same org
// Org owners always see them; co-directors see them only if can_see_other_blocks = TRUE
app.get('/api/master-blocks/org', requireAuth('master'), async (req, res) => {
  const { orgId, seasonId } = req.session;
  if (!orgId || !seasonId) return res.status(400).json({ error: 'No active org/season.' });
  try {
    // Check if the user is an org-level member (owner / co-director at org level)
    const orgMember = await pool.query(
      'SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2',
      [orgId, req.session.userId]
    );
    if (orgMember.rows.length === 0) {
      // Production-level co-director — only show if permission granted
      const canSee = await pool.query(
        'SELECT can_see_other_blocks FROM season_members WHERE season_id = $1 AND user_id = $2',
        [seasonId, req.session.userId]
      );
      if (!canSee.rows[0]?.can_see_other_blocks) return res.json([]);
    }

    const result = await pool.query(
      `SELECT mb.id, mb.day, mb.start_time, mb.end_time,
              p.name AS piece_name, p.color AS piece_color,
              s.name AS season_name, s.id AS season_id
       FROM master_blocks mb
       JOIN pieces p ON p.id = mb.piece_id
       JOIN seasons s ON s.id = p.season_id
       WHERE s.org_id = $1 AND s.id != $2
         AND (s.status IS NULL OR s.status = 'active')
       ORDER BY s.name ASC, mb.day ASC, mb.start_time ASC`,
      [orgId, seasonId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to fetch org blocks.' });
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
    const returnUrl  = `${baseUrl2}/billing.html`;
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

// GET /api/season/join-code: the active production's join code, for display/copy on
// Production Settings (not carried in the session like orgName/seasonName -- this is a
// rarely-needed lookup, not worth touching every place the session gets built).
app.get('/api/season/join-code', requireAuth('master'), async (req, res) => {
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  try {
    const result = await pool.query('SELECT join_code FROM seasons WHERE id = $1', [seasonId]);
    res.json({ join_code: result.rows[0]?.join_code || null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch join code.' });
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

// ── Named rooms ───────────────────────────────────────────────────────────────
// Separate from room_count above: a season with zero rooms here keeps the old
// anonymous lane-count conflict behavior; once a room exists, the UI and conflict
// detection switch to room-aware mode. See highlightConflicts() in master-schedule.js.

// GET /api/season/rooms: list named rooms for the active season
app.get('/api/season/rooms', requireAuth('master'), async (req, res) => {
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  try {
    const result = await pool.query('SELECT id, name FROM rooms WHERE season_id = $1 ORDER BY name ASC', [seasonId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch rooms.' });
  }
});

// POST /api/season/rooms: create a named room
app.post('/api/season/rooms', requireAuth('master'), async (req, res) => {
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Room name is required.' });
  try {
    const result = await pool.query(
      'INSERT INTO rooms (season_id, name) VALUES ($1, $2) RETURNING id, name',
      [seasonId, name]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create room.' });
  }
});

// PATCH /api/season/rooms/:id: rename a room
app.patch('/api/season/rooms/:id', requireAuth('master'), async (req, res) => {
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Room name is required.' });
  try {
    const result = await pool.query(
      'UPDATE rooms SET name = $1 WHERE id = $2 AND season_id = $3 RETURNING id, name',
      [name, req.params.id, seasonId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Room not found in your active season.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to rename room.' });
  }
});

// DELETE /api/season/rooms/:id: blocked if anything still references it, same
// "don't silently lose history" guard pattern as deleting a master_block with
// recorded exceptions.
app.delete('/api/season/rooms/:id', requireAuth('master'), async (req, res) => {
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  try {
    const roomCheck = await pool.query('SELECT id FROM rooms WHERE id = $1 AND season_id = $2', [req.params.id, seasonId]);
    if (roomCheck.rows.length === 0) return res.status(404).json({ error: 'Room not found in your active season.' });

    const [blocks, exceptions, placeholders] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM master_blocks WHERE room_id = $1', [req.params.id]),
      pool.query('SELECT COUNT(*) FROM master_block_exceptions WHERE room_id = $1', [req.params.id]),
      pool.query('SELECT COUNT(*) FROM schedule_placeholders WHERE room_id = $1', [req.params.id]),
    ]);
    const total = parseInt(blocks.rows[0].count) + parseInt(exceptions.rows[0].count) + parseInt(placeholders.rows[0].count);
    if (total > 0) {
      return res.status(409).json({ error: `${total} schedule item${total === 1 ? '' : 's'} still use this room. Reassign or remove ${total === 1 ? 'it' : 'them'} first.` });
    }
    await pool.query('DELETE FROM rooms WHERE id = $1', [req.params.id]);
    res.json({ message: 'Room deleted.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete room.' });
  }
});

// GET /api/season/availability-mode: return current production's availability collection mode
app.get('/api/season/availability-mode', requireAuth('master'), async (req, res) => {
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  try {
    const result = await pool.query('SELECT availability_mode FROM seasons WHERE id = $1', [seasonId]);
    res.json({ availability_mode: result.rows[0]?.availability_mode || 'grid' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch availability mode.' });
  }
});

// PATCH /api/season/availability-mode: director switches between simple grid and detailed schedule
app.patch('/api/season/availability-mode', requireAuth('master'), async (req, res) => {
  const { availability_mode } = req.body;
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  if (!['grid', 'detailed'].includes(availability_mode)) return res.status(400).json({ error: 'availability_mode must be grid or detailed.' });
  try {
    await pool.query('UPDATE seasons SET availability_mode = $1 WHERE id = $2', [availability_mode, seasonId]);
    res.json({ availability_mode });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update availability mode.' });
  }
});

// GET /api/season/production-dates: return current production's date-range fields
app.get('/api/season/production-dates', requireAuth('master'), async (req, res) => {
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  try {
    const result = await pool.query(
      `SELECT to_char(start_date, 'YYYY-MM-DD') AS start_date,
              to_char(end_date, 'YYYY-MM-DD') AS end_date,
              to_char(audition_date, 'YYYY-MM-DD') AS audition_date,
              my_schedule_enabled
       FROM seasons WHERE id = $1`,
      [seasonId]
    );
    res.json(result.rows[0] || { start_date: null, end_date: null, audition_date: null, my_schedule_enabled: false });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch production dates.' });
  }
});

// PATCH /api/season/production-dates: director sets/clears any subset of start/end/audition
// date. Performance dates moved to their own endpoints below (GET/POST/DELETE
// /api/season/performance-dates) since a production can now have more than one.
app.patch('/api/season/production-dates', requireAuth('master'), async (req, res) => {
  const { start_date, end_date, audition_date } = req.body;
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });

  const isValidDate = v => v === null || v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v);
  for (const [label, v] of Object.entries({ start_date, end_date, audition_date })) {
    if (v !== undefined && !isValidDate(v)) return res.status(400).json({ error: `${label} must be a YYYY-MM-DD date or empty.` });
  }
  if (start_date && end_date && end_date < start_date) {
    return res.status(400).json({ error: 'Production end date cannot be before the start date.' });
  }

  // Same "only touch fields actually present" convention as PATCH /api/pieces/:id:
  // omit a key to leave it alone, send '' to clear it.
  const sets = [];
  const values = [];
  for (const [col, v] of Object.entries({ start_date, end_date, audition_date })) {
    if (v !== undefined) { sets.push(`${col} = $${sets.length + 1}`); values.push(v || null); }
  }
  if (sets.length === 0) return res.status(400).json({ error: 'No fields to update.' });

  try {
    await pool.query(`UPDATE seasons SET ${sets.join(', ')} WHERE id = $${values.length + 1}`, [...values, seasonId]);
    res.json({ message: 'Production dates updated.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update production dates.' });
  }
});

// ── Performance dates (a production can have more than one show night) ────────

// GET /api/season/performance-dates: list performance dates for the active season
app.get('/api/season/performance-dates', requireAuth('master'), async (req, res) => {
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  try {
    const result = await pool.query(
      `SELECT id, to_char(date, 'YYYY-MM-DD') AS date FROM performance_dates WHERE season_id = $1 ORDER BY date ASC`,
      [seasonId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch performance dates.' });
  }
});

// POST /api/season/performance-dates: add a performance date
app.post('/api/season/performance-dates', requireAuth('master'), async (req, res) => {
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  const { date } = req.body;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'date must be a YYYY-MM-DD date.' });
  try {
    const result = await pool.query(
      `INSERT INTO performance_dates (season_id, date) VALUES ($1, $2)
       ON CONFLICT (season_id, date) DO NOTHING RETURNING id, to_char(date, 'YYYY-MM-DD') AS date`,
      [seasonId, date]
    );
    if (result.rows.length === 0) return res.status(400).json({ error: 'That date is already on the list.' });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to add performance date.' });
  }
});

// DELETE /api/season/performance-dates/:id
app.delete('/api/season/performance-dates/:id', requireAuth('master'), async (req, res) => {
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  try {
    const result = await pool.query(
      'DELETE FROM performance_dates WHERE id = $1 AND season_id = $2',
      [req.params.id, seasonId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Performance date not found in your active season.' });
    res.json({ message: 'Performance date removed.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove performance date.' });
  }
});

// GET /api/season/form-schema — return current production's audition form schema
app.get('/api/season/form-schema', requireAuth('master'), async (req, res) => {
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  try {
    const result = await pool.query('SELECT form_schema FROM seasons WHERE id = $1', [seasonId]);
    res.json({ form_schema: result.rows[0]?.form_schema || [] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch form schema.' });
  }
});

// PATCH /api/season/form-schema — director customizes this production's form only
app.patch('/api/season/form-schema', requireAuth('master'), async (req, res) => {
  const { form_schema } = req.body;
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  if (!Array.isArray(form_schema)) return res.status(400).json({ error: 'form_schema must be an array.' });
  try {
    await pool.query('UPDATE seasons SET form_schema = $1 WHERE id = $2', [JSON.stringify(form_schema), seasonId]);
    res.json({ form_schema });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update form schema.' });
  }
});

// ── Production Notes ──────────────────────────────────────────────────────────
// Internal faculty notes (absences, injuries, attendance, casting, general). Scoped
// to the active season; never exposed to any auditionee-facing route.

const NOTE_CATEGORIES = ['absence', 'injury', 'attendance', 'casting', 'general'];

// GET /api/season/production-notes, newest first
app.get('/api/season/production-notes', requireAuth('master'), async (req, res) => {
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  try {
    const result = await pool.query(
      `SELECT pn.id, pn.note_text, pn.category, pn.created_at,
              u.email AS author_email,
              dp.first_name AS dancer_first_name, dp.last_name AS dancer_last_name,
              COALESCE(
                json_agg(DISTINCT p.name) FILTER (WHERE p.id IS NOT NULL), '[]'
              ) AS piece_names
       FROM production_notes pn
       LEFT JOIN users u ON u.id = pn.author_user_id
       LEFT JOIN dancer_profiles dp ON dp.user_id = pn.dancer_user_id
       LEFT JOIN production_note_pieces pnp ON pnp.note_id = pn.id
       LEFT JOIN pieces p ON p.id = pnp.piece_id
       WHERE pn.season_id = $1
       GROUP BY pn.id, u.email, dp.first_name, dp.last_name
       ORDER BY pn.created_at DESC`,
      [seasonId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to load notes.' });
  }
});

// GET /api/season/faculty: co-directors + piece choreographers, for the notify picker
app.get('/api/season/faculty', requireAuth('master'), async (req, res) => {
  const { orgId, seasonId } = req.session;
  if (!orgId || !seasonId) return res.status(400).json({ error: 'No active org/season.' });
  try {
    const [orgMembers, seasonMembers, choreographers] = await Promise.all([
      pool.query(`SELECT DISTINCT u.email FROM org_members om JOIN users u ON u.id = om.user_id WHERE om.org_id = $1`, [orgId]),
      pool.query(`SELECT DISTINCT u.email FROM season_members sm JOIN users u ON u.id = sm.user_id WHERE sm.season_id = $1`, [seasonId]),
      pool.query(`SELECT DISTINCT choreographer_email AS email, name AS piece_name FROM pieces WHERE season_id = $1 AND choreographer_email IS NOT NULL AND choreographer_email != ''`, [seasonId]),
    ]);
    const seen = new Map();
    orgMembers.rows.forEach(r => seen.set(r.email, { email: r.email, label: r.email }));
    seasonMembers.rows.forEach(r => seen.set(r.email, { email: r.email, label: r.email }));
    choreographers.rows.forEach(r => {
      if (!seen.has(r.email)) seen.set(r.email, { email: r.email, label: `${r.email} (${r.piece_name} choreographer)` });
    });
    res.json([...seen.values()]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to load faculty list.' });
  }
});

// GET /api/season/faculty-directory: structured director/co-director/choreographer
// roster for the Faculty page (distinct from /api/season/faculty above, which feeds
// notes.html's flat notify-picker and shouldn't be reshaped out from under it).
app.get('/api/season/faculty-directory', requireAuth('master'), async (req, res) => {
  const { orgId, seasonId } = req.session;
  if (!orgId || !seasonId) return res.status(400).json({ error: 'No active org/season.' });
  try {
    const [orgOwner, seasonMembers, choreographerRows] = await Promise.all([
      pool.query(
        `SELECT u.email, om.role FROM org_members om JOIN users u ON u.id = om.user_id
         WHERE om.org_id = $1 AND om.role = 'owner'`,
        [orgId]
      ),
      pool.query(
        `SELECT u.email, sm.role, sm.can_see_other_blocks FROM season_members sm JOIN users u ON u.id = sm.user_id
         WHERE sm.season_id = $1`,
        [seasonId]
      ),
      pool.query(
        `SELECT p.choreographer_email AS email, p.choreographer_name AS name,
                p.id AS piece_id, p.name AS piece_name,
                mb.day, mb.start_time, mb.end_time
         FROM pieces p LEFT JOIN master_blocks mb ON mb.piece_id = p.id
         WHERE p.season_id = $1 AND p.choreographer_email IS NOT NULL AND p.choreographer_email != ''
         ORDER BY p.choreographer_email, p.name, mb.day, mb.start_time`,
        [seasonId]
      ),
    ]);

    const directors = [...orgOwner.rows, ...seasonMembers.rows];

    const choreographers = new Map();
    choreographerRows.rows.forEach(r => {
      if (!choreographers.has(r.email)) choreographers.set(r.email, { email: r.email, name: r.name, pieces: new Map() });
      const choreographer = choreographers.get(r.email);
      if (!choreographer.pieces.has(r.piece_id)) choreographer.pieces.set(r.piece_id, { id: r.piece_id, name: r.piece_name, blocks: [] });
      if (r.day) choreographer.pieces.get(r.piece_id).blocks.push({ day: r.day, start_time: r.start_time, end_time: r.end_time });
    });

    res.json({
      directors,
      choreographers: [...choreographers.values()].map(c => ({ ...c, pieces: [...c.pieces.values()] })),
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to load faculty directory.' });
  }
});

// POST /api/season/production-notes
app.post('/api/season/production-notes', requireAuth('master'), async (req, res) => {
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  const { note_text, category, dancer_user_id, piece_ids, notify_emails } = req.body;
  if (!note_text || !note_text.trim()) return res.status(400).json({ error: 'Note text is required.' });
  const cat = NOTE_CATEGORIES.includes(category) ? category : 'general';
  try {
    const result = await pool.query(
      `INSERT INTO production_notes (season_id, author_user_id, note_text, category, dancer_user_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [seasonId, req.session.userId, note_text.trim(), cat, dancer_user_id || null]
    );
    const noteId = result.rows[0].id;

    if (Array.isArray(piece_ids) && piece_ids.length > 0) {
      await Promise.all(piece_ids.map(pid =>
        pool.query(
          `INSERT INTO production_note_pieces (note_id, piece_id)
           SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM pieces WHERE id = $2 AND season_id = $3)`,
          [noteId, pid, seasonId]
        )
      ));
    }

    if (emailEnabled && Array.isArray(notify_emails) && notify_emails.length > 0) {
      const orgRow = await pool.query(
        `SELECT o.name AS org_name FROM seasons s JOIN orgs o ON o.id = s.org_id WHERE s.id = $1`,
        [seasonId]
      );
      const orgName       = orgRow.rows[0]?.org_name || 'CastSync';
      const categoryLabel = cat.charAt(0).toUpperCase() + cat.slice(1);
      // notify_emails comes from notes.html's faculty picker as bare email strings (not
      // every recipient necessarily has an account -- a choreographer's email might be
      // on the list with nothing in `users` to match), so preference-resolution is a
      // best-effort lookup keyed by email, not a guaranteed userId per recipient.
      const recipientEmails = notify_emails.filter(Boolean);
      const userRows = await pool.query('SELECT id, email FROM users WHERE email = ANY($1)', [recipientEmails]);
      const userIdByEmail = new Map(userRows.rows.map(r => [r.email, r.id]));
      for (const to of recipientEmails) {
        if (!(await emailAllowed(userIdByEmail.get(to), 'production_notes'))) continue;
        resend.emails.send({
          from:    FROM_EMAIL,
          to,
          subject: `New Production Note (${categoryLabel}) for ${orgName}`,
          html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#222;">
            <h3 style="margin-bottom:4px;">New Production Note</h3>
            <p style="color:#555;font-size:13px;margin-top:0;">${categoryLabel} · ${orgName}</p>
            <p style="white-space:pre-wrap;border-left:3px solid #ddd;padding-left:12px;color:#333;">${note_text.trim()}</p>
            <p style="color:#aaa;font-size:12px;">Internal faculty note from CastSync. Not visible to auditionees.</p>
          </div>`,
        }).catch(err => console.error('Production note email error:', err.message));
      }
    }

    res.status(201).json({ id: noteId });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to save note.' });
  }
});

// DELETE /api/season/production-notes/:id (author only)
app.delete('/api/season/production-notes/:id', requireAuth('master'), async (req, res) => {
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  try {
    const result = await pool.query(
      `DELETE FROM production_notes WHERE id = $1 AND season_id = $2 AND author_user_id = $3 RETURNING id`,
      [req.params.id, seasonId, req.session.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Note not found, or you are not its author.' });
    res.json({ message: 'Deleted.' });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to delete note.' });
  }
});

// ── Attendance ─────────────────────────────────────────────────────────────────
// Tracks who showed up to rehearsal, by calendar date, scoped per piece: multiple
// pieces can rehearse the same day (even the same time, in different rooms), and a
// dancer's attendance can differ between them. Never exposed to auditionees.

const ATTENDANCE_STATUSES = ['none', 'injured', 'illness', 'other'];

// GET /api/season/attendance?date=YYYY-MM-DD&piece_id=123
app.get('/api/season/attendance', requireAuth('master'), async (req, res) => {
  const { seasonId } = req.session;
  const { date, piece_id } = req.query;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  if (!date || !piece_id) return res.status(400).json({ error: 'date and piece_id are required.' });
  try {
    const pieceCheck = await pool.query('SELECT id FROM pieces WHERE id = $1 AND season_id = $2', [piece_id, seasonId]);
    if (pieceCheck.rows.length === 0) return res.status(403).json({ error: 'Piece not in active season.' });

    const result = await pool.query(
      `SELECT u.id AS user_id, dp.first_name, dp.last_name, pc.cast_role,
              COALESCE(ar.present, TRUE) AS present,
              COALESCE(ar.status, 'none') AS status,
              ar.status_note
       FROM piece_casts pc
       JOIN users u ON u.id = pc.user_id
       JOIN dancer_profiles dp ON dp.user_id = u.id
       LEFT JOIN attendance_records ar ON ar.user_id = u.id AND ar.piece_id = $1 AND ar.rehearsal_date = $2
       WHERE pc.piece_id = $1
       ORDER BY dp.last_name, dp.first_name`,
      [piece_id, date]
    );

    // Context: every piece rehearsing on this date's day of week, with times, so
    // overlapping/simultaneous rehearsals in other rooms are visible at a glance.
    // Day-of-week only, since recurring weekly blocks aren't tied to specific dates.
    const dayOfWeek = new Date(`${date}T00:00:00`).toLocaleDateString('en-US', { weekday: 'long' });
    const piecesToday = await pool.query(
      `SELECT p.id, p.name, mb.start_time, mb.end_time FROM pieces p JOIN master_blocks mb ON mb.piece_id = p.id
       WHERE p.season_id = $1 AND mb.day = $2 ORDER BY mb.start_time, p.name`,
      [seasonId, dayOfWeek]
    );

    res.json({ date, day_of_week: dayOfWeek, pieces_today: piecesToday.rows, dancers: result.rows });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to load attendance.' });
  }
});

// GET /api/season/attendance/dates?piece_id=123: every date with a saved record for this piece, newest first
app.get('/api/season/attendance/dates', requireAuth('master'), async (req, res) => {
  const { seasonId } = req.session;
  const { piece_id } = req.query;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  if (!piece_id) return res.status(400).json({ error: 'piece_id is required.' });
  try {
    const result = await pool.query(
      `SELECT DISTINCT ar.rehearsal_date FROM attendance_records ar
       JOIN pieces p ON p.id = ar.piece_id
       WHERE ar.piece_id = $1 AND p.season_id = $2
       ORDER BY ar.rehearsal_date DESC LIMIT 30`,
      [piece_id, seasonId]
    );
    res.json(result.rows.map(r => r.rehearsal_date));
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to load dates.' });
  }
});

// POST /api/season/attendance: upsert one dancer's record for one piece/date
app.post('/api/season/attendance', requireAuth('master'), async (req, res) => {
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  const { date, piece_id, user_id, present, status, status_note } = req.body;
  if (!date || !piece_id || !user_id) return res.status(400).json({ error: 'date, piece_id, and user_id are required.' });
  const st = ATTENDANCE_STATUSES.includes(status) ? status : 'none';
  try {
    const pieceCheck = await pool.query('SELECT id FROM pieces WHERE id = $1 AND season_id = $2', [piece_id, seasonId]);
    if (pieceCheck.rows.length === 0) return res.status(403).json({ error: 'Piece not in active season.' });

    await pool.query(
      `INSERT INTO attendance_records (season_id, piece_id, user_id, rehearsal_date, present, status, status_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (piece_id, user_id, rehearsal_date)
       DO UPDATE SET present = $5, status = $6, status_note = $7, updated_at = NOW()`,
      [seasonId, piece_id, user_id, date, present !== false, st, status_note || null]
    );
    res.json({ message: 'Saved.' });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to save attendance.' });
  }
});

// ── Absence requests (director side) ────────────────────────────────────────────

// GET /api/season/absence-requests: every request for the active season, newest first
app.get('/api/season/absence-requests', requireAuth('master'), async (req, res) => {
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  try {
    const result = await pool.query(
      `SELECT ar.id, ar.absence_date, ar.start_time, ar.end_time, ar.reason, ar.status,
              ar.created_at, ar.piece_id, ar.documentation_link, dp.first_name, dp.last_name, p.name AS piece_name
       FROM absence_requests ar
       JOIN dancer_profiles dp ON dp.user_id = ar.user_id
       LEFT JOIN pieces p ON p.id = ar.piece_id
       WHERE ar.season_id = $1
       ORDER BY ar.created_at DESC`,
      [seasonId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to load absence requests.' });
  }
});

// PATCH /api/season/absence-requests/:id: update status and/or assign a piece (e.g. resolving a TBD)
app.patch('/api/season/absence-requests/:id', requireAuth('master'), async (req, res) => {
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  const { status, piece_id } = req.body;
  if (status !== undefined && !ABSENCE_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status.' });

  try {
    const existing = await pool.query(
      `SELECT ar.*, dp.first_name, dp.last_name, u.email, u.id AS user_id, s.name AS season_name, o.name AS org_name, o.id as org_id
       FROM absence_requests ar
       JOIN users u ON u.id = ar.user_id
       JOIN dancer_profiles dp ON dp.user_id = ar.user_id
       JOIN seasons s ON s.id = ar.season_id
       JOIN orgs o ON o.id = ar.org_id
       WHERE ar.id = $1 AND ar.season_id = $2`,
      [req.params.id, seasonId]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Request not found.' });
    const reqRow = existing.rows[0];

    let newPieceId = reqRow.piece_id;
    if (piece_id !== undefined) {
      if (piece_id === null) {
        newPieceId = null;
      } else {
        const pieceCheck = await pool.query('SELECT id FROM pieces WHERE id = $1 AND season_id = $2', [piece_id, seasonId]);
        if (pieceCheck.rows.length === 0) return res.status(400).json({ error: 'Piece not in this season.' });
        newPieceId = piece_id;
      }
    }
    const newStatus = status !== undefined ? status : reqRow.status;

    await pool.query(
      `UPDATE absence_requests SET status = $1, piece_id = $2, updated_at = NOW() WHERE id = $3`,
      [newStatus, newPieceId, req.params.id]
    );

    const dancerName = `${reqRow.first_name} ${reqRow.last_name}`;
    const pieceLabel = newPieceId
      ? (await pool.query('SELECT name FROM pieces WHERE id = $1', [newPieceId])).rows[0]?.name
      : 'TBD / not yet assigned';
    const statusLabel = ABSENCE_STATUS_LABELS[newStatus];

    if (emailEnabled && status !== undefined && await emailAllowed(reqRow.user_id, 'absence_requests')) {
      const dancerProfile = await pool.query('SELECT secondary_email FROM dancer_profiles WHERE user_id = $1', [reqRow.user_id]);
      const recipients = [reqRow.email, dancerProfile.rows[0]?.secondary_email].filter(Boolean);
      resend.emails.send({
        from: FROM_EMAIL,
        to: recipients,
        subject: `Your Absence Request Has Been Updated for ${reqRow.org_name}`,
        html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#222;">
          <h3 style="margin-bottom:4px;">Absence Request Update</h3>
          <p style="color:#555;font-size:13px;margin-top:0;">${reqRow.org_name}, ${reqRow.season_name}</p>
          <p>Your absence request for <strong>${reqRow.absence_date.toISOString().slice(0,10)}</strong>, ${reqRow.start_time} to ${reqRow.end_time} is now: <strong>${statusLabel}</strong>.</p>
          <p style="color:#555;font-size:13px;">Piece: ${pieceLabel}</p>
        </div>`,
      }).catch(err => console.error('Absence status-update email error:', err.message));

      if (newPieceId) {
        notifyChoreographerForPiece(newPieceId, `Absence Request Update for ${pieceLabel} in ${reqRow.org_name}`,
          `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#222;">
            <h3 style="margin-bottom:4px;">Absence Request Update</h3>
            <p style="color:#555;font-size:13px;margin-top:0;">${reqRow.org_name}, ${reqRow.season_name} · ${pieceLabel}</p>
            <p><strong>${dancerName}</strong>'s absence request for <strong>${reqRow.absence_date.toISOString().slice(0,10)}</strong>, ${reqRow.start_time} to ${reqRow.end_time} is now: <strong>${statusLabel}</strong>.</p>
          </div>`
        );
      }
    }

    res.json({ message: 'Updated.', status: newStatus, piece_id: newPieceId });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to update absence request.' });
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
              sub.audition_number, pc.cast_role AS existing_cast_role, pc.id AS cast_id,
              conflict.piece_name AS conflict_piece_name
       FROM submissions sub
       JOIN dancer_profiles dp ON dp.user_id = sub.user_id
       JOIN users u ON u.id = sub.user_id
       LEFT JOIN piece_casts pc ON pc.piece_id = $3 AND pc.user_id = u.id
       LEFT JOIN LATERAL (
         SELECT p.name AS piece_name
         FROM piece_casts pc2
         JOIN pieces p ON p.id = pc2.piece_id
         JOIN seasons s ON s.id = p.season_id
         WHERE pc2.user_id = u.id
           AND s.org_id = $1
           AND pc2.piece_id != $3
           AND (s.status IS NULL OR s.status = 'active')
           AND EXISTS (
             SELECT 1 FROM master_blocks mb_other
             WHERE mb_other.piece_id = pc2.piece_id
               AND EXISTS (
                 SELECT 1 FROM master_blocks mb_this
                 WHERE mb_this.piece_id = $3
                   AND mb_this.day = mb_other.day
                   AND time_to_minutes(mb_this.start_time) < time_to_minutes(mb_other.end_time)
                   AND time_to_minutes(mb_this.end_time)   > time_to_minutes(mb_other.start_time)
               )
           )
         LIMIT 1
       ) conflict ON true
       WHERE sub.org_id = $1 AND sub.season_id = $2 AND sub.availability IS NOT NULL`,
      [orgId, seasonId, req.params.pieceId]
    );

    const fully = [], partially = [];
    dancersResult.rows.forEach(dancer => {
      const avail = (dancer.availability || []).filter(isAvailableBlock);
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
        cast_id: dancer.cast_id || null,
        conflict_piece_name: dancer.conflict_piece_name || null,
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
      `SELECT pc.id, pc.piece_id, pc.user_id, pc.cast_role, pc.role_name,
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
  const { seasonId, orgId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  try {
    // Verify piece belongs to this season
    const pieceCheck = await pool.query('SELECT id FROM pieces WHERE id = $1 AND season_id = $2', [piece_id, seasonId]);
    if (pieceCheck.rows.length === 0) return res.status(403).json({ error: 'Piece not in active season.' });

    // Hard block: dancer already in any other piece with overlapping rehearsal blocks (same or other production)
    if (orgId) {
      const overlaps = await pool.query(
        `SELECT DISTINCT s.name AS season_name, p.name AS piece_name, dp.first_name, dp.last_name
         FROM piece_casts pc2
         JOIN pieces p ON p.id = pc2.piece_id
         JOIN seasons s ON s.id = p.season_id
         JOIN dancer_profiles dp ON dp.user_id = pc2.user_id
         WHERE pc2.user_id = $1
           AND s.org_id = $2
           AND pc2.piece_id != $3
           AND (s.status IS NULL OR s.status = 'active')
           AND EXISTS (
             SELECT 1 FROM master_blocks mb_other
             WHERE mb_other.piece_id = pc2.piece_id
               AND EXISTS (
                 SELECT 1 FROM master_blocks mb_this
                 WHERE mb_this.piece_id = $3
                   AND mb_this.day = mb_other.day
                   AND time_to_minutes(mb_this.start_time) < time_to_minutes(mb_other.end_time)
                   AND time_to_minutes(mb_this.end_time)   > time_to_minutes(mb_other.start_time)
               )
           )
         ORDER BY s.name, p.name`,
        [user_id, orgId, piece_id]
      );
      if (overlaps.rows.length > 0) {
        const dancerName   = `${overlaps.rows[0].first_name} ${overlaps.rows[0].last_name}`;
        const conflictList = overlaps.rows.map(r => `"${r.piece_name}"`).join(' and ');
        return res.status(409).json({
          error: `Error: ${dancerName} is already cast in ${conflictList} and cannot be double booked!`,
        });
      }
    }

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

// PATCH /api/piece-casts/:id — update role_name for a cast entry
app.patch('/api/piece-casts/:id', requireAuth('master'), async (req, res) => {
  const { role_name } = req.body;
  try {
    const result = await pool.query(
      'UPDATE piece_casts SET role_name = $1 WHERE id = $2 RETURNING id, role_name',
      [role_name || null, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Cast entry not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to update role name.' });
  }
});

// ── Schedule placeholder routes ───────────────────────────────────────────────

// GET /api/schedule-placeholders — all placeholders for current season
app.get('/api/schedule-placeholders', requireAuth('master'), async (req, res) => {
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  try {
    const result = await pool.query(
      'SELECT * FROM schedule_placeholders WHERE season_id = $1 ORDER BY day ASC, start_time ASC',
      [seasonId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to fetch placeholders.' });
  }
});

// POST /api/schedule-placeholders — create a placeholder block
app.post('/api/schedule-placeholders', requireAuth('master'), async (req, res) => {
  const { label, day, start_time, end_time, room_id } = req.body;
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  if (!day || !start_time || !end_time) return res.status(400).json({ error: 'day, start_time, and end_time required.' });
  try {
    const result = await pool.query(
      `INSERT INTO schedule_placeholders (season_id, label, day, start_time, end_time, room_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [seasonId, label || 'Blocked', day, start_time, end_time, room_id || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to create placeholder.' });
  }
});

// PUT /api/schedule-placeholders/:id — update a placeholder block
app.put('/api/schedule-placeholders/:id', requireAuth('master'), async (req, res) => {
  // room_id is optional on this route: the drag/resize PUT call only ever sends
  // label/day/start_time/end_time, so omitting room_id must leave it untouched
  // rather than wiping out an assigned room on every resize.
  const { label, day, start_time, end_time, room_id } = req.body;
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  try {
    const result = room_id !== undefined
      ? await pool.query(
          `UPDATE schedule_placeholders SET label=$1, day=$2, start_time=$3, end_time=$4, room_id=$5
           WHERE id=$6 AND season_id=$7 RETURNING *`,
          [label || 'Blocked', day, start_time, end_time, room_id || null, req.params.id, seasonId]
        )
      : await pool.query(
          `UPDATE schedule_placeholders SET label=$1, day=$2, start_time=$3, end_time=$4
           WHERE id=$5 AND season_id=$6 RETURNING *`,
          [label || 'Blocked', day, start_time, end_time, req.params.id, seasonId]
        );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Placeholder not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to update placeholder.' });
  }
});

// DELETE /api/schedule-placeholders/all — clear all placeholders for current season
app.delete('/api/schedule-placeholders/all', requireAuth('master'), async (req, res) => {
  const { seasonId } = req.session;
  if (!seasonId) return res.status(400).json({ error: 'No active season.' });
  try {
    await pool.query('DELETE FROM schedule_placeholders WHERE season_id = $1', [seasonId]);
    res.json({ message: 'All placeholders cleared.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear placeholders.' });
  }
});

// DELETE /api/schedule-placeholders/:id — delete a placeholder block
app.delete('/api/schedule-placeholders/:id', requireAuth('master'), async (req, res) => {
  try {
    await pool.query('DELETE FROM schedule_placeholders WHERE id = $1', [req.params.id]);
    res.json({ message: 'Placeholder deleted.' });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to delete placeholder.' });
  }
});

// ── Private admin — director accounts ────────────────────────────────────────

app.get('/admin/masters', async (req, res) => {
  if (!process.env.MASTER_CODE || req.query.key !== process.env.MASTER_CODE) {
    return res.status(401).send('Unauthorized');
  }
  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.email, u.created_at, u.plan_type, u.plan_expires_at,
             COALESCE(string_agg(DISTINCT o.name, ', ' ORDER BY o.name), '—') AS orgs
      FROM users u
      LEFT JOIN org_members om ON om.user_id = u.id AND om.role = 'owner'
      LEFT JOIN orgs o ON o.id = om.org_id
      WHERE u.role = 'master'
        AND u.email NOT LIKE '%@demo.castsync.app'
        AND (u.is_mock IS NULL OR u.is_mock IS FALSE)
      GROUP BY u.id, u.email, u.created_at, u.plan_type, u.plan_expires_at
      ORDER BY u.created_at DESC NULLS LAST
    `);

    const now = new Date();
    const tableRows = rows.map(r => {
      const joined  = r.created_at ? new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
      const expires = r.plan_expires_at ? new Date(r.plan_expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
      const plan    = r.plan_type || '—';
      const expired = r.plan_expires_at && new Date(r.plan_expires_at) < now;
      const badge   = expired
        ? `<span style="background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:4px;font-size:12px;">${plan} · expired</span>`
        : `<span style="background:#d1fae5;color:#065f46;padding:2px 8px;border-radius:4px;font-size:12px;">${plan}</span>`;
      return `<tr>
        <td>${r.email}</td>
        <td>${joined}</td>
        <td>${badge}</td>
        <td>${expires}</td>
        <td>${r.orgs}</td>
      </tr>`;
    }).join('');

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>CastSync — Director Accounts</title>
  <style>
    body { font-family:-apple-system,sans-serif; background:#f9fafb; color:#111; margin:0; padding:40px; }
    h1 { font-size:1.4rem; margin-bottom:4px; }
    .sub { color:#6b7280; font-size:14px; margin-bottom:32px; }
    table { border-collapse:collapse; width:100%; background:#fff; border-radius:8px; overflow:hidden; box-shadow:0 1px 4px rgba(0,0,0,.08); }
    th { background:#111; color:#fff; padding:10px 14px; text-align:left; font-size:12px; font-weight:600; letter-spacing:.4px; text-transform:uppercase; }
    td { padding:10px 14px; border-bottom:1px solid #e5e7eb; font-size:14px; color:#374151; }
    tr:last-child td { border-bottom:none; }
    tr:hover td { background:#f9fafb; }
  </style>
</head>
<body>
  <h1>Director Accounts</h1>
  <div class="sub">${rows.length} total</div>
  <table>
    <thead><tr><th>Email</th><th>Joined</th><th>Plan</th><th>Expires</th><th>Orgs</th></tr></thead>
    <tbody>${tableRows || '<tr><td colspan="5" style="color:#9ca3af;text-align:center;padding:24px;">No director accounts yet.</td></tr>'}</tbody>
  </table>
</body>
</html>`);
  } catch (err) {
    console.error('Admin masters error:', err.message);
    res.status(500).send('Server error');
  }
});

// ── Auto-migration ────────────────────────────────────────────────────────────

// Today's hardcoded audition-form fields, expressed as form-schema entries. Used as
// the DEFAULT for orgs.default_form_schema / seasons.form_schema so existing (and
// brand-new) productions keep asking exactly these questions until a director opens
// the form builder and changes something.
const LEGACY_FORM_SCHEMA = [
  { id: 'address', builtin: 'address', label: 'Address', type: 'text', required: false },
  { id: 'grade', builtin: 'grade', label: 'Grade', type: 'select', required: false,
    options: ['Freshman Major', 'Freshman Minor', 'Sophomore Major', 'Sophomore Minor',
              'Junior Major', 'Junior Minor', 'Senior Major', 'Senior Minor', 'Other'] },
  { id: 'technique_classes', builtin: 'technique_classes', label: 'Current Technique Classes', type: 'textarea', required: false },
  { id: 'injuries', builtin: 'injuries', label: 'Recent Injuries', type: 'textarea', required: false },
  { id: 'absences', builtin: 'absences', label: 'Known Absences', type: 'textarea', required: false },
  { id: 'secondary_email', builtin: 'secondary_email', label: 'Secondary Email', type: 'text', required: true },
];
const LEGACY_FORM_SCHEMA_SQL = JSON.stringify(LEGACY_FORM_SCHEMA).replace(/'/g, "''");
const SECONDARY_EMAIL_FIELD_SQL = JSON.stringify([LEGACY_FORM_SCHEMA[5]]).replace(/'/g, "''");

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

  // Step 11: role_name on piece_casts + schedule_placeholders table
  try {
    await pool.query(`
      DO $$ BEGIN
        ALTER TABLE piece_casts ADD COLUMN role_name VARCHAR(200);
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schedule_placeholders (
        id         SERIAL PRIMARY KEY,
        season_id  INTEGER REFERENCES seasons(id) ON DELETE CASCADE,
        label      VARCHAR(200) NOT NULL DEFAULT 'Blocked',
        day        VARCHAR(20)  NOT NULL,
        start_time VARCHAR(20)  NOT NULL,
        end_time   VARCHAR(20)  NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('Migration step 11 (piece_casts.role_name + schedule_placeholders) complete.');
  } catch (err) { console.error('Migration step 11 error:', err.message); }

  // Step 12: season.status (active/archived) + season_members.can_see_other_blocks
  try {
    await pool.query(`
      DO $$ BEGIN
        ALTER TABLE seasons ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'active';
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN
        ALTER TABLE season_members ADD COLUMN can_see_other_blocks BOOLEAN NOT NULL DEFAULT FALSE;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
    `);
    console.log('Migration step 12 (season.status + season_members.can_see_other_blocks) complete.');
  } catch (err) { console.error('Migration step 12 error:', err.message); }

  // Step 13: time_to_minutes() helper function for correct "H:MM AM/PM" comparison in SQL.
  // String comparison fails for 10/11 AM/PM because "10" sorts before "9" alphabetically.
  try {
    await pool.query(`
      CREATE OR REPLACE FUNCTION time_to_minutes(t TEXT) RETURNS INTEGER AS $$
        SELECT CASE
          WHEN t LIKE '12:% AM' THEN CAST(split_part(split_part(t,':',2),' ',1) AS INTEGER)
          WHEN t LIKE '12:% PM' THEN 720 + CAST(split_part(split_part(t,':',2),' ',1) AS INTEGER)
          WHEN t LIKE '% AM'    THEN CAST(split_part(t,':',1) AS INTEGER) * 60
                                       + CAST(split_part(split_part(t,':',2),' ',1) AS INTEGER)
          ELSE                       (CAST(split_part(t,':',1) AS INTEGER) + 12) * 60
                                       + CAST(split_part(split_part(t,':',2),' ',1) AS INTEGER)
        END
      $$ LANGUAGE SQL IMMUTABLE;
    `);
    console.log('Migration step 13 (time_to_minutes function) complete.');
  } catch (err) { console.error('Migration step 13 error:', err.message); }

  // Step 14: is_mock flag on users (for seeded trial test auditionees)
  try {
    await pool.query(`
      DO $$ BEGIN
        ALTER TABLE users ADD COLUMN is_mock BOOLEAN NOT NULL DEFAULT FALSE;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
    `);
    console.log('Migration step 14 (users.is_mock) complete.');
  } catch (err) { console.error('Migration step 14 error:', err.message); }

  // Step 15: customizable audition forms — org default template, per-season override,
  // and a home for custom-field answers on submissions. The column DEFAULT is the
  // legacy field set itself, so both pre-existing rows (backfilled by Postgres at
  // ALTER TABLE time) and brand-new orgs/seasons start out looking like today's form.
  try {
    await pool.query(`
      DO $$ BEGIN
        ALTER TABLE orgs ADD COLUMN default_form_schema JSONB NOT NULL DEFAULT '${LEGACY_FORM_SCHEMA_SQL}'::jsonb;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN
        ALTER TABLE seasons ADD COLUMN form_schema JSONB NOT NULL DEFAULT '${LEGACY_FORM_SCHEMA_SQL}'::jsonb;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN
        ALTER TABLE submissions ADD COLUMN custom_responses JSONB NOT NULL DEFAULT '{}';
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
    `);
    console.log('Migration step 15 (form_schema columns + legacy default/backfill) complete.');
  } catch (err) { console.error('Migration step 15 error:', err.message); }

  // Step 16: required secondary email, a profile-level column (reusable across
  // productions, like address/phone) plus a backfill so every org/season that
  // predates this field picks it up without a director having to re-open the
  // form builder. Guarded by NOT EXISTS so re-running this on every boot is a no-op
  // once applied.
  try {
    await pool.query(`
      DO $$ BEGIN
        ALTER TABLE dancer_profiles ADD COLUMN secondary_email VARCHAR(255);
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      ALTER TABLE orgs ALTER COLUMN default_form_schema SET DEFAULT '${LEGACY_FORM_SCHEMA_SQL}'::jsonb;
      ALTER TABLE seasons ALTER COLUMN form_schema SET DEFAULT '${LEGACY_FORM_SCHEMA_SQL}'::jsonb;
      UPDATE orgs SET default_form_schema = default_form_schema || '${SECONDARY_EMAIL_FIELD_SQL}'::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(default_form_schema) elem WHERE elem->>'builtin' = 'secondary_email'
        );
      UPDATE seasons SET form_schema = form_schema || '${SECONDARY_EMAIL_FIELD_SQL}'::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(form_schema) elem WHERE elem->>'builtin' = 'secondary_email'
        );
    `);
    console.log('Migration step 16 (secondary_email column + form_schema backfill) complete.');
  } catch (err) { console.error('Migration step 16 error:', err.message); }

  // Step 17: new orgs start with a blank default audition form (just the permanent
  // fields: name, email, phone, availability, which aren't part of form_schema at
  // all and always render regardless of its contents). This only changes the column
  // DEFAULT, which Postgres applies only to future inserts that omit the column;
  // every existing org's already-stored default_form_schema is untouched, and new
  // seasons keep copying whatever their own org's default is at creation time.
  try {
    await pool.query(`ALTER TABLE orgs ALTER COLUMN default_form_schema SET DEFAULT '[]'::jsonb;`);
    console.log('Migration step 17 (new orgs default to a blank audition form) complete.');
  } catch (err) { console.error('Migration step 17 error:', err.message); }

  // Step 18: Production Notes, lightweight internal faculty notes, never shown to
  // auditionees. A note optionally relates to one dancer and/or several pieces.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS production_notes (
        id              SERIAL PRIMARY KEY,
        season_id       INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
        author_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        note_text       TEXT NOT NULL,
        category        VARCHAR(20) NOT NULL DEFAULT 'general',
        dancer_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at      TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS production_note_pieces (
        note_id  INTEGER NOT NULL REFERENCES production_notes(id) ON DELETE CASCADE,
        piece_id INTEGER NOT NULL REFERENCES pieces(id) ON DELETE CASCADE,
        PRIMARY KEY (note_id, piece_id)
      );
    `);
    console.log('Migration step 18 (production_notes tables) complete.');
  } catch (err) { console.error('Migration step 18 error:', err.message); }

  // Step 19: Attendance. One row per dancer per piece per rehearsal date, scoped to
  // the piece since multiple pieces can rehearse the same day (even the same time, in
  // different rooms) and a dancer's attendance can differ between them. Present
  // defaults to true and status defaults to none, matching the UI's defaults, so a
  // date with no rows yet is indistinguishable from a date where everyone showed up.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS attendance_records (
        id             SERIAL PRIMARY KEY,
        season_id      INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
        piece_id       INTEGER NOT NULL REFERENCES pieces(id) ON DELETE CASCADE,
        user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        rehearsal_date DATE NOT NULL,
        present        BOOLEAN NOT NULL DEFAULT TRUE,
        status         VARCHAR(20) NOT NULL DEFAULT 'none',
        status_note    TEXT,
        updated_at     TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE (piece_id, user_id, rehearsal_date)
      );
    `);
    console.log('Migration step 19 (attendance_records table) complete.');
  } catch (err) { console.error('Migration step 19 error:', err.message); }

  // Step 20: Absence requests. piece_id is nullable: NULL means the auditionee
  // submitted as TBD (casting not published yet, or they weren't sure), and a
  // director can assign it to a real piece later. There's no choreographer_user_id
  // column here on purpose: choreographer identity for notifications is always
  // looked up live via pieces.choreographer_email (see notifyChoreographerForPiece
  // below), so adding real choreographer accounts later only means changing that one
  // lookup, not this table or any of the call sites.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS absence_requests (
        id            SERIAL PRIMARY KEY,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        org_id        INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        season_id     INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
        absence_date  DATE NOT NULL,
        start_time    VARCHAR(20) NOT NULL,
        end_time      VARCHAR(20) NOT NULL,
        reason        TEXT NOT NULL,
        piece_id      INTEGER REFERENCES pieces(id) ON DELETE SET NULL,
        status        VARCHAR(20) NOT NULL DEFAULT 'pending',
        documentation_link TEXT,
        created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
      );
      DO $$ BEGIN
        ALTER TABLE absence_requests ADD COLUMN documentation_link TEXT;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
    `);
    console.log('Migration step 20 (absence_requests table) complete.');
  } catch (err) { console.error('Migration step 20 error:', err.message); }

  // Step 21: optional detailed weekly schedule, per production. 'grid' (the only mode
  // that ever existed before this) is the default for every existing and future row,
  // so nothing changes for anyone unless a director opts in. See isAvailableBlock
  // near the top of this file for why no migration of existing submissions.availability
  // data is needed.
  try {
    await pool.query(`
      DO $$ BEGIN
        ALTER TABLE seasons ADD COLUMN availability_mode VARCHAR(20) NOT NULL DEFAULT 'grid';
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
    `);
    console.log('Migration step 21 (seasons.availability_mode) complete.');
  } catch (err) { console.error('Migration step 21 error:', err.message); }

  // Step 22: production-level date fields. All nullable, all default NULL, so nothing
  // changes for any existing production until a director sets them in Production Settings.
  try {
    await pool.query(`
      DO $$ BEGIN ALTER TABLE seasons ADD COLUMN start_date DATE; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN ALTER TABLE seasons ADD COLUMN end_date DATE; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN ALTER TABLE seasons ADD COLUMN audition_date DATE; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN ALTER TABLE seasons ADD COLUMN performance_date DATE; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
    `);
    console.log('Migration step 22 (seasons production dates) complete.');
  } catch (err) { console.error('Migration step 22 error:', err.message); }

  // Step 23: dated overrides on top of the weekly master_blocks template (cancel a single
  // occurrence, move it, or add a one-time rehearsal with no template at all). The weekly
  // template in master_blocks stays the only thing directors edit directly; this table is
  // a pure overlay read alongside it when generating dated occurrences. No ON DELETE
  // action on master_block_id: deleting a template block that has recorded exceptions is
  // blocked by app code (see DELETE /api/master-blocks/:id) instead of silently cascading
  // history away.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS master_block_exceptions (
        id              SERIAL PRIMARY KEY,
        season_id       INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
        piece_id        INTEGER NOT NULL REFERENCES pieces(id) ON DELETE CASCADE,
        master_block_id INTEGER REFERENCES master_blocks(id),
        original_date   DATE NOT NULL,
        type            VARCHAR(20) NOT NULL CHECK (type IN ('cancelled','moved','added')),
        new_date        DATE,
        new_start_time  VARCHAR(20),
        new_end_time    VARCHAR(20),
        note            TEXT,
        created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE (master_block_id, original_date),
        CHECK (
          (type = 'cancelled' AND new_date IS NULL AND new_start_time IS NULL AND new_end_time IS NULL) OR
          (type = 'moved'     AND master_block_id IS NOT NULL AND new_date IS NOT NULL AND new_start_time IS NOT NULL AND new_end_time IS NOT NULL) OR
          (type = 'added'     AND master_block_id IS NULL AND new_date IS NOT NULL AND new_start_time IS NOT NULL AND new_end_time IS NOT NULL)
        )
      );
    `);
    console.log('Migration step 23 (master_block_exceptions table) complete.');
  } catch (err) { console.error('Migration step 23 error:', err.message); }

  // Step 24: Account page additions -- display name, change-email (pending_email +
  // its own token, separate from verification_token which is signup-specific), and
  // notification preferences. All nullable/defaulted, zero behavior change until a
  // user actually sets one.
  try {
    await pool.query(`
      DO $$ BEGIN
        ALTER TABLE users ADD COLUMN name VARCHAR(255);
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
    `);
    await pool.query(`
      DO $$ BEGIN
        ALTER TABLE users ADD COLUMN pending_email VARCHAR(255);
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
    `);
    await pool.query(`
      DO $$ BEGIN
        ALTER TABLE users ADD COLUMN email_change_token VARCHAR(100);
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
    `);
    await pool.query(`
      DO $$ BEGIN
        ALTER TABLE users ADD COLUMN notification_prefs JSONB NOT NULL DEFAULT '{}'::jsonb;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
    `);
    console.log('Migration step 24 (users name/pending_email/email_change_token/notification_prefs) complete.');
  } catch (err) { console.error('Migration step 24 error:', err.message); }

  // Step 25: named rooms. A season with zero rows here keeps today's anonymous
  // lane-count conflict behavior untouched (see highlightConflicts in
  // master-schedule.js) -- the room-aware system only switches on once a director
  // adds their first named room. room_id columns are nullable on every table that
  // schedules something into a physical space, so existing rows are simply
  // "unassigned" rather than broken.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id         SERIAL PRIMARY KEY,
        season_id  INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
        name       VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      DO $$ BEGIN
        ALTER TABLE master_blocks ADD COLUMN room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
    `);
    await pool.query(`
      DO $$ BEGIN
        ALTER TABLE master_block_exceptions ADD COLUMN room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
    `);
    await pool.query(`
      DO $$ BEGIN
        ALTER TABLE schedule_placeholders ADD COLUMN room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
    `);
    // Preserve any labeling effort already typed into the old pieces.room free-text
    // field by turning each distinct value into a real named room, one per season.
    await pool.query(`
      INSERT INTO rooms (season_id, name)
      SELECT DISTINCT season_id, room FROM pieces
      WHERE room IS NOT NULL AND room != ''
      AND NOT EXISTS (SELECT 1 FROM rooms r WHERE r.season_id = pieces.season_id AND r.name = pieces.room);
    `);
    console.log('Migration step 25 (rooms table + room_id columns + pieces.room backfill) complete.');
  } catch (err) { console.error('Migration step 25 error:', err.message); }

  // Step 26: multiple performance dates per production. seasons.performance_date
  // (singular) is left in place but no longer read or written -- any existing value
  // is copied into the new table once, idempotently (the unique constraint makes the
  // backfill safe to run on every boot).
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS performance_dates (
        id         SERIAL PRIMARY KEY,
        season_id  INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
        date       DATE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (season_id, date)
      );
    `);
    await pool.query(`
      INSERT INTO performance_dates (season_id, date)
      SELECT id, performance_date FROM seasons WHERE performance_date IS NOT NULL
      ON CONFLICT (season_id, date) DO NOTHING;
    `);
    console.log('Migration step 26 (performance_dates table + backfill) complete.');
  } catch (err) { console.error('Migration step 26 error:', err.message); }

  try {
    await pool.query(`
      ALTER TABLE seasons ADD COLUMN IF NOT EXISTS my_schedule_enabled BOOLEAN NOT NULL DEFAULT FALSE;
    `);
    console.log('Migration step 27 (seasons.my_schedule_enabled) complete.');
  } catch (err) { console.error('Migration step 27 error:', err.message); }

  console.log('All migrations complete.');
}

// ── Sentry error handler (must be after all routes) ──────────────────────────
Sentry.setupExpressErrorHandler(app);

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`[startup] APP_URL resolved to: ${APP_URL}`);
  if (!process.env.GOOGLE_CLIENT_ID) console.log('  → Google OAuth not configured');
  if (!emailEnabled)                  console.log('  → Email not configured (set RESEND_API_KEY)');
  await runMigrations();
});
