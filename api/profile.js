// GET  /api/profile?sessionId=X  → { steam_id, is_admin } | { steam_id: null, is_admin: false }
// POST /api/profile { sessionId, steamId } → { ok: true } | { ok: false, reason: 'already_claimed' }

import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const INIT_SQL = `
  CREATE TABLE IF NOT EXISTS session_profiles (
    session_id VARCHAR(50) PRIMARY KEY,
    steam_id   VARCHAR(25) UNIQUE,
    claimed_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS admin_profiles (
    steam_id VARCHAR(25) PRIMARY KEY,
    added_at TIMESTAMPTZ DEFAULT NOW()
  );
`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const client = await pool.connect();
  try {
    await client.query(INIT_SQL);

    // GET — pobierz profil dla sesji (+ nick z naszej bazy + avatar ze Steam)
    if (req.method === 'GET') {
      const { sessionId } = req.query;
      if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
      const { rows } = await client.query(
        `SELECT sp.steam_id, (ap.steam_id IS NOT NULL) AS is_admin
         FROM session_profiles sp
         LEFT JOIN admin_profiles ap ON ap.steam_id = sp.steam_id
         WHERE sp.session_id = $1`,
        [sessionId]
      );
      const steamId = rows[0]?.steam_id ?? null;
      const isAdmin = rows[0]?.is_admin ?? false;

      let name = null;
      let avatar = null;

      if (steamId) {
        // Nick z naszej bazy (log_players lub votes)
        const { rows: nameRows } = await client.query(`
          SELECT player_name FROM (
            SELECT player_name, 1 AS src FROM log_players WHERE steam_id = $1 AND player_name <> '' LIMIT 1
            UNION ALL
            SELECT player_name, 2 AS src FROM votes WHERE steam_id = $1 AND player_name <> '' LIMIT 1
          ) t ORDER BY src LIMIT 1
        `, [steamId]).catch(() => ({ rows: [] }));
        name = nameRows[0]?.player_name ?? null;

        // Avatar ze Steam Community XML (publiczne, bez API key)
        try {
          const r = await fetch(`https://steamcommunity.com/profiles/${steamId}?xml=1`,
            { headers: { 'User-Agent': 'mvp.tf/1.0' }, signal: AbortSignal.timeout(3000) });
          if (r.ok) {
            const xml = await r.text();
            const nameMatch   = xml.match(/<steamID><!\[CDATA\[(.+?)\]\]><\/steamID>/);
            const avatarMatch = xml.match(/<avatarIcon><!\[CDATA\[(.+?)\]\]><\/avatarIcon>/);
            if (nameMatch)   name   = nameMatch[1];
            if (avatarMatch) avatar = avatarMatch[1]; // mały 32px avatar URL
          }
        } catch {} // timeout lub błąd — nie blokujemy
      }

      return res.status(200).json({ steam_id: steamId, is_admin: isAdmin, name, avatar });
    }

    // POST — przypisz profil do sesji (first-come na steam_id)
    if (req.method === 'POST') {
      const { sessionId, steamId } = req.body || {};
      if (!sessionId || !steamId) return res.status(400).json({ error: 'Missing fields' });
      if (!/^\d{17}$/.test(steamId))  return res.status(400).json({ error: 'Invalid steamId — expected 17-digit Steam64 ID' });

      try {
        // Upsert: jeśli sesja już istnieje — zaktualizuj steam_id;
        // jeśli steam_id zajęty przez inną sesję — UNIQUE violation → already_claimed
        await client.query(
          `INSERT INTO session_profiles (session_id, steam_id)
           VALUES ($1, $2)
           ON CONFLICT (session_id) DO UPDATE SET steam_id = EXCLUDED.steam_id, claimed_at = NOW()`,
          [sessionId, steamId]
        );
        return res.status(200).json({ ok: true });
      } catch (err) {
        if (err.code === '23505') {
          // UNIQUE violation na steam_id — ktoś już to przypisał
          return res.status(200).json({ ok: false, reason: 'already_claimed' });
        }
        throw err;
      }
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'DB error' });
  } finally {
    client.release();
  }
}
