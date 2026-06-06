// GET /api/map-poll        → { poll, votes }
// POST /api/map-poll       → { sessionId, mapName }

import pkg from 'pg';
const { Pool } = pkg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const INIT = `
  CREATE TABLE IF NOT EXISTS map_polls (
    id         SERIAL      PRIMARY KEY,
    maps       TEXT[]      NOT NULL,
    active     BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS map_votes (
    poll_id    INT         NOT NULL,
    session_id VARCHAR(30) NOT NULL,
    map_name   VARCHAR(80) NOT NULL,
    PRIMARY KEY (poll_id, session_id)
  );
`;

async function getCounts(client, pollId) {
  const { rows } = await client.query(
    `SELECT map_name, COUNT(*)::int AS cnt FROM map_votes WHERE poll_id=$1 GROUP BY map_name`,
    [pollId]
  );
  return Object.fromEntries(rows.map(r => [r.map_name, r.cnt]));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const client = await pool.connect();
  try {
    await client.query(INIT);
    const { rows: polls } = await client.query(
      `SELECT * FROM map_polls WHERE active=TRUE ORDER BY created_at DESC LIMIT 1`
    );
    if (!polls.length) return res.status(200).json({ poll: null, votes: {} });
    const poll = polls[0];

    if (req.method === 'GET') {
      return res.status(200).json({ poll, votes: await getCounts(client, poll.id) });
    }

    if (req.method === 'POST') {
      const { sessionId, mapName } = req.body || {};
      if (!sessionId || !mapName)         return res.status(400).json({ error: 'Missing fields' });
      if (!poll.maps.includes(mapName))   return res.status(400).json({ error: 'Invalid map' });
      await client.query(
        `INSERT INTO map_votes (poll_id, session_id, map_name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [poll.id, sessionId, mapName]
      );
      return res.status(200).json({ ok: true, votes: await getCounts(client, poll.id) });
    }

    return res.status(405).end();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'DB error' });
  } finally {
    client.release();
  }
}
