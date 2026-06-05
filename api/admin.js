// POST /api/admin  { action, secret, ...params }

import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const CONTEST_INIT = `
  CREATE TABLE IF NOT EXISTS contests (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS contest_logs (
    contest_id INT NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
    log_id VARCHAR(10) NOT NULL,
    PRIMARY KEY (contest_id, log_id)
  );
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { action, secret, steamId, logId, sessionId, contestId, contestName } = req.body || {};

  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const client = await pool.connect();
  try {
    await client.query(CONTEST_INIT);

    // ── Votes ──────────────────────────────────────────────
    if (action === 'delete_player') {
      if (!steamId) return res.status(400).json({ error: 'Missing steamId' });
      const { rowCount } = await client.query(`DELETE FROM votes WHERE steam_id = $1`, [steamId]);
      return res.status(200).json({ ok: true, deleted: rowCount });
    }

    if (action === 'delete_log') {
      if (!logId) return res.status(400).json({ error: 'Missing logId' });
      const { rowCount } = await client.query(`DELETE FROM votes WHERE log_id = $1`, [logId]);
      return res.status(200).json({ ok: true, deleted: rowCount });
    }

    if (action === 'clear_all') {
      await client.query(`TRUNCATE votes`);
      return res.status(200).json({ ok: true });
    }

    if (action === 'reset_session') {
      if (!logId || !sessionId) return res.status(400).json({ error: 'Missing logId or sessionId' });
      const { rowCount } = await client.query(
        `DELETE FROM votes WHERE log_id = $1 AND session_id = $2`, [logId, sessionId]
      );
      return res.status(200).json({ ok: true, deleted: rowCount });
    }

    // ── Log settings ───────────────────────────────────────
    if (action === 'toggle_excluded') {
      if (!logId) return res.status(400).json({ error: 'Missing logId' });
      const { rows } = await client.query(`
        INSERT INTO log_settings (log_id, excluded)
        VALUES ($1, TRUE)
        ON CONFLICT (log_id) DO UPDATE
          SET excluded = NOT log_settings.excluded
        RETURNING excluded
      `, [logId]);
      return res.status(200).json({ ok: true, excluded: rows[0].excluded });
    }

    // ── Contests ───────────────────────────────────────────
    if (action === 'create_contest') {
      if (!contestName?.trim()) return res.status(400).json({ error: 'Missing contestName' });
      const { rows } = await client.query(
        `INSERT INTO contests (name) VALUES ($1) RETURNING id, name, created_at`,
        [contestName.trim().slice(0, 100)]
      );
      return res.status(200).json({ ok: true, contest: rows[0] });
    }

    if (action === 'delete_contest') {
      if (!contestId) return res.status(400).json({ error: 'Missing contestId' });
      await client.query(`DELETE FROM contests WHERE id = $1`, [contestId]);
      return res.status(200).json({ ok: true });
    }

    if (action === 'add_log_to_contest') {
      if (!contestId || !logId) return res.status(400).json({ error: 'Missing contestId or logId' });
      await client.query(
        `INSERT INTO contest_logs (contest_id, log_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [contestId, logId]
      );
      return res.status(200).json({ ok: true });
    }

    if (action === 'delete_player_from_contest') {
      // Usuwa głosy gracza tylko z logów należących do danego konkursu
      if (!steamId || !contestId) return res.status(400).json({ error: 'Missing steamId or contestId' });
      const { rowCount } = await client.query(`
        DELETE FROM votes
        WHERE steam_id = $1
          AND log_id IN (SELECT log_id FROM contest_logs WHERE contest_id = $2)
      `, [steamId, contestId]);
      return res.status(200).json({ ok: true, deleted: rowCount });
    }

    if (action === 'remove_log_from_contest') {
      if (!contestId || !logId) return res.status(400).json({ error: 'Missing contestId or logId' });
      await client.query(
        `DELETE FROM contest_logs WHERE contest_id = $1 AND log_id = $2`, [contestId, logId]
      );
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
