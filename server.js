require('dotenv').config();

// Fail fast with a clear error if required env vars are missing
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

const app = express();

// ── Database ──────────────────────────────────────────────────────────────────
// Supports both Railway (DATABASE_URL) and local (.env individual vars)

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : new Pool({
      host:     process.env.DB_HOST,
      port:     process.env.DB_PORT,
      database: process.env.DB_NAME,
      user:     process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });

// ── Email ─────────────────────────────────────────────────────────────────────

const emailEnabled = !!(process.env.EMAIL_USER && process.env.EMAIL_PASS);

const transporter = emailEnabled
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    })
  : null;

async function sendConfirmationEmail(toEmail, firstName) {
  if (!emailEnabled) return;
  try {
    await transporter.sendMail({
      from:    `"Audition Portal" <${process.env.EMAIL_USER}>`,
      to:      toEmail,
      subject: 'Your Audition Form Has Been Received',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
          <h2 style="color:#1a1a2e;">Submission Received</h2>
          <p>Hi ${firstName},</p>
          <p>Your audition form has been successfully submitted. We have everything we need and will be in touch.</p>
          <p style="color:#888;font-size:13px;">If you need to update your information, simply log back in and resubmit the form.</p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
          <p style="color:#aaa;font-size:12px;">Audition Portal</p>
        </div>`,
    });
  } catch (err) {
    console.error('Email error:', err.message);
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());

app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret:            process.env.SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true },
}));

// ── Passport / Google OAuth ───────────────────────────────────────────────────

passport.serializeUser((user, done) => done(null, user.id));

passport.deserializeUser(async (id, done) => {
  try {
    const r = await pool.query('SELECT id, email, role FROM users WHERE id = $1', [id]);
    done(null, r.rows[0] || false);
  } catch (err) {
    done(err);
  }
});

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy(
    {
      clientID:     process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL:  `${process.env.APP_URL}/auth/google/callback`,
    },
    async (accessToken, refreshToken, profile, done) => {
      const email = profile.emails[0].value.toLowerCase();
      try {
        // Look up by google_id first, then by email (links accounts)
        let result = await pool.query(
          'SELECT id, email, role, google_id FROM users WHERE google_id = $1 OR email = $2',
          [profile.id, email]
        );

        if (result.rows.length > 0) {
          const user = result.rows[0];
          // Link google_id if they previously signed up by email
          if (!user.google_id) {
            await pool.query('UPDATE users SET google_id = $1 WHERE id = $2', [profile.id, user.id]);
          }
          return done(null, user);
        }

        // Create a new auditionee account
        result = await pool.query(
          'INSERT INTO users (email, google_id, role) VALUES ($1, $2, $3) RETURNING id, email, role',
          [email, profile.id, 'auditionee']
        );
        console.log(`New Google account (auditionee): ${email}`);
        done(null, result.rows[0]);
      } catch (err) {
        done(err);
      }
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
    if (!req.session.userId) {
      return res.status(401).json({ error: 'Not logged in.' });
    }
    if (role && req.session.role !== role) {
      return res.status(403).json({ error: 'Access denied.' });
    }
    next();
  };
}

// ── Google OAuth routes ───────────────────────────────────────────────────────

app.get('/auth/google',
  passport.authenticate('google', { scope: ['email', 'profile'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login.html?error=google' }),
  (req, res) => {
    req.session.userId = req.user.id;
    req.session.role   = req.user.role;
    req.session.email  = req.user.email;
    if (req.user.role === 'master') res.redirect('/master.html');
    else                            res.redirect('/auditionForm.html');
  }
);

// ── Auth routes ───────────────────────────────────────────────────────────────

app.post('/api/auth/signup', async (req, res) => {
  const { email, password, masterCode } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  const role = masterCode === process.env.MASTER_CODE ? 'master' : 'auditionee';

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, $3)
       RETURNING id, email, role`,
      [email.toLowerCase().trim(), passwordHash, role]
    );
    const user = result.rows[0];
    req.session.userId = user.id;
    req.session.role   = user.role;
    req.session.email  = user.email;
    console.log(`New ${role} account: ${user.email}`);
    res.status(201).json({ id: user.id, email: user.email, role: user.role });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }
    console.error('Signup error:', err.message);
    res.status(500).json({ error: 'Could not create account. Please try again.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const result = await pool.query(
      'SELECT id, email, password_hash, role FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    const user = result.rows[0];
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }
    req.session.userId = user.id;
    req.session.role   = user.role;
    req.session.email  = user.email;
    console.log(`Login: ${user.email} (${user.role})`);
    res.json({ id: user.id, email: user.email, role: user.role });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ message: 'Logged out.' }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not logged in.' });
  }
  res.json({ id: req.session.userId, email: req.session.email, role: req.session.role });
});

