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
    // Endpoints que não são tickets: agents, departments, etc.
    if (path !== 'tickets') {
      const data = await zohoRequest(path, { ...params, limit: params.limit || '100' }, accessToken);
      return res.status(200).json(data);
    }

    // TICKETS: busca sem filtro e filtra server-side
    // A API Zoho retorna em ordem crescente (mais antigos primeiro)
    // Buscamos as últimas páginas para pegar os mais recentes
    const SAC_DEPT = '365059000000006907';
    const LIMIT = 100;

    // Primeiro, descobre o total de tickets
    const firstPage = await zohoRequest('tickets', { from: 1, limit: 1 }, accessToken);
    const totalCount = parseInt(firstPage.count || firstPage.totalCount || 0);

    let allTickets = [];

    if (totalCount > 0) {
      // Calcula de onde começar para pegar os últimos ~800 tickets (mais recentes)
      const startFrom = Math.max(1, totalCount - 799);
      
      // Busca 8 páginas a partir dos mais recentes
      for (let from = startFrom; from <= totalCount; from += LIMIT) {
        const pageData = await zohoRequest('tickets', { from, limit: LIMIT }, accessToken);
        const batch = pageData.data || [];
        allTickets = allTickets.concat(batch);
        if (batch.length < LIMIT) break;
        if (allTickets.length >= 800) break;
      }
    } else {
      // Fallback: busca 5 páginas normais
      for (let page = 1; page <= 5; page++) {
        const from = (page - 1) * LIMIT + 1;
        const pageData = await zohoRequest('tickets', { from, limit: LIMIT }, accessToken);
        const batch = pageData.data || [];
        allTickets = allTickets.concat(batch);
        if (batch.length < LIMIT) break;
      }
    }

    // Ordena do mais recente para o mais antigo
    allTickets.sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));

    // Filtra pelo departamento SAC
    const sacTickets = allTickets.filter(t => t.departmentId === SAC_DEPT);

    // Filtra por statusType se solicitado (server-side)
    let filtered = sacTickets;
    if (statusType) {
      filtered = sacTickets.filter(t => t.statusType === statusType);
    }

    return res.status(200).json({ data: filtered, count: filtered.length });

  } catch (err) {
    return res.status(500).json({ error: 'Erro: ' + err.message });
  }
}
