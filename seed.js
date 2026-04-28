// Demo seed script — adds 20 mock auditionees to a specific production
// Usage:
//   DATABASE_URL="..." node seed.js <JOIN_CODE>          ← add demo dancers
//   DATABASE_URL="..." node seed.js --remove <JOIN_CODE> ← remove them
//
// Demo accounts use @demo.castsync.app emails and are safe to clean up.
// Existing real auditionees are NEVER touched.

require('dotenv').config();
const { Pool } = require('pg');
const bcrypt   = require('bcrypt');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

function fmt(h) {
  return `${h > 12 ? h - 12 : h === 0 ? 12 : h}:00 ${h >= 12 ? 'PM' : 'AM'}`;
}

function wideAvailability() {
  const blocks = [];
  const shuffled = [...DAYS].sort(() => Math.random() - 0.5);
  const count = 5 + Math.floor(Math.random() * 3); // 5–7 days
  for (let i = 0; i < count; i++) {
    const startHour = 8 + Math.floor(Math.random() * 2);       // 8 or 9 AM
    const endHour   = 21 + Math.floor(Math.random() * 3);      // 9, 10, or 11 PM
    blocks.push({ day: shuffled[i], startTime: fmt(startHour), endTime: fmt(endHour) });
  }
  return blocks;
}

const DEMO_DANCERS = [
  { first: 'Bianca',   last: 'Torres',    grade: 'Senior',    technique: 'Ballet, Jazz',           injuries: 'None',                           absences: 'None' },
  { first: 'Marcus',   last: 'Okafor',    grade: 'Junior',    technique: 'Hip Hop, Contemporary',  injuries: 'None',                           absences: 'None' },
  { first: 'Sasha',    last: 'Petrov',    grade: 'Senior',    technique: 'Contemporary, Modern',   injuries: 'None',                           absences: 'None' },
  { first: 'Jade',     last: 'Freeman',   grade: 'Sophomore', technique: 'Jazz, Ballet',           injuries: 'None',                           absences: 'None' },
  { first: 'Omar',     last: 'Hussain',   grade: 'Junior',    technique: 'Breaking, Hip Hop',      injuries: 'None',                           absences: 'None' },
  { first: 'Celeste',  last: 'Fontaine',  grade: 'Senior',    technique: 'Ballet, Contemporary',   injuries: 'None',                           absences: 'None' },
  { first: 'Darius',   last: 'Mitchell',  grade: 'Freshman',  technique: 'Tap, Jazz',              injuries: 'None',                           absences: 'None' },
  { first: 'Yuki',     last: 'Nakamura',  grade: 'Junior',    technique: 'Contemporary, Lyrical',  injuries: 'None',                           absences: 'None' },
  { first: 'Simone',   last: 'Bouchard',  grade: 'Senior',    technique: 'Modern, Ballet',         injuries: 'None',                           absences: 'March 14' },
  { first: 'Keanu',    last: 'Reyes',     grade: 'Sophomore', technique: 'Hip Hop, Breaking',      injuries: 'None',                           absences: 'None' },
  { first: 'Aria',     last: 'Sinclair',  grade: 'Junior',    technique: 'Ballet, Contemporary',   injuries: 'None',                           absences: 'None' },
  { first: 'Tobias',   last: 'Brennan',   grade: 'Senior',    technique: 'Contemporary, Modern',   injuries: 'Mild shoulder soreness',         absences: 'None' },
  { first: 'Luna',     last: 'Vega',      grade: 'Freshman',  technique: 'Jazz, Flamenco',         injuries: 'None',                           absences: 'April 2, April 9' },
  { first: 'Ezra',     last: 'Goldstein', grade: 'Junior',    technique: 'Modern, Tap',            injuries: 'None',                           absences: 'None' },
  { first: 'Destiny',  last: 'Crawford',  grade: 'Senior',    technique: 'Hip Hop, Jazz',          injuries: 'None',                           absences: 'None' },
  { first: 'Felix',    last: 'Larsson',   grade: 'Sophomore', technique: 'Contemporary, Ballet',   injuries: 'None',                           absences: 'None' },
  { first: 'Nadia',    last: 'Morozova',  grade: 'Junior',    technique: 'Ballet, Modern',         injuries: 'Knee tightness — managing',      absences: 'None' },
  { first: 'Theo',     last: 'Adeyemi',   grade: 'Senior',    technique: 'Breaking, Contemporary', injuries: 'None',                           absences: 'April 5' },
  { first: 'Isabelle', last: 'Dupont',    grade: 'Freshman',  technique: 'Jazz, Contemporary',     injuries: 'None',                           absences: 'None' },
  { first: 'Kofi',     last: 'Mensah',    grade: 'Junior',    technique: 'African, Modern',        injuries: 'None',                           absences: 'None' },
];

