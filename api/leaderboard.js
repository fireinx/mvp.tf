// GET /api/leaderboard?limit=20&contest=ID
// Hall of Fame (contest=undefined → tylko niewyłączone logi)
// Konkurs     (contest=ID       → tylko logi z danego konkursu)

import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const limit     = Math.min(parseInt(req.query.limit) || 20, 50);
  const contestId = req.query.contest ? parseInt(req.query.contest) : null;

  const client = await pool.connect();
  try {
    let query, params;

    if (contestId) {
      // Ranking konkursowy — tylko logi z danego konkursu
      query = `
        SELECT
          v.steam_id,
          (SELECT player_name FROM votes v2
           WHERE v2.steam_id = v.steam_id AND player_name <> ''
           ORDER BY created_at DESC LIMIT 1)    AS name,
          COUNT(*)::int                          AS total_votes,
          COUNT(DISTINCT v.log_id)::int          AS games_voted_in
        FROM votes v
        INNER JOIN contest_logs cl ON cl.log_id = v.log_id AND cl.contest_id = $2
        WHERE 1=1
        GROUP BY v.steam_id
        ORDER BY total_votes DESC
        LIMIT $1
      `;
      params = [limit, contestId];
    } else {
      // Hall of Fame — wyklucz logi oznaczone jako excluded
      query = `
        SELECT
          v.steam_id,
          (SELECT player_name FROM votes v2
           WHERE v2.steam_id = v.steam_id AND player_name <> ''
           ORDER BY created_at DESC LIMIT 1)    AS name,
          COUNT(*)::int                          AS total_votes,
          COUNT(DISTINCT v.log_id)::int          AS games_voted_in
        FROM votes v
        LEFT JOIN log_settings ls ON ls.log_id = v.log_id
        WHERE (ls.excluded IS NULL OR ls.excluded = FALSE)
        GROUP BY v.steam_id
        ORDER BY total_votes DESC
        LIMIT $1
      `;
      params = [limit];
    }

    const { rows } = await client.query(query, params);
    return res.status(200).json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'DB error' });
  } finally {
    client.release();
  }
}
