require('dotenv').config();

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
const nodemailer     = require('nodemailer');
const crypto         = require('crypto');

const app = express();

// ── Database ──────────────────────────────────────────────────────────────────

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : new Pool({
      host: process.env.DB_HOST, port: process.env.DB_PORT,
      database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    });

// ── Email ─────────────────────────────────────────────────────────────────────

const emailEnabled = !!(process.env.EMAIL_USER && process.env.EMAIL_PASS);
const transporter  = emailEnabled
  ? nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } })
  : null;

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
    await transporter.sendMail({
      from: `"CastSync" <${process.env.EMAIL_USER}>`,
      to: toEmail,
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

app.use(cors());
app.use(express.json());
app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true },
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

app.post('/api/auth/signup', async (req, res) => {
  const { email, password, masterCode } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  if (password.length < 6)  return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const role = masterCode === process.env.MASTER_CODE ? 'master' : 'auditionee';
  try {
    const hash   = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role',
      [email.toLowerCase().trim(), hash, role]
    );
    const user = result.rows[0];
    req.session.userId = user.id;
    req.session.role   = user.role;
    req.session.email  = user.email;
    res.status(201).json({ id: user.id, email: user.email, role: user.role });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An account with that email already exists.' });
    console.error('Signup error:', err.message);
    res.status(500).json({ error: 'Could not create account.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  try {
    const result = await pool.query('SELECT id, email, password_hash, role, is_director FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    const user   = result.rows[0];
    if (!user || !user.password_hash) return res.status(401).json({ error: 'Incorrect email or password.' });
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Incorrect email or password.' });
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

// GET /api/orgs — list all orgs this director belongs to
app.get('/api/orgs', requireAuth('master'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.id, o.name, o.join_code, om.role,
              (SELECT COUNT(*) FROM seasons WHERE org_id = o.id) AS season_count
       FROM orgs o
       JOIN org_members om ON om.org_id = o.id
       WHERE om.user_id = $1
       ORDER BY o.created_at DESC`,
      [req.session.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to fetch orgs.' });
  }
});

// GET /api/orgs/preview?join_code=XXX — public org lookup for join code preview
app.get('/api/orgs/preview', async (req, res) => {
  const { join_code } = req.query;
  if (!join_code || join_code.trim().length < 6) return res.json({ found: false });
  try {
    const result = await pool.query(
      `SELECT o.name AS org_name, s.name AS season_name
       FROM orgs o
       JOIN seasons s ON s.org_id = o.id AND s.is_active = TRUE
       WHERE UPPER(o.join_code) = UPPER($1)
       ORDER BY s.created_at DESC LIMIT 1`,
      [join_code.trim()]
    );
    if (result.rows.length === 0) return res.json({ found: false });
    res.json({ found: true, org_name: result.rows[0].org_name, season_name: result.rows[0].season_name });
  } catch (err) {
    res.json({ found: false });
  }
});

// POST /api/orgs — director creates a new org
app.post('/api/orgs', requireAuth('master'), async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Org name is required.' });
  const joinCode = generateJoinCode();
  try {
    const orgResult = await pool.query(
      'INSERT INTO orgs (name, join_code) VALUES ($1, $2) RETURNING id, name, join_code',
      [name.trim(), joinCode]
    );
    const org = orgResult.rows[0];
    await pool.query(
      'INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)',
      [org.id, req.session.userId, 'owner']
    );
    // Auto-create first season
    const seasonResult = await pool.query(
      'INSERT INTO seasons (org_id, name, is_active) VALUES ($1, $2, TRUE) RETURNING id, name',
      [org.id, 'Season 1']
    );
    const season = seasonResult.rows[0];
    res.status(201).json({ org, season });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to create org.' });
  }
});

// POST /api/orgs/:id/invite — invite a co-director by email
app.post('/api/orgs/:id/invite', requireAuth('master'), async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });
  try {
    // Check user is owner of this org
    const ownerCheck = await pool.query(
      'SELECT id FROM org_members WHERE org_id = $1 AND user_id = $2 AND role = $3',
      [req.params.id, req.session.userId, 'owner']
    );
    if (ownerCheck.rows.length === 0) return res.status(403).json({ error: 'Only the org owner can invite co-directors.' });

    const userResult = await pool.query('SELECT id FROM users WHERE email = $1 AND role = $2', [email.toLowerCase().trim(), 'master']);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'No director account found with that email.' });

    const inviteeId = userResult.rows[0].id;
    await pool.query(
      'INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (org_id, user_id) DO NOTHING',
      [req.params.id, inviteeId, 'editor']
    );
    res.json({ message: 'Co-director added.' });
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
    // Verify membership
    const check = await pool.query(
      'SELECT id FROM org_members WHERE org_id = $1 AND user_id = $2',
      [orgId, req.session.userId]
    );
    if (check.rows.length === 0) return res.status(403).json({ error: 'Not a member of this org.' });

    const orgResult    = await pool.query('SELECT name FROM orgs WHERE id = $1', [orgId]);
    const seasonResult = await pool.query('SELECT name FROM seasons WHERE id = $1 AND org_id = $2', [seasonId, orgId]);
    if (orgResult.rows.length === 0 || seasonResult.rows.length === 0)
      return res.status(404).json({ error: 'Org or season not found.' });

    req.session.orgId      = parseInt(orgId);
    req.session.seasonId   = parseInt(seasonId);
    req.session.orgName    = orgResult.rows[0].name;
    req.session.seasonName = seasonResult.rows[0].name;
    res.json({ orgId, seasonId, orgName: req.session.orgName, seasonName: req.session.seasonName });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to set org context.' });
  }
});

// ── Season routes ─────────────────────────────────────────────────────────────

// GET /api/orgs/:orgId/seasons
app.get('/api/orgs/:orgId/seasons', requireAuth('master'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.name, s.is_active, s.created_at,
              (SELECT COUNT(*) FROM submissions WHERE season_id = s.id) AS submission_count
       FROM seasons s WHERE s.org_id = $1 ORDER BY s.created_at DESC`,
      [req.params.orgId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to fetch seasons.' });
  }
});

// POST /api/orgs/:orgId/seasons — create a new season
app.post('/api/orgs/:orgId/seasons', requireAuth('master'), async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Season name is required.' });
  try {
    const result = await pool.query(
      'INSERT INTO seasons (org_id, name, is_active) VALUES ($1, $2, TRUE) RETURNING id, name',
      [req.params.orgId, name.trim()]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to create season.' });
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
          technique_classes, injuries, absences, availability } = req.body;

  if (!join_code)   return res.status(400).json({ error: 'Join code is required.' });
  if (!first_name || !last_name) return res.status(400).json({ error: 'Name is required.' });

  try {
    // Look up org by join code
    const orgResult = await pool.query('SELECT id, name FROM orgs WHERE UPPER(join_code) = UPPER($1)', [join_code.trim()]);
    if (orgResult.rows.length === 0)
      return res.status(404).json({ error: 'Invalid join code. Please check with your director.' });

    const org = orgResult.rows[0];

    // Get active season for this org
    const seasonResult = await pool.query(
      'SELECT id, name FROM seasons WHERE org_id = $1 AND is_active = TRUE ORDER BY created_at DESC LIMIT 1',
      [org.id]
    );
    if (seasonResult.rows.length === 0)
      return res.status(404).json({ error: 'This organization has no active season.' });

    const season = seasonResult.rows[0];

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

    if (isUpdate) {
      await pool.query(
        `UPDATE submissions SET injuries=$1, absences=$2, availability=$3
         WHERE user_id=$4 AND season_id=$5`,
        [injuries||null, absences||null, JSON.stringify(availability||[]), req.session.userId, season.id]
      );
    } else {
      await pool.query(
        `INSERT INTO submissions (user_id, org_id, season_id, injuries, absences, availability)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.session.userId, org.id, season.id, injuries||null, absences||null, JSON.stringify(availability||[])]
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

// ── Master dancer routes (org/season scoped) ──────────────────────────────────

// GET /api/dancers — all submissions for current org/season
app.get('/api/dancers', requireAuth('master'), async (req, res) => {
  const { orgId, seasonId } = req.session;
  if (!orgId || !seasonId) return res.status(400).json({ error: 'No active org/season.' });
  try {
    const result = await pool.query(
      `SELECT dp.id AS profile_id, u.id AS user_id,
              dp.first_name, dp.last_name, u.email, dp.grade, sub.created_at,
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

// GET /api/dancers/search — search by name within current org/season
app.get('/api/dancers/search', requireAuth('master'), async (req, res) => {
  const { q } = req.query;
  const { orgId, seasonId } = req.session;
  if (!q || !orgId || !seasonId) return res.json([]);
  try {
    const result = await pool.query(
      `SELECT dp.id AS id, u.id AS user_id, dp.first_name, dp.last_name, sub.availability
       FROM submissions sub
       JOIN dancer_profiles dp ON dp.user_id = sub.user_id
       JOIN users u ON u.id = sub.user_id
       WHERE sub.org_id = $1 AND sub.season_id = $2
         AND LOWER(dp.first_name || ' ' || dp.last_name) LIKE LOWER($3)
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
      'SELECT id, name, color FROM pieces WHERE season_id = $1 ORDER BY created_at ASC',
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
      `SELECT dp.id, u.id AS user_id, dp.first_name, dp.last_name, sub.availability
       FROM submissions sub
       JOIN dancer_profiles dp ON dp.user_id = sub.user_id
       JOIN users u ON u.id = sub.user_id
       WHERE sub.org_id = $1 AND sub.season_id = $2 AND sub.availability IS NOT NULL`,
      [orgId, seasonId]
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
      const entry = { id: dancer.user_id, first_name: dancer.first_name, last_name: dancer.last_name };
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
    // Safe column additions (ALTER TABLE IF NOT EXISTS column doesn't exist in older PG, use DO block)
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
    `);
    console.log('Migrations complete.');
  } catch (err) {
    console.error('Migration error:', err.message);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server running at http://localhost:${PORT}`);
  if (!process.env.GOOGLE_CLIENT_ID) console.log('  → Google OAuth not configured');
  if (!emailEnabled)                  console.log('  → Email not configured');
  await runMigrations();
});
