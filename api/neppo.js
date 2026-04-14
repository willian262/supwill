const NEPPO_AUTH = 'https://api-auth.neppo.com.br/oauth2/token';
const NEPPO_BASE = 'https://api.neppo.com.br';
const OPERATION  = 'Sac';

let _neppoToken = null;
let _neppoExpires = 0;

async function getNeppoToken() {
  if (_neppoToken && Date.now() < _neppoExpires) return _neppoToken;

  // Tenta OAuth com api-auth
  try {
    const basicAuth = Buffer.from(
      `${process.env.NEPPO_CONSUMER_KEY}:${process.env.NEPPO_CONSUMER_SECRET}`
    ).toString('base64');

    const res = await fetch(NEPPO_AUTH, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'password',
        username:   process.env.NEPPO_USER,
        password:   process.env.NEPPO_PASS
      })
    });

    const data = await res.json();
    if (data.access_token) {
      _neppoToken   = data.access_token;
      _neppoExpires = Date.now() + 50 * 60 * 1000;
      return _neppoToken;
    }
  } catch(e) {
    // OAuth falhou, tenta token fixo
  }

  // Fallback: usa token de acesso fixo das variáveis de ambiente
  const fixedToken = process.env.NEPPO_ACCESS_TOKEN;
  if (fixedToken) {
    _neppoToken   = fixedToken;
    _neppoExpires = Date.now() + 50 * 60 * 1000;
    return _neppoToken;
  }

  throw new Error('Nenhum token Neppo disponível');
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
  if (!text || text.trim() === '') return { results: [], size: 0 };
  try { return JSON.parse(text); } catch(e) { return { results: [], raw: text.slice(0,300) }; }
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

  // Filtro base: operação SAC
  const sacFilter = { key: 'operationName', value: OPERATION, operator: 'EQ', logic: 'AND' };

  try {
    if (path === 'attendance') {
      // Tempo de atendimento — últimas 24h
      const since = new Date(Date.now() - 24 * 3600000).toISOString();
      const data = await neppoPost('/chatapi/1.0/api/report-attendance-time', {
        conditions: [
          sacFilter,
          { key: 'createdAt', value: since, operator: 'AFTER', logic: 'AND' }
        ],
        direction: 'DESC', sort: true, sortColumn: 'createdAt',
        page: 0, size: 500
      }, token);
      return res.status(200).json(data);
    }

    if (path === 'sessions') {
      // Sessões ativas — filtra por groupName do SAC
      const data = await neppoPost('/chatapi/1.0/api/user-session', {
        conditions: [],
        direction: 'DESC', sort: true, sortColumn: 'id',
        page: 0, size: 10
      }, token);
      return res.status(200).json(data);
    }

    if (path === 'agents') {
      // Agentes — sem filtro de operationName (não existe nesse endpoint)
      const data = await neppoPost('/chatapi/1.0/api/agent', {
        conditions: [],
        sort: false,
        page: 0, size: 200
      }, token);
      return res.status(200).json(data);
    }

    // Path genérico para debug
    const data = await neppoPost(`/chatapi/1.0/api/${path}`, {
      conditions: [ sacFilter ],
      page: 0, size: 10
    }, token);
    return res.status(200).json(data);

  } catch(err) {
    return res.status(500).json({ 
      error: 'Erro Neppo: ' + err.message,
      cause: err.cause?.message 
    });
  }
}
