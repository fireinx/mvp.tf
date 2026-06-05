// GET /api/standings?id=LOGID
// Zwraca mapę { steamId: liczbaGłosów } dla danego meczu

import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const { id } = req.query;
  if (!id || !/^\d{4,8}$/.test(id)) return res.status(400).json({ error: 'Invalid id' });

  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS votes (
        log_id     VARCHAR(10)  NOT NULL,
        steam_id   VARCHAR(25)  NOT NULL,
        session_id VARCHAR(30)  NOT NULL,
        created_at TIMESTAMPTZ  DEFAULT NOW(),
        PRIMARY KEY (log_id, steam_id, session_id)
      )
    `);
    const { rows } = await client.query(
      `SELECT steam_id, COUNT(*)::int AS cnt
       FROM votes WHERE log_id = $1
       GROUP BY steam_id ORDER BY cnt DESC`,
      [id]
    );
    return res.status(200).json(Object.fromEntries(rows.map(r => [r.steam_id, r.cnt])));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'DB error' });
  } finally {
    client.release();
  }
}
