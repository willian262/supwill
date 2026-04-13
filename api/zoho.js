let _cachedToken = null;
let _tokenExpires = 0;

async function getAccessToken() {
  if (_cachedToken && Date.now() < _tokenExpires) return _cachedToken;
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
  if (!tokenData.access_token) throw new Error(JSON.stringify(tokenData));
  _cachedToken  = tokenData.access_token;
  _tokenExpires = Date.now() + 55 * 60 * 1000;
  return _cachedToken;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { path, ...params } = req.query;
  if (!path) return res.status(400).json({ error: 'path obrigatório' });

  const { departmentId, ...zohoParams } = params;

  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch (err) {
    return res.status(401).json({ error: 'Falha ao obter token', detail: err.message });
  }

  try {
    const qs = new URLSearchParams({ ...zohoParams, limit: zohoParams.limit || '100' }).toString();
    const url = `https://desk.zoho.com/api/v1/${path}?${qs}`;
    const zohoRes = await fetch(url, {
      headers: {
        'orgId':         process.env.ZOHO_ORG_ID,
        'Authorization': `Zoho-oauthtoken ${accessToken}`
      }
    });

    const text = await zohoRes.text();
    if (!text || text.trim() === '') {
      return res.status(200).json({ data: [], count: 0 });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch(e) {
      return res.status(200).json({ data: [], count: 0, _raw: text.substring(0, 200) });
    }

    if (departmentId && data.data && Array.isArray(data.data)) {
      data.data = data.data.filter(t => t.departmentId === departmentId);
      data.count = data.data.length;
    }

    return res.status(zohoRes.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao chamar Zoho: ' + err.message });
  }
}