async function findSeason(joinCode) {
  const upper = joinCode.toUpperCase();
  const result = await pool.query(
    `SELECT s.id AS season_id, s.org_id, s.name AS season_name, o.name AS org_name
     FROM seasons s
     JOIN orgs o ON o.id = s.org_id
     WHERE s.join_code = $1`,
    [upper]
  );
  if (result.rows.length === 0) {
    console.error(`No season found with join code "${upper}". Double-check the code.`);
    process.exit(1);
  }
  return result.rows[0];
}

async function addDemoData(joinCode) {
  const { season_id, org_id, season_name, org_name } = await findSeason(joinCode);
  console.log(`Target: "${org_name}" → "${season_name}" (season ${season_id})`);
  console.log('Adding 20 demo auditionees (existing data untouched)...\n');

  const passwordHash = await bcrypt.hash('demo1234', 10);

  for (const d of DEMO_DANCERS) {
    const email = `${d.first.toLowerCase()}.${d.last.toLowerCase()}@demo.castsync.app`;
    try {
      // Upsert user account
      const userResult = await pool.query(
        `INSERT INTO users (email, password_hash, role, email_verified)
         VALUES ($1, $2, 'auditionee', TRUE)
         ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
         RETURNING id`,
        [email, passwordHash]
      );
      const userId = userResult.rows[0].id;

      // Upsert dancer profile
      await pool.query(
        `INSERT INTO dancer_profiles (user_id, first_name, last_name, phone, address, grade, technique_classes, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           first_name=$2, last_name=$3, phone=$4, address=$5, grade=$6, technique_classes=$7, updated_at=NOW()`,
        [userId, d.first, d.last, '555-000-0000', '1 Demo Lane', d.grade, d.technique]
      );

      // Upsert submission for this specific season only
      const availability = wideAvailability();
      await pool.query(
        `INSERT INTO submissions (user_id, org_id, season_id, injuries, absences, availability)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (user_id, season_id) DO UPDATE SET injuries=$4, absences=$5, availability=$6`,
        [userId, org_id, season_id, d.injuries, d.absences, JSON.stringify(availability)]
      );

      console.log(`  ✓ ${d.first} ${d.last} <${email}>`);
    } catch (err) {
      console.error(`  ✗ ${d.first} ${d.last}: ${err.message}`);
    }
  }

  console.log('\nDone! All demo accounts use password: demo1234');
  console.log('Run with --remove to clean them up later.\n');
}

async function removeDemoData(joinCode) {
  const { season_id, season_name, org_name } = await findSeason(joinCode);
  console.log(`Removing demo data from "${org_name}" → "${season_name}"...`);

  // Get demo user IDs
  const users = await pool.query(
    `SELECT id FROM users WHERE email LIKE '%@demo.castsync.app'`
  );
  const ids = users.rows.map(r => r.id);
  if (ids.length === 0) { console.log('No demo accounts found.'); return; }

  // Remove their submissions for this season
  const del = await pool.query(
    `DELETE FROM submissions WHERE season_id = $1 AND user_id = ANY($2::int[]) RETURNING user_id`,
    [season_id, ids]
  );
  console.log(`Removed ${del.rows.length} demo submissions from this season.`);

  // Remove piece_casts for this season's pieces
  await pool.query(
    `DELETE FROM piece_casts
     WHERE user_id = ANY($1::int[])
       AND piece_id IN (SELECT id FROM pieces WHERE season_id = $2)`,
    [ids, season_id]
  );

  // Remove demo accounts that have NO remaining submissions anywhere
  const cleaned = await pool.query(
    `DELETE FROM users
     WHERE id = ANY($1::int[])
       AND NOT EXISTS (SELECT 1 FROM submissions WHERE user_id = users.id)
     RETURNING email`,
    [ids]
  );
  if (cleaned.rows.length > 0) {
    console.log(`Deleted ${cleaned.rows.length} demo accounts with no remaining submissions.`);
  } else {
    console.log('Demo accounts kept (they have submissions in other seasons).');
  }
  console.log('Done.\n');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args[0] === '--remove' && args.length < 2)) {
    console.log('Usage:');
    console.log('  DATABASE_URL="..." node seed.js <JOIN_CODE>          ← add demo dancers');
    console.log('  DATABASE_URL="..." node seed.js --remove <JOIN_CODE> ← remove them');
    process.exit(1);
  }

  try {
    if (args[0] === '--remove') {
      await removeDemoData(args[1]);
    } else {
      await addDemoData(args[0]);
    }
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

main();
