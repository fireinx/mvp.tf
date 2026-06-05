// POST /api/admin  { action, secret, steamId?, logId? }
// Chroniony endpoint do zarządzania danymi

import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { action, secret, steamId, logId } = req.body || {};

  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const client = await pool.connect();
  try {
    if (action === 'delete_player') {
      // Usuń wszystkie głosy gracza
      if (!steamId) return res.status(400).json({ error: 'Missing steamId' });
      const { rowCount } = await client.query(
        `DELETE FROM votes WHERE steam_id = $1`, [steamId]
      );
      return res.status(200).json({ ok: true, deleted: rowCount });
    }

    if (action === 'delete_log') {
      // Usuń wszystkie głosy z danego meczu
      if (!logId) return res.status(400).json({ error: 'Missing logId' });
      const { rowCount } = await client.query(
        `DELETE FROM votes WHERE log_id = $1`, [logId]
      );
      return res.status(200).json({ ok: true, deleted: rowCount });
    }

    if (action === 'clear_all') {
      await client.query(`TRUNCATE votes`);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'DB error' });
  } finally {
    client.release();
  }
}
