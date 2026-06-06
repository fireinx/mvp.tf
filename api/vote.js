// POST /api/vote  { logId, steamId, playerName, sessionId, adminSecret? }

import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const INIT_SQL = `
  CREATE TABLE IF NOT EXISTS votes (
    log_id      VARCHAR(10)   NOT NULL,
    steam_id    VARCHAR(25)   NOT NULL,
    session_id  VARCHAR(50)   NOT NULL,
    player_name VARCHAR(100)  NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ   DEFAULT NOW(),
    PRIMARY KEY (log_id, steam_id, session_id)
  );
  ALTER TABLE votes ADD COLUMN IF NOT EXISTS player_name VARCHAR(100) NOT NULL DEFAULT '';
  CREATE TABLE IF NOT EXISTS session_profiles (
    session_id VARCHAR(50) PRIMARY KEY,
    steam_id   VARCHAR(25) UNIQUE,
    claimed_at TIMESTAMPTZ DEFAULT NOW()
  );
`;

// Steam3 [U:1:XXXXXXX] → Steam64 (tak jak frontend)
function toSteam64(id) {
  if (/^\d{17}$/.test(id)) return id;
  const m = String(id).match(/\[U:1:(\d+)\]/);
  if (m) return (BigInt('76561197960265728') + BigInt(m[1])).toString();
  return id;
}

async function getStandings(client, logId) {
  const { rows } = await client.query(
    `SELECT steam_id, COUNT(*)::int AS cnt
     FROM votes WHERE log_id = $1
     GROUP BY steam_id ORDER BY cnt DESC`,
    [logId]
  );
  return Object.fromEntries(rows.map(r => [r.steam_id, r.cnt]));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { logId, steamId, playerName = '', sessionId, adminSecret } = req.body || {};

  if (!logId || !/^\d{4,8}$/.test(logId)) return res.status(400).json({ error: 'Invalid logId' });
  if (!steamId || !sessionId)              return res.status(400).json({ error: 'Missing fields' });

  const isAdmin = adminSecret && adminSecret === process.env.ADMIN_SECRET;
  const isAuto  = String(sessionId).startsWith('auto:');

  const client = await pool.connect();
  try {
    await client.query(INIT_SQL);

    // Limit głosów i self-vote: pomijamy dla admina i auto-głosów
    if (!isAdmin && !isAuto) {
      const { rows: check } = await client.query(
        `SELECT COUNT(*)::int AS cnt FROM votes WHERE log_id = $1 AND session_id = $2`,
        [logId, sessionId]
      );
      if (check[0].cnt >= 3) {
        const standings = await getStandings(client, logId);
        return res.status(200).json({ ok: false, reason: 'max_votes', standings });
      }

      // Blokada głosowania na siebie — sprawdzamy czy sesja ma przypisany ten profil
      const steam64 = toSteam64(steamId);
      const { rows: profile } = await client.query(
        'SELECT steam_id FROM session_profiles WHERE session_id = $1',
        [sessionId]
      );
      if (profile.length > 0 && profile[0].steam_id === steam64) {
        const standings = await getStandings(client, logId);
        return res.status(200).json({ ok: false, reason: 'self_vote', standings });
      }
    }

    await client.query(
      `INSERT INTO votes (log_id, steam_id, session_id, player_name)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [logId, steamId, sessionId, playerName.slice(0, 100)]
    );

    const standings = await getStandings(client, logId);
    return res.status(200).json({ ok: true, standings });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'DB error' });
  } finally {
    client.release();
  }
}
