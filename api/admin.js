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
  CREATE TABLE IF NOT EXISTS contest_exclusions (
    contest_id INT        NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
    steam_id   VARCHAR(25) NOT NULL,
    PRIMARY KEY (contest_id, steam_id)
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
      await client.query(`
        CREATE TABLE IF NOT EXISTS map_polls (
          id SERIAL PRIMARY KEY, maps TEXT[] NOT NULL,
          active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS map_votes (
          poll_id INT NOT NULL, session_id VARCHAR(30) NOT NULL,
          map_name VARCHAR(80) NOT NULL, PRIMARY KEY (poll_id, session_id)
        );
      `);

      const MAP_POOL = {
        payload: ['pl_upward_f12','pl_vigil_rc10','pl_problitz_rc2','pl_borneo_f2',
                  'pl_cornwater_b8d','pl_prowater_b12','pl_swiftwater_final1','pl_summercoast_rc8e'],
        koth:    ['koth_product_final','koth_warmtic_f10','koth_cascade_rc2','koth_proplant_v8',
                  'koth_ashville_final1','koth_coalplant_b8','koth_proot_b6b','koth_daenam_b12','koth_proside_v1'],
        cp:      ['cp_steel_f12','cp_gullywash_f9','cp_process_f12','cp_propaganda_b19'],
      };

      // Pobierz mapy z poprzedniego poll (x-1), żeby nie powtarzać
      const { rows: prev } = await client.query(
        `SELECT maps FROM map_polls ORDER BY created_at DESC LIMIT 1`
      );
      const exclude = prev.length ? prev[0].maps : [];

      function pickRandom(pool) {
        const avail = pool.filter(m => !exclude.includes(m));
        const src   = avail.length ? avail : pool; // fallback jeśli wszystkie wykluczone
        return src[Math.floor(Math.random() * src.length)];
      }

      const maps = [
        pickRandom(MAP_POOL.payload),
        pickRandom(MAP_POOL.koth),
        pickRandom(MAP_POOL.cp),
      ];

      // Dezaktywuj obecny poll
      await client.query(`UPDATE map_polls SET active=FALSE WHERE active=TRUE`);
      const { rows } = await client.query(
        `INSERT INTO map_polls (maps) VALUES ($1) RETURNING *`, [maps]
      );
      return res.status(200).json({ ok: true, poll: rows[0] });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'DB error' });
  } finally {
    client.release();
  }
}