// ── Dancer routes ─────────────────────────────────────────────────────────────

app.post('/api/dancers', requireAuth('auditionee'), async (req, res) => {
  const {
    first_name, last_name, email, phone, address,
    grade, technique_classes, injuries, absences, availability,
  } = req.body;

  if (!first_name || !last_name || !email) {
    return res.status(400).json({ error: 'First name, last name, and email are required.' });
  }

  try {
    const existing = await pool.query('SELECT id FROM dancers WHERE user_id = $1', [req.session.userId]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'You already have a submission on file.' });
    }

    const result = await pool.query(
      `INSERT INTO dancers
         (first_name, last_name, email, phone, address, grade,
          technique_classes, injuries, absences, availability, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, first_name, last_name, created_at`,
      [
        first_name, last_name, email,
        phone             || null,
        address           || null,
        grade             || null,
        technique_classes || null,
        injuries          || null,
        absences          || null,
        availability      ? JSON.stringify(availability) : null,
        req.session.userId,
      ]
    );

    const newDancer = result.rows[0];
    console.log(`Saved dancer: ${newDancer.first_name} ${newDancer.last_name} (id: ${newDancer.id})`);

    // Send confirmation email (non-blocking)
    sendConfirmationEmail(email, first_name);

    res.status(201).json({ message: 'Dancer saved successfully!', dancer: newDancer });
  } catch (err) {
    console.error('Database error:', err.message);
    res.status(500).json({ error: 'Failed to save dancer. Please try again.' });
  }
});

app.get('/api/dancers', requireAuth('master'), async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, first_name, last_name, email, grade, created_at FROM dancers ORDER BY last_name ASC, first_name ASC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Database error:', err.message);
    res.status(500).json({ error: 'Failed to fetch dancers.' });
  }
});

// DELETE /api/dancers — master wipes all submissions (accounts stay)
app.delete('/api/dancers', requireAuth('master'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM dancers RETURNING id');
    console.log(`Cleared ${result.rowCount} dancer submissions.`);
    res.json({ message: `Cleared ${result.rowCount} submissions.` });
  } catch (err) {
    console.error('Database error:', err.message);
    res.status(500).json({ error: 'Failed to clear submissions.' });
  }
});

// NOTE: /api/dancers/me and /api/dancers/search must come BEFORE /api/dancers/:id

app.get('/api/dancers/me', requireAuth('auditionee'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, first_name, last_name, email, phone, address, grade,
              technique_classes, injuries, absences, availability
       FROM dancers WHERE user_id = $1`,
      [req.session.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'No submission found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Database error:', err.message);
    res.status(500).json({ error: 'Failed to fetch your submission.' });
  }
});

app.put('/api/dancers/me', requireAuth('auditionee'), async (req, res) => {
  const {
    first_name, last_name, email, phone, address,
    grade, technique_classes, injuries, absences, availability,
  } = req.body;

  if (!first_name || !last_name || !email) {
    return res.status(400).json({ error: 'First name, last name, and email are required.' });
  }

  try {
    const result = await pool.query(
      `UPDATE dancers SET
         first_name=$1, last_name=$2, email=$3, phone=$4, address=$5,
         grade=$6, technique_classes=$7, injuries=$8, absences=$9, availability=$10
       WHERE user_id=$11
       RETURNING id`,
      [
        first_name, last_name, email,
        phone             || null,
        address           || null,
        grade             || null,
        technique_classes || null,
        injuries          || null,
        absences          || null,
        availability      ? JSON.stringify(availability) : null,
        req.session.userId,
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'No submission found to update.' });
    res.json({ message: 'Submission updated!' });
  } catch (err) {
    console.error('Database error:', err.message);
    res.status(500).json({ error: 'Failed to update submission.' });
  }
});

app.get('/api/dancers/search', requireAuth('master'), async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim() === '') return res.json([]);
  try {
    const result = await pool.query(
      `SELECT id, first_name, last_name, availability
       FROM dancers
       WHERE LOWER(first_name || ' ' || last_name) LIKE LOWER($1)
       ORDER BY last_name, first_name
       LIMIT 10`,
      [`%${q.trim()}%`]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: 'Search failed.' });
  }
});

app.get('/api/dancers/:id', requireAuth('master'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, first_name, last_name, email, phone, address, grade,
              technique_classes, injuries, absences, availability
       FROM dancers WHERE id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Dancer not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Database error:', err.message);
    res.status(500).json({ error: 'Failed to fetch dancer.' });
  }
});

// ── Pieces routes ─────────────────────────────────────────────────────────────

app.get('/api/pieces', requireAuth('master'), async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, color FROM pieces WHERE master_id = $1 ORDER BY created_at ASC',
      [req.session.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Database error:', err.message);
    res.status(500).json({ error: 'Failed to fetch pieces.' });
  }
});

app.post('/api/pieces', requireAuth('master'), async (req, res) => {
  const { name, color } = req.body;
  if (!name || !color) return res.status(400).json({ error: 'Name and color are required.' });
  try {
    const result = await pool.query(
      'INSERT INTO pieces (name, color, master_id) VALUES ($1, $2, $3) RETURNING id, name, color',
      [name, color, req.session.userId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Database error:', err.message);
    res.status(500).json({ error: 'Failed to create piece.' });
  }
});

app.delete('/api/pieces/:id', requireAuth('master'), async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM pieces WHERE id = $1 AND master_id = $2',
      [req.params.id, req.session.userId]
    );
    res.json({ message: 'Piece deleted.' });
  } catch (err) {
    console.error('Database error:', err.message);
    res.status(500).json({ error: 'Failed to delete piece.' });
  }
});

// ── Master block routes ───────────────────────────────────────────────────────

app.get('/api/master-blocks', requireAuth('master'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT mb.id, mb.piece_id, mb.day, mb.start_time, mb.end_time
       FROM master_blocks mb
       JOIN pieces p ON p.id = mb.piece_id
       WHERE p.master_id = $1
       ORDER BY mb.created_at ASC`,
      [req.session.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Database error:', err.message);
    res.status(500).json({ error: 'Failed to fetch blocks.' });
  }
});

