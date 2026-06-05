// Vercel Serverless Function — proxy do logs.tf API
// Rozwiązuje problem CORS: przeglądarka nie może bezpośrednio fetchować logs.tf
// Ten endpoint: /api/log?id=4066082

export default async function handler(req, res) {
  // CORS headers — pozwól na fetch z przeglądarki
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { id } = req.query;

  if (!id || !/^\d{4,8}$/.test(id)) {
    return res.status(400).json({ success: false, error: 'Nieprawidłowe ID logu' });
  }

  try {
    const response = await fetch(`https://logs.tf/api/v1/log/${id}`, {
      headers: {
        'User-Agent': 'mvp.tf/1.0',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      return res.status(response.status).json({ success: false, error: `logs.tf zwrócił ${response.status}` });
    }

    const data = await response.json();

    // Cache na 60 sekund — mecze się nie zmieniają
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ success: false, error: 'Błąd połączenia z logs.tf' });
  }
}
