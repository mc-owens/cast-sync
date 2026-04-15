// Demo seed script — run once to wipe old data and create 20 mock auditionees
// Usage: DATABASE_URL="your-public-url" node seed.js

require('dotenv').config();
const { Pool } = require('pg');
const bcrypt   = require('bcrypt');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

function randomAvailability() {
  // Each dancer gets 3-5 random availability blocks across different days
  const blocks = [];
  const usedDays = new Set();
  const count = 3 + Math.floor(Math.random() * 3);
  while (blocks.length < count) {
    const day = DAYS[Math.floor(Math.random() * 7)];
    if (usedDays.has(day)) continue;
    usedDays.add(day);
    // Random start between 8am and 6pm, 1-4 hour block
    const startHour = 8 + Math.floor(Math.random() * 10);
    const duration  = 1 + Math.floor(Math.random() * 4);
    const endHour   = Math.min(startHour + duration, 23);
    const fmt = h => `${h > 12 ? h - 12 : h === 0 ? 12 : h}:00 ${h >= 12 ? 'PM' : 'AM'}`;
    blocks.push({ day, startTime: fmt(startHour), endTime: fmt(endHour) });
  }
  return blocks;
}

function wideAvailability() {
  // Demo dancers: 5-7 days, each with a large block (8 AM – 11 PM range)
  const blocks = [];
  const shuffled = [...DAYS].sort(() => Math.random() - 0.5);
  const count = 5 + Math.floor(Math.random() * 3); // 5, 6, or 7 days
  const fmt = h => `${h > 12 ? h - 12 : h === 0 ? 12 : h}:00 ${h >= 12 ? 'PM' : 'AM'}`;
  for (let i = 0; i < count; i++) {
    const startHour = 8 + Math.floor(Math.random() * 2); // 8 or 9 AM
    const endHour   = 21 + Math.floor(Math.random() * 3); // 9, 10, or 11 PM
    blocks.push({ day: shuffled[i], startTime: fmt(startHour), endTime: fmt(endHour) });
  }
  return blocks;
}

const wideDancers = [
  { first: 'Bianca',   last: 'Torres',     grade: 'Senior',    technique: 'Ballet, Jazz',          injuries: 'None', absences: 'None' },
  { first: 'Marcus',   last: 'Okafor',     grade: 'Junior',    technique: 'Hip Hop, Contemporary', injuries: 'None', absences: 'None' },
  { first: 'Sasha',    last: 'Petrov',     grade: 'Senior',    technique: 'Contemporary, Modern',  injuries: 'None', absences: 'None' },
  { first: 'Jade',     last: 'Freeman',    grade: 'Sophomore', technique: 'Jazz, Ballet',           injuries: 'None', absences: 'None' },
  { first: 'Omar',     last: 'Hussain',    grade: 'Junior',    technique: 'Breaking, Hip Hop',     injuries: 'None', absences: 'None' },
  { first: 'Celeste',  last: 'Fontaine',   grade: 'Senior',    technique: 'Ballet, Contemporary',  injuries: 'None', absences: 'None' },
  { first: 'Darius',   last: 'Mitchell',   grade: 'Freshman',  technique: 'Tap, Jazz',             injuries: 'None', absences: 'None' },
  { first: 'Yuki',     last: 'Nakamura',   grade: 'Junior',    technique: 'Contemporary, Lyrical', injuries: 'None', absences: 'None' },
  { first: 'Simone',   last: 'Bouchard',   grade: 'Senior',    technique: 'Modern, Ballet',        injuries: 'None', absences: 'None' },
  { first: 'Keanu',    last: 'Reyes',      grade: 'Sophomore', technique: 'Hip Hop, Breaking',     injuries: 'None', absences: 'None' },
  { first: 'Aria',     last: 'Sinclair',   grade: 'Junior',    technique: 'Ballet, Contemporary',  injuries: 'None', absences: 'None' },
  { first: 'Tobias',   last: 'Brennan',    grade: 'Senior',    technique: 'Contemporary, Modern',  injuries: 'None', absences: 'None' },
  { first: 'Luna',     last: 'Vega',       grade: 'Freshman',  technique: 'Jazz, Flamenco',        injuries: 'None', absences: 'None' },
  { first: 'Ezra',     last: 'Goldstein',  grade: 'Junior',    technique: 'Modern, Tap',           injuries: 'None', absences: 'None' },
  { first: 'Destiny',  last: 'Crawford',   grade: 'Senior',    technique: 'Hip Hop, Jazz',         injuries: 'None', absences: 'None' },
  { first: 'Felix',    last: 'Larsson',    grade: 'Sophomore', technique: 'Contemporary, Ballet',  injuries: 'None', absences: 'None' },
  { first: 'Nadia',    last: 'Morozova',   grade: 'Junior',    technique: 'Ballet, Modern',        injuries: 'None', absences: 'None' },
  { first: 'Theo',     last: 'Adeyemi',    grade: 'Senior',    technique: 'Breaking, Contemporary',injuries: 'None', absences: 'None' },
  { first: 'Isabelle', last: 'Dupont',     grade: 'Freshman',  technique: 'Jazz, Contemporary',    injuries: 'None', absences: 'None' },
  { first: 'Kofi',     last: 'Mensah',     grade: 'Junior',    technique: 'African, Modern',       injuries: 'None', absences: 'None' },
];

