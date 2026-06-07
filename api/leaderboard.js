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
    await client.query(`
      CREATE TABLE IF NOT EXISTS contest_exclusions (
        contest_id INT NOT NULL,
        steam_id   VARCHAR(25) NOT NULL,
        PRIMARY KEY (contest_id, steam_id)
      )
    `);
    let query, params;

    // Upewnij się że log_players istnieje
    await client.query(`
      CREATE TABLE IF NOT EXISTS log_players (
        log_id      VARCHAR(10)  NOT NULL,
        steam_id    VARCHAR(25)  NOT NULL,
        player_name VARCHAR(100) NOT NULL DEFAULT '',
        PRIMARY KEY (log_id, steam_id)
      )
    `);

    if (contestId) {
      // Ranking konkursowy — głosy z logów danego konkursu
      // games_played = logi w konkursie gdzie gracz był obecny (log_players)
      query = `
        SELECT
          v.steam_id,
          COALESCE(
            (SELECT lp.player_name FROM log_players lp
             WHERE lp.steam_id = v.steam_id AND lp.player_name <> ''
             LIMIT 1),
            (SELECT v2.player_name FROM votes v2
             WHERE v2.steam_id = v.steam_id AND v2.player_name <> ''
             ORDER BY v2.created_at DESC LIMIT 1)
          )                                        AS name,
          COUNT(*)::int                            AS total_votes,
          (SELECT COUNT(DISTINCT lp.log_id)::int
           FROM log_players lp
           INNER JOIN contest_logs cl2 ON cl2.log_id = lp.log_id AND cl2.contest_id = $2
           WHERE lp.steam_id = v.steam_id)         AS games_voted_in
        FROM votes v
        INNER JOIN contest_logs cl ON cl.log_id = v.log_id AND cl.contest_id = $2
        WHERE NOT EXISTS (
          SELECT 1 FROM contest_exclusions ce
          WHERE ce.contest_id = $2 AND ce.steam_id = v.steam_id
        )
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
          COALESCE(
            (SELECT lp.player_name FROM log_players lp
             WHERE lp.steam_id = v.steam_id AND lp.player_name <> ''
             LIMIT 1),
            (SELECT v2.player_name FROM votes v2
             WHERE v2.steam_id = v.steam_id AND v2.player_name <> ''
             ORDER BY v2.created_at DESC LIMIT 1)
          )                                        AS name,
          COUNT(*)::int                            AS total_votes,
          (SELECT COUNT(DISTINCT lp.log_id)::int
           FROM log_players lp
           LEFT JOIN log_settings ls2 ON ls2.log_id = lp.log_id
           WHERE lp.steam_id = v.steam_id
             AND (ls2.excluded IS NULL OR ls2.excluded = FALSE)) AS games_voted_in
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
