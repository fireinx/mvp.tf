// GET /api/recent-global?limit=20
// Ostatnio otwarte lobby (ze wszystkich użytkowników) — tylko dla admina

import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const limit = Math.min(parseInt(req.query.limit) || 20, 50);

  const client = await pool.connect();
  try {
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
        AND v.session_id NOT LIKE 'auto:%'
      GROUP BY ls.log_id, ls.map, ls.title, ls.excluded, ls.last_seen
      ORDER BY ls.last_seen DESC
      LIMIT $1
    `, [limit]);

    return res.status(200).json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'DB error' });
  } finally {
    client.release();
  }
}
