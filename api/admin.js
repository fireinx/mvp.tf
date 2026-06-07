// POST /api/admin  { action, secret, ...params }
// lub auth przez profil: { action, sessionId, adminSteamId, ...params }

import pkg from 'pg';
const { Pool } = pkg;
import { createNewPoll } from './map-poll.js';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const CONTEST_INIT = `
  CREATE TABLE IF NOT EXISTS admin_profiles (
    steam_id VARCHAR(25) PRIMARY KEY,
    added_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS session_profiles (
    session_id VARCHAR(50) PRIMARY KEY,
    steam_id   VARCHAR(25) UNIQUE,
    claimed_at TIMESTAMPTZ DEFAULT NOW()
  );
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
  CREATE TABLE IF NOT EXISTS contest_exclusions (
    contest_id INT        NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
    steam_id   VARCHAR(25) NOT NULL,
    PRIMARY KEY (contest_id, steam_id)
  );
`;

// Sprawdza autoryzację: URL secret LUB profil admina
async function checkAuth(client, body) {
  const { secret, sessionId: sid, adminSteamId } = body || {};
  if (secret && secret === process.env.ADMIN_SECRET) return true;
  if (sid && adminSteamId) {
    const { rows } = await client.query(`
      SELECT 1 FROM session_profiles sp
      JOIN admin_profiles ap ON ap.steam_id = sp.steam_id
      WHERE sp.session_id = $1 AND sp.steam_id = $2
    `, [sid, adminSteamId]);
    return rows.length > 0;
  }
  return false;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { action, secret, steamId, logId, sessionId, contestId, contestName, adminSteamId } = req.body || {};

  const client = await pool.connect();
  try {
    await client.query(CONTEST_INIT);

    if (!(await checkAuth(client, req.body))) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

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
      // Wyklucza gracza z rankingu konkursowego BEZ usuwania głosów (HoF nienaruszone)
      if (!steamId || !contestId) return res.status(400).json({ error: 'Missing steamId or contestId' });
      await client.query(`
        INSERT INTO contest_exclusions (contest_id, steam_id) VALUES ($1, $2) ON CONFLICT DO NOTHING
      `, [contestId, steamId]);
      return res.status(200).json({ ok: true });
    }

    if (action === 'clear_contest_players') {
      // Wyklucza wszystkich graczy z danego rankingu konkursowego
      if (!contestId) return res.status(400).json({ error: 'Missing contestId' });
      await client.query(`
        INSERT INTO contest_exclusions (contest_id, steam_id)
        SELECT DISTINCT $1, steam_id FROM votes
        WHERE log_id IN (SELECT log_id FROM contest_logs WHERE contest_id = $1)
        ON CONFLICT DO NOTHING
      `, [contestId]);
      return res.status(200).json({ ok: true });
    }

    if (action === 'remove_log_from_contest') {
      if (!contestId || !logId) return res.status(400).json({ error: 'Missing contestId or logId' });
      await client.query(
        `DELETE FROM contest_logs WHERE contest_id = $1 AND log_id = $2`, [contestId, logId]
      );
      return res.status(200).json({ ok: true });
    }

    if (action === 'fix_missing_names') {
      // Dla każdego steam_id bez nazwy — znajdź log i uzupełnij
      const { rows: nameless } = await client.query(`
        SELECT DISTINCT steam_id FROM votes WHERE player_name = '' OR player_name IS NULL LIMIT 100
      `);
      if (!nameless.length) return res.status(200).json({ ok: true, fixed: 0 });

      let fixed = 0;
      for (const { steam_id } of nameless) {
        const { rows: logs } = await client.query(
          `SELECT DISTINCT log_id FROM votes WHERE steam_id=$1 LIMIT 3`, [steam_id]
        );
        let found = false;
        for (const { log_id } of logs) {
          try {
            const r = await fetch(`https://logs.tf/api/v1/log/${log_id}`,
              { headers: { 'User-Agent': 'mvp.tf/1.0' } });
            if (!r.ok) continue;
            const data = await r.json();
            const name = data.names?.[steam_id];
            if (name) {
              await client.query(
                `UPDATE votes SET player_name=$1 WHERE steam_id=$2 AND (player_name='' OR player_name IS NULL)`,
                [name.slice(0, 100), steam_id]
              );
              fixed++;
              found = true;
              break;
            }
          } catch {}
        }
      }
      return res.status(200).json({ ok: true, fixed, total: nameless.length });
    }

    if (action === 'create_map_poll') {
      // Używa createNewPoll z map-poll.js: losuje mapę wykluczając zwycięzców ostatnich 12h
      const poll = await createNewPoll(client);
      return res.status(200).json({ ok: true, poll });
    }

    // ── Admin profiles ─────────────────────────────────────
    if (action === 'add_admin') {
      if (!steamId) return res.status(400).json({ error: 'Missing steamId' });
      await client.query(
        `INSERT INTO admin_profiles (steam_id) VALUES ($1) ON CONFLICT DO NOTHING`, [steamId]
      );
      return res.status(200).json({ ok: true });
    }

    if (action === 'remove_admin') {
      if (!steamId) return res.status(400).json({ error: 'Missing steamId' });
      await client.query(`DELETE FROM admin_profiles WHERE steam_id=$1`, [steamId]);
      return res.status(200).json({ ok: true });
    }

    if (action === 'list_admins') {
      const { rows } = await client.query(
        `SELECT ap.steam_id, sp.session_id, ap.added_at
         FROM admin_profiles ap
         LEFT JOIN session_profiles sp ON sp.steam_id = ap.steam_id
         ORDER BY ap.added_at`
      );
      return res.status(200).json({ ok: true, admins: rows });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'DB error' });
  } finally {
    client.release();
  }
}