const dancers = [
  { first: 'Sofia',    last: 'Martinez',   grade: 'Senior',    technique: 'Ballet, Contemporary', injuries: 'None', absences: 'March 14' },
  { first: 'James',    last: 'Chen',        grade: 'Junior',    technique: 'Jazz, Hip Hop',        injuries: 'Minor ankle sprain (healed)', absences: 'None' },
  { first: 'Aaliyah',  last: 'Johnson',     grade: 'Senior',    technique: 'Modern, Ballet',       injuries: 'None', absences: 'April 2, April 9' },
  { first: 'Noah',     last: 'Kim',         grade: 'Sophomore', technique: 'Contemporary, Tap',    injuries: 'None', absences: 'None' },
  { first: 'Isabella', last: 'Patel',       grade: 'Freshman',  technique: 'Ballet',               injuries: 'None', absences: 'March 28' },
  { first: 'Liam',     last: 'Thompson',    grade: 'Senior',    technique: 'Hip Hop, Breaking',    injuries: 'None', absences: 'None' },
  { first: 'Amara',    last: 'Williams',    grade: 'Junior',    technique: 'Modern, Jazz',         injuries: 'Knee soreness — cleared by doctor', absences: 'None' },
  { first: 'Ethan',    last: 'Rivera',      grade: 'Senior',    technique: 'Ballet, Contemporary', injuries: 'None', absences: 'April 5' },
  { first: 'Priya',    last: 'Nair',        grade: 'Sophomore', technique: 'Kathak, Contemporary', injuries: 'None', absences: 'None' },
  { first: 'Marcus',   last: 'Davis',       grade: 'Junior',    technique: 'Jazz, Tap',            injuries: 'None', absences: 'March 21' },
  { first: 'Zoe',      last: 'Anderson',    grade: 'Senior',    technique: 'Contemporary, Ballet', injuries: 'None', absences: 'None' },
  { first: 'Caleb',    last: 'Brown',       grade: 'Freshman',  technique: 'Hip Hop',              injuries: 'None', absences: 'None' },
  { first: 'Mia',      last: 'Garcia',      grade: 'Junior',    technique: 'Flamenco, Modern',     injuries: 'Wrist strain — mild', absences: 'None' },
  { first: 'Jordan',   last: 'Lee',         grade: 'Senior',    technique: 'Ballet, Jazz',         injuries: 'None', absences: 'April 12' },
  { first: 'Camille',  last: 'Tremblay',    grade: 'Sophomore', technique: 'Contemporary',         injuries: 'None', absences: 'None' },
  { first: 'Elijah',   last: 'Washington',  grade: 'Junior',    technique: 'Breaking, Hip Hop',    injuries: 'None', absences: 'March 7' },
  { first: 'Nia',      last: 'Robinson',    grade: 'Senior',    technique: 'Modern, African',      injuries: 'None', absences: 'None' },
  { first: 'Ryan',     last: 'Murphy',      grade: 'Freshman',  technique: 'Tap, Jazz',            injuries: 'None', absences: 'None' },
  { first: 'Leila',    last: 'Hassan',      grade: 'Junior',    technique: 'Contemporary, Ballet', injuries: 'Hamstring tightness — managing', absences: 'None' },
  { first: 'Daniel',   last: 'Park',        grade: 'Senior',    technique: 'Ballet, Contemporary', injuries: 'None', absences: 'April 3' },
];

