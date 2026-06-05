// GET /api/contests
// Zwraca listę konkursów z przypisanymi logami

import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const INIT_SQL = `
  CREATE TABLE IF NOT EXISTS contests (
    id         SERIAL       PRIMARY KEY,
    name       VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ  DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS contest_logs (
    contest_id INT         NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
    log_id     VARCHAR(10) NOT NULL,
    PRIMARY KEY (contest_id, log_id)
  );
`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const client = await pool.connect();
  try {
    await client.query(INIT_SQL);

    const { rows: contestRows } = await client.query(
      `SELECT id, name, created_at FROM contests ORDER BY created_at DESC`
    );

    // Dla każdego konkursu pobierz przypisane logi z metadanymi
    const { rows: logRows } = await client.query(`
      SELECT cl.contest_id, cl.log_id, ls.map, ls.title, ls.excluded
      FROM contest_logs cl
      LEFT JOIN log_settings ls ON ls.log_id = cl.log_id
      ORDER BY cl.contest_id, cl.log_id
    `);

    const logsByContest = {};
    for (const row of logRows) {
      if (!logsByContest[row.contest_id]) logsByContest[row.contest_id] = [];
      logsByContest[row.contest_id].push(row);
    }

    const contests = contestRows.map(c => ({
      ...c,
      logs: logsByContest[c.id] || [],
    }));

    return res.status(200).json(contests);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'DB error' });
  } finally {
    client.release();
  }
}
