// Vercel Serverless Function — proxy do logs.tf API + tracking otwarć

import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const INIT_SQL = `
  CREATE TABLE IF NOT EXISTS log_settings (
    log_id    VARCHAR(10)  PRIMARY KEY,
    map       VARCHAR(80)  NOT NULL DEFAULT '',
    title     VARCHAR(120) NOT NULL DEFAULT '',
    excluded  BOOLEAN      NOT NULL DEFAULT FALSE,
    first_seen TIMESTAMPTZ DEFAULT NOW(),
    last_seen  TIMESTAMPTZ DEFAULT NOW()
  )
`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { id } = req.query;
  if (!id || !/^\d{4,8}$/.test(id)) {
    return res.status(400).json({ success: false, error: 'Invalid log ID' });
  }

  try {
    const response = await fetch(`https://logs.tf/api/v1/log/${id}`, {
      headers: { 'User-Agent': 'mvp.tf/1.0', 'Accept': 'application/json' },
    });

    if (!response.ok) {
      return res.status(response.status).json({ success: false, error: `logs.tf returned ${response.status}` });
    }

    const data = await response.json();

    // Zapisz/zaktualizuj log_settings
    const map   = data.info?.map   || '';
    const title = data.info?.title || '';
    try {
      const client2 = await pool.connect();
      try {
        await client2.query(INIT_SQL);
        await client2.query(`
          INSERT INTO log_settings (log_id, map, title, last_seen)
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT (log_id) DO UPDATE
            SET last_seen = NOW(),
                map   = EXCLUDED.map,
                title = EXCLUDED.title
        `, [id, map, title]);
      } finally { client2.release(); }
    } catch (e) { console.error('log_settings insert failed:', e.message); }

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ success: false, error: 'Connection error' });
  }
}
