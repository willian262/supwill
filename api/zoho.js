export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { path, ...params } = req.query;
  if (!path) return res.status(400).json({ error: 'path obrigatório' });

  let accessToken;
  try {
    const tokenParams = new URLSearchParams({
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id:     process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type:    'refresh_token'
    });
    const tokenRes = await fetch('https://accounts.zoho.com/oauth/v2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return res.status(401).json({ error: 'Falha ao obter token', detail: tokenData });
    }
    accessToken = tokenData.access_token;
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao buscar token: ' + err.message });
  }

  try {
    const qs = new URLSearchParams({ ...params, limit: params.limit || '100' }).toString();
    const url = `https://desk.zoho.com/api/v1/${path}?${qs}`;
    const zohoRes = await fetch(url, {
      headers: {
        'orgId':         process.env.ZOHO_ORG_ID,
        'Authorization': `Zoho-oauthtoken ${accessToken}`
      }
    });
    const data = await zohoRes.json();
    return res.status(zohoRes.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao chamar Zoho: ' + err.message });
  }
}
