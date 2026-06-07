// GET /api/sync-logs
// Pobiera ostatnie logi ADMIN_STEAM_ID z logs.tf i upsertuje do log_settings.
// Nie wymaga autoryzacji — dane publiczne, używane przez frontend admina co ~60s.
// Env var: ADMIN_STEAM_ID=76561198XXXXXXX

import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const INIT = `
  CREATE TABLE IF NOT EXISTS log_settings (
    log_id     VARCHAR(10)  PRIMARY KEY,
    map        VARCHAR(80)  NOT NULL DEFAULT '',
    title      VARCHAR(120) NOT NULL DEFAULT '',
    excluded   BOOLEAN      NOT NULL DEFAULT FALSE,
    first_seen TIMESTAMPTZ  DEFAULT NOW(),
    last_seen  TIMESTAMPTZ  DEFAULT NOW()
  );
`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).end();

  const adminSteamId = process.env.ADMIN_STEAM_ID;
  if (!adminSteamId) return res.status(200).json({ synced: 0, logIds: [], reason: 'ADMIN_STEAM_ID not set' });

  try {
    // Pobierz ostatnie logi z logs.tf dla adminowego steam_id
    const r = await fetch(
      `https://logs.tf/api/v1/log?player=${adminSteamId}&limit=15`,
      { headers: { 'User-Agent': 'mvp.tf/1.0' } }
    );
    if (!r.ok) return res.status(200).json({ synced: 0, logIds: [], reason: `logs.tf error ${r.status}` });
    const data = await r.json();
    if (!data.success || !Array.isArray(data.logs)) return res.status(200).json({ synced: 0, logIds: [] });

    const client = await pool.connect();
    try {
      await client.query(INIT);

      let synced = 0;
      const logIds = [];
      for (const log of data.logs) {
        const logId = String(log.id);
        const map   = log.map   || '';
        const title = log.title || '';

        // Upsert — first_seen nie zmienia się przy konflikcie
        const { rowCount } = await client.query(`
          INSERT INTO log_settings (log_id, map, title, last_seen)
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT (log_id) DO UPDATE SET
            map       = CASE WHEN EXCLUDED.map <> '' THEN EXCLUDED.map ELSE log_settings.map END,
            title     = CASE WHEN EXCLUDED.title <> '' THEN EXCLUDED.title ELSE log_settings.title END,
            last_seen = NOW()
        `, [logId, map, title]);

        logIds.push(logId);
        if (rowCount > 0) synced++;
      }

      return res.status(200).json({ synced, logIds });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('sync-logs error:', err);
    return res.status(500).json({ error: 'sync failed' });
  }
}