async function seed() {
  console.log('Connecting to database...');

  try {
    // ── 1. Wipe old auditionee data ────────────────────────────────────────
    console.log('Wiping old submissions and auditionee accounts...');
    await pool.query(`DELETE FROM submissions`);
    await pool.query(`DELETE FROM dancer_profiles`);
    // Delete auditionee users (keep masters)
    await pool.query(`DELETE FROM users WHERE role = 'auditionee'`);
    console.log('Old data cleared.');

    // ── 2. Find or create a demo org + season ─────────────────────────────
    let orgId, seasonId;
    const existingOrg = await pool.query(`SELECT id FROM orgs WHERE join_code = 'B7DFA2' LIMIT 1`);
    if (existingOrg.rows.length > 0) {
      orgId = existingOrg.rows[0].id;
      console.log(`Using existing org id=${orgId}`);
      const existingSeason = await pool.query(
        `SELECT id FROM seasons WHERE org_id = $1 AND is_active = TRUE LIMIT 1`, [orgId]
      );
      if (existingSeason.rows.length > 0) {
        seasonId = existingSeason.rows[0].id;
        console.log(`Using existing season id=${seasonId}`);
      } else {
        const s = await pool.query(
          `INSERT INTO seasons (org_id, name, is_active) VALUES ($1, 'Demo Season', TRUE) RETURNING id`, [orgId]
        );
        seasonId = s.rows[0].id;
        console.log(`Created demo season id=${seasonId}`);
      }
    } else {
      console.log('No org found — creating a demo org. Log in as director first, then rerun this script.');
      process.exit(1);
    }

    // ── 3. Create 20 mock auditionees ─────────────────────────────────────
    const passwordHash = await bcrypt.hash('demo1234', 12);
    console.log('Creating 20 mock auditionees...');

    for (const d of dancers) {
      const email = `${d.first.toLowerCase()}.${d.last.toLowerCase()}@demo.castsync.app`;

      // Create user
      const userResult = await pool.query(
        `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'auditionee')
         ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
         RETURNING id`,
        [email, passwordHash]
      );
      const userId = userResult.rows[0].id;

      // Create profile
      await pool.query(
        `INSERT INTO dancer_profiles (user_id, first_name, last_name, phone, address, grade, technique_classes, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           first_name=$2, last_name=$3, phone=$4, address=$5, grade=$6, technique_classes=$7, updated_at=NOW()`,
        [userId, d.first, d.last, '555-000-0000', '123 Demo St', d.grade, d.technique]
      );

      // Create submission
      const availability = randomAvailability();
      await pool.query(
        `INSERT INTO submissions (user_id, org_id, season_id, injuries, absences, availability)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (user_id, season_id) DO UPDATE SET injuries=$4, absences=$5, availability=$6`,
        [userId, orgId, seasonId, d.injuries, d.absences, JSON.stringify(availability)]
      );

      console.log(`  ✓ ${d.first} ${d.last} (${email})`);
    }

    // ── 4. Create 20 wide-availability demo dancers ───────────────────────────
    console.log('\nCreating 20 wide-availability demo dancers...');

    for (const d of wideDancers) {
      const email = `${d.first.toLowerCase()}.${d.last.toLowerCase()}@demo.castsync.app`;

      const userResult = await pool.query(
        `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'auditionee')
         ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
         RETURNING id`,
        [email, passwordHash]
      );
      const userId = userResult.rows[0].id;

      await pool.query(
        `INSERT INTO dancer_profiles (user_id, first_name, last_name, phone, address, grade, technique_classes, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           first_name=$2, last_name=$3, phone=$4, address=$5, grade=$6, technique_classes=$7, updated_at=NOW()`,
        [userId, d.first, d.last, '555-000-0000', '123 Demo St', d.grade, d.technique]
      );

      const availability = wideAvailability();
      await pool.query(
        `INSERT INTO submissions (user_id, org_id, season_id, injuries, absences, availability)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (user_id, season_id) DO UPDATE SET injuries=$4, absences=$5, availability=$6`,
        [userId, orgId, seasonId, d.injuries, d.absences, JSON.stringify(availability)]
      );

      console.log(`  ✓ ${d.first} ${d.last} (${email})`);
    }

    console.log('\nDone! 40 mock auditionees created (20 sparse + 20 wide availability).');
    console.log('All demo accounts use password: demo1234');
  } catch (err) {
    console.error('Seed error:', err.message);
  } finally {
    await pool.end();
  }
}

seed();
