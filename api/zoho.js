// Cache global — persiste enquanto a função estiver "quente"
let _cachedToken = null;
let _tokenExpires = 0;
let _tokenPending = null; // evita chamadas paralelas ao token

async function getAccessToken() {
  if (_cachedToken && Date.now() < _tokenExpires) return _cachedToken;

  // Se já tem uma chamada pendente, aguarda ela terminar
  if (_tokenPending) return _tokenPending;

  _tokenPending = (async () => {
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
        throw new Error('Zoho retornou: ' + JSON.stringify(tokenData));
      }
      _cachedToken  = tokenData.access_token;
      // Cache por 50 minutos (access token dura 1h)
      _tokenExpires = Date.now() + 50 * 60 * 1000;
      return _cachedToken;
    } finally {
      _tokenPending = null;
    }
  })();

  return _tokenPending;
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
  if (!text || text.trim() === '') return { data: [] };
  try { return JSON.parse(text); } catch(e) { return { data: [] }; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { path, ...params } = req.query;
  if (!path) return res.status(400).json({ error: 'path obrigatório' });

  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch (err) {
    return res.status(401).json({ error: 'Falha ao obter token', detail: err.message });
  }

  try {
    if (path !== 'tickets') {
      const needsLimit = ['agents','departments','contacts','teams'].some(p => path.startsWith(p));
      const reqParams = needsLimit ? { ...params, limit: params.limit || '100' } : { ...params };
      const data = await zohoRequest(path, reqParams, accessToken);
      return res.status(200).json(data);
    }

    const SAC_DEPT = '365059000000006907';
    const CLOSED   = ['Fechado', 'Fechado Inatividade'];
    const LIMIT    = 100;

    // Endpoint especial: busca tickets fechados dos últimos 30 dias
    if (params.mode === 'closed30') {
      const since = new Date(Date.now() - 30 * 24 * 3600000).toISOString();
      let closedTickets = [];
      let from = 1;
      while (from <= 3000) {
        const froms = [];
        for (let i = 0; i < 10 && (from + i * LIMIT) <= 3000; i++) froms.push(from + i * LIMIT);
        const results = await Promise.all(
          froms.map(f => zohoRequest('tickets', {
            from: f, limit: LIMIT,
            fields: 'id,ticketNumber,subject,status,statusType,departmentId,createdTime,modifiedTime,classification'
          }, accessToken))
        );
        let gotAny = false;
        for (const r of results) {
          const batch = (r.data || []).filter(t =>
            t.departmentId === SAC_DEPT &&
            CLOSED.includes(t.status) &&
            t.modifiedTime >= since
          );
          if ((r.data||[]).length > 0) gotAny = true;
          closedTickets = closedTickets.concat(batch);
        }
        if (!gotAny) break;
        from += froms.length * LIMIT;
      }
      closedTickets.sort((a,b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
      return res.status(200).json({ data: closedTickets, count: closedTickets.length });
    }

    // Busca paralela em lotes de 20
    let allTickets = [];
    let from = 1;
    while (from <= 5000) {
      const froms = [];
      for (let i = 0; i < 20 && (from + i * LIMIT) <= 5000; i++) {
        froms.push(from + i * LIMIT);
      }
      const results = await Promise.all(
        froms.map(f => zohoRequest('tickets', {
          from: f,
          limit: LIMIT,
          fields: 'id,ticketNumber,subject,status,statusType,priority,dueDate,assigneeId,departmentId,createdTime,modifiedTime,classification'
        }, accessToken))
      );
      let gotAny = false;
      for (const r of results) {
        const batch = r.data || [];
        if (batch.length > 0) gotAny = true;
        allTickets = allTickets.concat(batch);
      }
      if (!gotAny) break;
      from += froms.length * LIMIT;
    }

    const filtered = allTickets
      .filter(t => t.departmentId === SAC_DEPT)
      .filter(t => !CLOSED.includes(t.status));

    filtered.sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));

    return res.status(200).json({ data: filtered, count: filtered.length });

  } catch (err) {
    return res.status(500).json({ error: 'Erro: ' + err.message });
  }
}
