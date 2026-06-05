// POST /api/vote  { logId, steamId, sessionId }
// Zapisuje głos w Postgres i zwraca aktualne wyniki dla danego logu

import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const INIT_SQL = `
  CREATE TABLE IF NOT EXISTS votes (
    log_id     VARCHAR(10)  NOT NULL,
    steam_id   VARCHAR(25)  NOT NULL,
    session_id VARCHAR(30)  NOT NULL,
    created_at TIMESTAMPTZ  DEFAULT NOW(),
    PRIMARY KEY (log_id, steam_id, session_id)
  )
`;

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

  const { logId, steamId, sessionId } = req.body || {};

  if (!logId || !/^\d{4,8}$/.test(logId))   return res.status(400).json({ error: 'Invalid logId' });
  if (!steamId || !sessionId)                 return res.status(400).json({ error: 'Missing fields' });

  const client = await pool.connect();
  try {
    await client.query(INIT_SQL);

    // Max 3 głosy per sesja per mecz
    const { rows: check } = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM votes WHERE log_id = $1 AND session_id = $2`,
      [logId, sessionId]
    );
    if (check[0].cnt >= 3) {
      const standings = await getStandings(client, logId);
      return res.status(200).json({ ok: false, reason: 'max_votes', standings });
    }

    // ON CONFLICT DO NOTHING — ten sam głos nie wejdzie dwa razy
    await client.query(
      `INSERT INTO votes (log_id, steam_id, session_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [logId, steamId, sessionId]
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
