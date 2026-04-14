const NEPPO_AUTH = 'https://api-auth.neppo.com.br/oauth2/token';
const NEPPO_BASE = 'https://api.neppo.com.br';

let _neppoToken = null;
let _neppoExpires = 0;

async function getNeppoToken() {
  if (_neppoToken && Date.now() < _neppoExpires) return _neppoToken;

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
  } catch(e) {}

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
  if (!text || text.trim() === '') return { results: [] };
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

  try {
    if (path === 'dashboard') {
      // Busca sessões ativas do SAC
      const data = await neppoPost('/chatapi/1.0/api/user-session', {
        conditions: [],
        sort: false,
        page: 0,
        size: 500
      }, token);

      const all = data.results || [];

      // Filtra sessões SAC: groupConf.name contém SAC ou groupList contém SAC
      const sac = all.filter(s => {
        const gName = (s.groupConf?.name || '').toUpperCase();
        const gList = (s.groupList || '').toUpperCase();
        const opName = (s.groupConf?.operation?.operationName || '').toUpperCase();
        return gName.includes('SAC') || gList.includes('SAC') || opName === 'SAC';
      });

      // Status dos agentes únicos
      const agentMap = {};
      sac.forEach(s => {
        const name = s.agent?.displayName || s.agent?.userName || 'Desconhecido';
        const status = s.agent?.agent?.status || 'UNKNOWN';
        if (!agentMap[name]) {
          agentMap[name] = { name, status, conversations: 0 };
        }
        agentMap[name].conversations++;
      });

      const agents = Object.values(agentMap).sort((a,b) => b.conversations - a.conversations);

      // Contadores por status de agente
      const online   = agents.filter(a => a.status === 'ONLINE').length;
      const paused   = agents.filter(a => a.status !== 'ONLINE' && a.status !== 'OFFLINE').length;
      const offline  = agents.filter(a => a.status === 'OFFLINE').length;

      return res.status(200).json({
        totalConversations: sac.length,
        totalAgents: agents.length,
        online, paused, offline,
        agents
      });
    }

    if (path === 'attendance') {
      // Tempo de atendimento — últimas 24h
      const since = new Date(Date.now() - 24 * 3600000).toISOString();
      const data = await neppoPost('/chatapi/1.0/api/report-attendance-time', {
        conditions: [
          { key: 'createdAt', value: since, operator: 'AFTER', logic: 'AND' }
        ],
        direction: 'DESC', sort: true, sortColumn: 'createdAt',
        page: 0, size: 500
      }, token);
      return res.status(200).json(data);
    }

    if (path === 'debug') {
      // Tenta filtrar direto pela API com groupConf.name LIKE SAC
      const data = await neppoPost('/chatapi/1.0/api/user-session', {
        conditions: [
          { key: 'status', value: 'CLOSED', operator: 'NEQ', logic: 'AND' },
          { key: 'groupConf.name', value: 'SAC', operator: 'LIKE', logic: 'AND' }
        ],
        sort: false, page: 0, size: 10
      }, token);
      const preview = (data.results || []).map(s => ({
        id: s.id,
        status: s.status,
        agentName: s.agent?.displayName,
        groupName: s.groupConf?.name,
        operationName: s.groupConf?.operation?.operationName,
        groupList: s.groupList
      }));
      return res.status(200).json({ total: data.size, rawSize: data.results?.length, preview, error: data.message });
    }

    // Debug genérico
    const data = await neppoPost(`/chatapi/1.0/api/${path}`, {
      conditions: [], sort: false, page: 0, size: 5
    }, token);
    return res.status(200).json(data);

  } catch(err) {
    return res.status(500).json({
      error: 'Erro Neppo: ' + err.message,
      cause: err.cause?.message
    });
  }
}
