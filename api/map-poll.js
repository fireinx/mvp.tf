// GET /api/map-poll?sessionId=X  → { poll, votes, prevPoll, prevVotes, recentWinners, rerollCount, myReroll, mapPool, rerollThreshold }
// POST /api/map-poll { sessionId, mapName }         → cast map vote
// POST /api/map-poll { sessionId, action:'reroll' } → request reroll

import pkg from 'pg';
const { Pool } = pkg;
import { MAP_POOL, REROLL_THRESHOLD, pickRandom } from './_mappool.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const INIT = `
  CREATE TABLE IF NOT EXISTS map_polls (
    id         SERIAL      PRIMARY KEY,
    maps       TEXT[]      NOT NULL,
    active     BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS map_votes (
    poll_id    INT         NOT NULL,
    session_id VARCHAR(50) NOT NULL,
    map_name   VARCHAR(80) NOT NULL,
    PRIMARY KEY (poll_id, session_id)
  );
  CREATE TABLE IF NOT EXISTS map_reroll_votes (
    poll_id    INT         NOT NULL,
    session_id VARCHAR(50) NOT NULL,
    PRIMARY KEY (poll_id, session_id)
  );
`;

async function getCounts(client, pollId) {
  const { rows } = await client.query(
    `SELECT map_name, COUNT(*)::int AS cnt FROM map_votes WHERE poll_id=$1 GROUP BY map_name`,
    [pollId]
  );
  return Object.fromEntries(rows.map(r => [r.map_name, r.cnt]));
}

// Mapy które wygrały zamknięty poll w ciągu ostatnich 12h (= "zagrana mapa")
async function getRecentWinners(client) {
  const { rows } = await client.query(`
    SELECT DISTINCT mv.map_name
    FROM map_polls mp
    CROSS JOIN LATERAL (
      SELECT map_name
      FROM map_votes
      WHERE poll_id = mp.id
      GROUP BY map_name
      ORDER BY COUNT(*) DESC
      LIMIT 1
    ) mv
    WHERE mp.active = FALSE
      AND mp.created_at > NOW() - INTERVAL '12 hours'
  `);
  return rows.map(r => r.map_name);
}

// Tworzy nowy poll — używane przez reroll i przez admin.js
export async function createNewPoll(client) {
  const recentWinners = await getRecentWinners(client);
  const maps = [
    pickRandom(MAP_POOL.payload, recentWinners),
    pickRandom(MAP_POOL.koth,    recentWinners),
    pickRandom(MAP_POOL.cp,      recentWinners),
  ];
  await client.query(`UPDATE map_polls SET active=FALSE WHERE active=TRUE`);
  const { rows } = await client.query(
    `INSERT INTO map_polls (maps) VALUES ($1) RETURNING *`, [maps]
  );
  return rows[0];
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const client = await pool.connect();
  try {
    await client.query(INIT);

    // ── GET ───────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const { sessionId } = req.query;

      const { rows: polls } = await client.query(
        `SELECT * FROM map_polls WHERE active=TRUE ORDER BY created_at DESC LIMIT 1`
      );
      const activePoll = polls[0] || null;

      const { rows: prevPolls } = await client.query(
        `SELECT * FROM map_polls WHERE active=FALSE ORDER BY created_at DESC LIMIT 1`
      );
      const prevPoll = prevPolls[0] || null;

      const recentWinners = await getRecentWinners(client);

      let rerollCount = 0;
      let myReroll    = false;
      if (activePoll) {
        const { rows: rc } = await client.query(
          `SELECT COUNT(*)::int AS cnt FROM map_reroll_votes WHERE poll_id=$1`, [activePoll.id]
        );
        rerollCount = rc[0]?.cnt || 0;

        if (sessionId) {
          const { rows: mr } = await client.query(
            `SELECT 1 FROM map_reroll_votes WHERE poll_id=$1 AND session_id=$2`,
            [activePoll.id, sessionId]
          );
          myReroll = mr.length > 0;
        }
      }

      return res.status(200).json({
        poll:            activePoll,
        votes:           activePoll ? await getCounts(client, activePoll.id) : {},
        prevPoll,
        prevVotes:       prevPoll ? await getCounts(client, prevPoll.id) : {},
        recentWinners,
        rerollCount,
        myReroll,
        mapPool:         MAP_POOL,
        rerollThreshold: REROLL_THRESHOLD,
      });
    }

    // ── POST ──────────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const { sessionId, mapName, action } = req.body || {};
      if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

      // Reroll vote
      if (action === 'reroll') {
        const { rows: polls } = await client.query(
          `SELECT * FROM map_polls WHERE active=TRUE ORDER BY created_at DESC LIMIT 1`
        );
        if (!polls.length) return res.status(200).json({ rerolled: false, rerollCount: 0 });
        const poll = polls[0];

        await client.query(
          `INSERT INTO map_reroll_votes (poll_id, session_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [poll.id, sessionId]
        );

        const { rows: rc } = await client.query(
          `SELECT COUNT(*)::int AS cnt FROM map_reroll_votes WHERE poll_id=$1`, [poll.id]
        );
        const rerollCount = rc[0]?.cnt || 0;

        if (rerollCount >= REROLL_THRESHOLD) {
          const newPoll    = await createNewPoll(client);
          const recentWins = await getRecentWinners(client);
          return res.status(200).json({
            rerolled: true,
            poll:     newPoll,
            votes:    {},
            recentWinners: recentWins,
            rerollCount:   0,
            myReroll:      false,
          });
        }

        return res.status(200).json({ rerolled: false, rerollCount, myReroll: true });
      }

      // Map vote
      if (!mapName) return res.status(400).json({ error: 'Missing mapName' });

      const { rows: polls } = await client.query(
        `SELECT * FROM map_polls WHERE active=TRUE ORDER BY created_at DESC LIMIT 1`
      );
      if (!polls.length) return res.status(200).json({ poll: null, votes: {} });
      const poll = polls[0];

      if (!poll.maps.includes(mapName)) return res.status(400).json({ error: 'Invalid map' });

      await client.query(
        `INSERT INTO map_votes (poll_id, session_id, map_name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [poll.id, sessionId, mapName]
      );
      return res.status(200).json({ ok: true, votes: await getCounts(client, poll.id) });
    }

    return res.status(405).end();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'DB error' });
  } finally {
    client.release();
  }
}
