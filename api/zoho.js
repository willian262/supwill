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

async function fetchAllTickets(statusType, accessToken) {
  const SAC_DEPT = '365059000000006907';
  const LIMIT = 100;
  let allTickets = [];
  let from = 1;

  // Busca até 10 páginas (1000 tickets) para o statusType solicitado
  while (from <= 1000) {
    const params = { from, limit: LIMIT };
    // A API Zoho aceita statusType como filtro nativo
    if (statusType) params.statusType = statusType;

    const pageData = await zohoRequest('tickets', params, accessToken);
    const batch = pageData.data || [];

    // Filtra pelo departamento SAC
    const sacBatch = batch.filter(t => t.departmentId === SAC_DEPT);
    allTickets = allTickets.concat(sacBatch);

    // Se retornou menos que o limite, chegou no fim
    if (batch.length < LIMIT) break;
    from += LIMIT;
  }

  // Ordena do mais recente para o mais antigo
  allTickets.sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));

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
    // Para endpoints que não são tickets (agents, departments, etc.)
    if (path !== 'tickets') {
      const data = await zohoRequest(path, { ...params, limit: params.limit || '100' }, accessToken);
      return res.status(200).json(data);
    }

    // Para tickets: busca todas as páginas com filtro nativo de statusType
    const tickets = await fetchAllTickets(statusType || null, accessToken);
    return res.status(200).json({ data: tickets, count: tickets.length });

  } catch (err) {
    return res.status(500).json({ error: 'Erro: ' + err.message });
  }
}
