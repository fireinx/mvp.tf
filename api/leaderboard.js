// GET /api/leaderboard?limit=20
// Globalny ranking graczy ze wszystkich meczów

import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate');

  const limit = Math.min(parseInt(req.query.limit) || 20, 50);

  const client = await pool.connect();
  try {
    const { rows } = await client.query(`
      SELECT
        steam_id,
        -- Najnowsza znana nazwa gracza
        (SELECT player_name FROM votes v2
         WHERE v2.steam_id = v.steam_id AND player_name <> ''
         ORDER BY created_at DESC LIMIT 1) AS name,
        COUNT(*)::int                       AS total_votes,
        COUNT(DISTINCT log_id)::int         AS games_voted_in
      FROM votes v
      GROUP BY steam_id
      ORDER BY total_votes DESC
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
