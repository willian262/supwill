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

async function fetchAllTickets(accessToken, orgId) {
  const SAC_DEPT = '365059000000006907';
  let allTickets = [];
  let from = 1;
  const limit = 100;

  while (true) {
    const qs = new URLSearchParams({ from, limit, sortBy: 'createdTime' }).toString();
    const url = `https://desk.zoho.com/api/v1/tickets?${qs}`;
    const res = await fetch(url, {
      headers: {
        'orgId': orgId,
        'Authorization': `Zoho-oauthtoken ${accessToken}`
      }
    });
    const text = await res.text();
    if (!text || text.trim() === '') break;
    const data = JSON.parse(text);
    const tickets = (data.data || []).filter(t => t.departmentId === SAC_DEPT);
    allTickets = allTickets.concat(tickets);
    if ((data.data || []).length < limit) break;
    from += limit;
    if (from > 500) break; // máximo 500 tickets por segurança
  }

  return allTickets;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { path, statusType, ...params } = req.query;
  if (!path) return res.status(400).json({ error: 'path obrigatório' });

  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch (err) {
    return res.status(401).json({ error: 'Falha ao obter token', detail: err.message });
  }

  try {
    // Para tickets, busca tudo e filtra no servidor
    if (path === 'tickets') {
      const allTickets = await fetchAllTickets(accessToken, process.env.ZOHO_ORG_ID);
      let filtered = allTickets;
      if (statusType) {
        filtered = allTickets.filter(t => t.statusType === statusType);
      }
      return res.status(200).json({ data: filtered, count: filtered.length });
    }

    // Para outros endpoints (departments, etc)
    const qs = new URLSearchParams({ ...params, limit: params.limit || '100' }).toString();
    const url = `https://desk.zoho.com/api/v1/${path}?${qs}`;
    const zohoRes = await fetch(url, {
      headers: {
        'orgId': process.env.ZOHO_ORG_ID,
        'Authorization': `Zoho-oauthtoken ${accessToken}`
      }
    });
    const text = await zohoRes.text();
    if (!text || text.trim() === '') return res.status(200).json({ data: [], count: 0 });
    const data = JSON.parse(text);
    return res.status(zohoRes.status).json(data);

  } catch (err) {
    return res.status(500).json({ error: 'Erro ao chamar Zoho: ' + err.message });
  }
}