app.post('/api/master-blocks', requireAuth('master'), async (req, res) => {
  const { piece_id, day, start_time, end_time } = req.body;
  if (!piece_id || !day || !start_time || !end_time) {
    return res.status(400).json({ error: 'piece_id, day, start_time, and end_time are required.' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO master_blocks (piece_id, day, start_time, end_time) VALUES ($1, $2, $3, $4) RETURNING id',
      [piece_id, day, start_time, end_time]
    );
    res.status(201).json({ id: result.rows[0].id });
  } catch (err) {
    console.error('Database error:', err.message);
    res.status(500).json({ error: 'Failed to save block.' });
  }
});

app.put('/api/master-blocks/:id', requireAuth('master'), async (req, res) => {
  const { day, start_time, end_time } = req.body;
  try {
    await pool.query(
      'UPDATE master_blocks SET day = $1, start_time = $2, end_time = $3 WHERE id = $4',
      [day, start_time, end_time, req.params.id]
    );
    res.json({ message: 'Block updated.' });
  } catch (err) {
    console.error('Database error:', err.message);
    res.status(500).json({ error: 'Failed to update block.' });
  }
});

app.delete('/api/master-blocks/:id', requireAuth('master'), async (req, res) => {
  try {
    await pool.query('DELETE FROM master_blocks WHERE id = $1', [req.params.id]);
    res.json({ message: 'Block deleted.' });
  } catch (err) {
    console.error('Database error:', err.message);
    res.status(500).json({ error: 'Failed to delete block.' });
  }
});

// ── Availability route ────────────────────────────────────────────────────────

app.get('/api/availability/piece/:pieceId', requireAuth('master'), async (req, res) => {
  function timeToMinutes(timeStr) {
    const [time, ampm] = timeStr.trim().split(' ');
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

    if (pieceBlocks.length === 0) {
      return res.json({ piece_blocks: [], fully_available: [], partially_available: [] });
    }

    const dancersResult = await pool.query(
      'SELECT id, first_name, last_name, availability FROM dancers WHERE availability IS NOT NULL'
    );

    const fullyAvailable     = [];
    const partiallyAvailable = [];

    dancersResult.rows.forEach(dancer => {
      const avail = dancer.availability || [];
      let coveredCount = 0;

      pieceBlocks.forEach(block => {
        const blockStart = timeToMinutes(block.start_time);
        const blockEnd   = timeToMinutes(block.end_time);
        const covers = avail.some(ab => {
          if (ab.day !== block.day) return false;
          return timeToMinutes(ab.startTime) <= blockStart &&
                 timeToMinutes(ab.endTime)   >= blockEnd;
        });
        if (covers) coveredCount++;
      });

      const name = { id: dancer.id, first_name: dancer.first_name, last_name: dancer.last_name };
      if (coveredCount === pieceBlocks.length) fullyAvailable.push(name);
      else if (coveredCount > 0)               partiallyAvailable.push(name);
    });

    res.json({ piece_blocks: pieceBlocks, fully_available: fullyAvailable, partially_available: partiallyAvailable });
  } catch (err) {
    console.error('Database error:', err.message);
    res.status(500).json({ error: 'Failed to check availability.' });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  if (!process.env.GOOGLE_CLIENT_ID) console.log('  → Google OAuth not configured (GOOGLE_CLIENT_ID missing)');
  if (!emailEnabled)                  console.log('  → Email not configured (EMAIL_USER/EMAIL_PASS missing)');
});
