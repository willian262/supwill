// Proxy Neppo API — separado do Zoho para não interferir
const NEPPO_BASE = 'https://api.neppo.com.br';
const OPERATION  = 'Sac';

async function getNeppoToken() {
  // Token de acesso base64: "chave:senha"
  const accessToken = process.env.NEPPO_ACCESS_TOKEN;
  if (accessToken) return accessToken;

  // Fallback: gerar via OAuth com refresh token
  const res = await fetch(`${NEPPO_BASE}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${Buffer.from(
        `${process.env.NEPPO_CONSUMER_KEY}:${process.env.NEPPO_CONSUMER_SECRET}`
      ).toString('base64')}`
    },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: process.env.NEPPO_REFRESH_TOKEN,
      username:      process.env.NEPPO_USER,
      password:      process.env.NEPPO_PASS
    })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Neppo token falhou: ' + JSON.stringify(data));
  return data.access_token;
}

async function neppoPost(path, body, token) {
  const res = await fetch(`${NEPPO_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!text || text.trim() === '') return { results: [] };
  try { return JSON.parse(text); } catch(e) { return { results: [], raw: text.slice(0,200) }; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { path } = req.query;
  if (!path) return res.status(400).json({ error: 'path obrigatório' });

  let token;
  try {
    token = await getNeppoToken();
  } catch(err) {
    return res.status(401).json({ error: 'Falha ao obter token Neppo', detail: err.message });
  }

  try {
    // Filtro base: operação SAC
    const sacFilter = {
      key:      'operationName',
      value:    OPERATION,
      operator: 'EQ',
      logic:    'AND'
    };

    if (path === 'attendance') {
      // Tempo de atendimento — últimas 24h
      const since = new Date(Date.now() - 24 * 3600000).toISOString();
      const data = await neppoPost('/chatapi/1.0/api/report-attendance-time', {
        conditions: [
          sacFilter,
          { key: 'createdAt', value: since, operator: 'AFTER', logic: 'AND' }
        ],
        direction: 'DESC',
        sort: true,
        sortColumn: 'createdAt',
        page: 0,
        size: 500
      }, token);
      return res.status(200).json(data);
    }

    if (path === 'sessions') {
      // Sessões ativas (conversas em andamento)
      const data = await neppoPost('/chatapi/1.0/api/user-session', {
        conditions: [ sacFilter ],
        direction: 'DESC',
        sort: true,
        sortColumn: 'id',
        page: 0,
        size: 500
      }, token);
      return res.status(200).json(data);
    }

    if (path === 'agents') {
      // Agentes da operação SAC
      const data = await neppoPost('/chatapi/1.0/api/agent', {
        conditions: [ sacFilter ],
        direction: 'ASC',
        sort: true,
        sortColumn: 'agentName',
        page: 0,
        size: 200
      }, token);
      return res.status(200).json(data);
    }

    // Qualquer outro path: passa direto
    const data = await neppoPost(`/chatapi/1.0/api/${path}`, {
      conditions: [ sacFilter ],
      page: 0,
      size: 100
    }, token);
    return res.status(200).json(data);

  } catch(err) {
    return res.status(500).json({ error: 'Erro Neppo: ' + err.message });
  }
}
