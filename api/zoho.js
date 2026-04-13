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

async function zohoRequest(path, params, accessToken) {
  const qs = new URLSearchParams(params).toString();
  const url = `https://desk.zoho.com/api/v1/${path}?${qs}`;
  const res = await fetch(url, {
    headers: {
      'orgId': process.env.ZOHO_ORG_ID,
      'Authorization': `Zoho-oauthtoken ${accessToken}`
    }
  });
  const text = await res.text();
  if (!text || text.trim() === '') return { data: [], count: 0 };
  try { return JSON.parse(text); } catch(e) { return { data: [], count: 0 }; }
}

// Busca TODOS os tickets de um statusType usando endpoint do departamento
async function fetchByStatus(statusType, accessToken) {
  const DEPT = '365059000000006907';
  const LIMIT = 100;
  let all = [];
  let from = 1;

  while (true) {
    // Usa endpoint do departamento que aceita filtro de statusType
    const data = await zohoRequest(
      `departments/${DEPT}/tickets`,
      { from, limit: LIMIT, statusType },
      accessToken
    );
    const batch = data.data || [];
    all = all.concat(batch);
    if (batch.length < LIMIT) break;
    from += LIMIT;
    if (from > 5000) break; // segurança
  }

  return all;
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
    // Endpoints que não são tickets
    if (path !== 'tickets') {
      const data = await zohoRequest(path, { ...params, limit: params.limit || '100' }, accessToken);
      return res.status(200).json(data);
    }

    // TICKETS com statusType: usa endpoint do departamento
    if (statusType) {
      const tickets = await fetchByStatus(statusType, accessToken);
      tickets.sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));
      return res.status(200).json({ data: tickets, count: tickets.length });
    }

    // TICKETS sem filtro (ex: limit=2 para debug): busca normal
    const SAC_DEPT = '365059000000006907';
    const LIMIT = 100;
    const probe = await zohoRequest('tickets', { from: 1, limit: 1 }, accessToken);
    const total = parseInt(probe.count || probe.totalCount || 1000);
    const startFrom = Math.max(1, total - 199);

    let allTickets = [];
    for (let from = startFrom; from <= total; from += LIMIT) {
      const pageData = await zohoRequest('tickets', { from, limit: LIMIT }, accessToken);
      allTickets = allTickets.concat(pageData.data || []);
    }
    allTickets.sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));
    const sacTickets = allTickets.filter(t => t.departmentId === SAC_DEPT);
    return res.status(200).json({ data: sacTickets, count: sacTickets.length });

  } catch (err) {
    return res.status(500).json({ error: 'Erro: ' + err.message });
  }
}
