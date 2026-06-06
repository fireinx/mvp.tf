// GET  /api/profile?sessionId=X  → { steam_id } | { steam_id: null }
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
`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const client = await pool.connect();
  try {
    await client.query(INIT_SQL);

    // GET — pobierz profil dla sesji
    if (req.method === 'GET') {
      const { sessionId } = req.query;
      if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
      const { rows } = await client.query(
        'SELECT steam_id FROM session_profiles WHERE session_id = $1',
        [sessionId]
      );
      return res.status(200).json({ steam_id: rows[0]?.steam_id ?? null });
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
