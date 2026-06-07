// GET /api/recent-global?limit=20

import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const INIT_SQL = `
  CREATE TABLE IF NOT EXISTS log_settings (
    log_id     VARCHAR(10)  PRIMARY KEY,
    map        VARCHAR(80)  NOT NULL DEFAULT '',
    title      VARCHAR(120) NOT NULL DEFAULT '',
    excluded   BOOLEAN      NOT NULL DEFAULT FALSE,
    first_seen TIMESTAMPTZ  DEFAULT NOW(),
    last_seen  TIMESTAMPTZ  DEFAULT NOW()
  )
`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const limit = Math.min(parseInt(req.query.limit) || 20, 50);

  const client = await pool.connect();
  try {
    await client.query(INIT_SQL);

    // Pokaż tylko logi first_seen od daty startowej (domyślnie 2026-06-01)
    const since = process.env.RECENT_SINCE || '2026-06-01';

    const { rows } = await client.query(`
      SELECT
        ls.log_id,
        ls.map,
        ls.title,
        ls.excluded,
        ls.last_seen,
        COUNT(DISTINCT v.session_id)::int AS vote_sessions,
        COUNT(v.*)::int                   AS total_votes
      FROM log_settings ls
      LEFT JOIN votes v ON v.log_id = ls.log_id
      WHERE ls.first_seen >= $2
      GROUP BY ls.log_id, ls.map, ls.title, ls.excluded, ls.last_seen
      ORDER BY ls.last_seen DESC
      LIMIT $1
    `, [limit, since]);

    return res.status(200).json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'DB error' });
  } finally {
    client.release();
  }
}
