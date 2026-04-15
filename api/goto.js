const GOTO_AUTH_BASE = 'https://authentication.logmeininc.com';
const GOTO_BASE      = 'https://api.goto.com';
const REDIRECT_URI   = 'https://project-fj1lt.vercel.app/api/goto';

let _gotoToken   = null;
let _gotoRefresh = null;
let _gotoExpires = 0;

async function refreshToken() {
  if (!_gotoRefresh && !process.env.GOTO_REFRESH_TOKEN) return null;
  const refresh = _gotoRefresh || process.env.GOTO_REFRESH_TOKEN;

  const basicAuth = Buffer.from(
    `${process.env.GOTO_CLIENT_ID}:${process.env.GOTO_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetch(`${GOTO_AUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(JSON.stringify(data));
  _gotoToken   = data.access_token;
  _gotoRefresh = data.refresh_token || refresh;
  _gotoExpires = Date.now() + (data.expires_in - 60) * 1000;
  return _gotoToken;
}

async function getToken() {
  if (_gotoToken && Date.now() < _gotoExpires) return _gotoToken;
  return refreshToken();
}

async function gotoGet(path, token) {
  const res = await fetch(`${GOTO_BASE}${path}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const text = await res.text();
  if (!text || text.trim() === '') return {};
  try { return JSON.parse(text); } catch(e) { return { raw: text.slice(0,300), status: res.status }; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { path, code } = req.query;

  // Passo 1: GoTo redirecionou com code — trocar por token
  if (code && !path) {
    try {
      const basicAuth = Buffer.from(
        `${process.env.GOTO_CLIENT_ID}:${process.env.GOTO_CLIENT_SECRET}`
      ).toString('base64');

      const tokenRes = await fetch(`${GOTO_AUTH_BASE}/oauth/token`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          grant_type:   'authorization_code',
          code,
          redirect_uri: REDIRECT_URI
        })
      });
      const data = await tokenRes.json();
      if (data.access_token) {
        _gotoToken   = data.access_token;
        _gotoRefresh = data.refresh_token;
        _gotoExpires = Date.now() + (data.expires_in - 60) * 1000;
        // Mostrar o refresh token para salvar nas variáveis de ambiente
        return res.status(200).json({
          success: true,
          message: 'Token obtido! Salve o refresh_token nas variáveis do Vercel.',
          refresh_token: data.refresh_token,
          access_token_preview: data.access_token.slice(0,20) + '...'
        });
      }
      return res.status(400).json({ error: 'Falha ao obter token', detail: data });
    } catch(err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (!path) return res.status(400).json({ error: 'path obrigatório' });

  let token;
  try {
    token = await getToken();
    if (!token) return res.status(401).json({ error: 'Sem token. Faça autenticação primeiro.' });
  } catch(err) {
    return res.status(401).json({ error: 'Token GoTo inválido', detail: err.message });
  }

  try {
    const ACCOUNT_KEY = '1691833281545172737';
    const today = new Date(Date.now() - 3*3600000).toISOString().slice(0,10);
    const startOfDay = `${today}T00:00:00Z`;
    const now = new Date().toISOString();

    if (path === 'me') {
      const data = await gotoGet('/users/v1/me', token);
      return res.status(200).json(data);
    }

    if (path === 'queues') {
      // Filas de atendimento
      const data = await gotoGet(`/voice-admin/v1/queues?accountKey=${ACCOUNT_KEY}`, token);
      return res.status(200).json(data);
    }

    if (path === 'extensions') {
      // Ramais/extensões
      const data = await gotoGet(`/voice-admin/v1/extensions?accountKey=${ACCOUNT_KEY}`, token);
      return res.status(200).json(data);
    }

    if (path === 'calls-today') {
      // Relatório de chamadas de hoje
      const data = await gotoGet(
        `/call-events-report/v1/report-summaries?accountKey=${ACCOUNT_KEY}&startTime=${startOfDay}&endTime=${now}`,
        token
      );
      return res.status(200).json(data);
    }

    if (path === 'users') {
      // Usuários da conta
      const data = await gotoGet(`/users/v1/users?accountKey=${ACCOUNT_KEY}`, token);
      return res.status(200).json(data);
    }

    if (path === 'phone-numbers') {
      const data = await gotoGet(`/voice-admin/v1/phone-numbers?accountKey=${ACCOUNT_KEY}`, token);
      return res.status(200).json(data);
    }

    if (path === 'call-reports') {
      // Relatório de chamadas - endpoint correto
      const data = await gotoGet(
        `/call-events-report/v1/report-summaries?accountKey=${ACCOUNT_KEY}&startTime=${startOfDay}&endTime=${now}&pageSize=100`,
        token
      );
      return res.status(200).json(data);
    }

    if (path === 'cr-reports') {
      // CR reports
      const data = await gotoGet(
        `/cr/v1/accounts/${ACCOUNT_KEY}/reports?startTime=${startOfDay}&endTime=${now}`,
        token
      );
      return res.status(200).json(data);
    }

    if (path === 'presence') {
      // Busca userKeys e depois a presença de cada um
      const usersData = await gotoGet(`/users/v1/users?accountKey=${ACCOUNT_KEY}`, token);
      const userKeys = (usersData.items || []).map(u => u.userKey).filter(Boolean).slice(0, 100);
      if (!userKeys.length) return res.status(200).json({ items: [] });
      const qs = userKeys.map(k => `userKey=${k}`).join('&');
      const data = await gotoGet(`/presence/v1/presence?${qs}`, token);
      return res.status(200).json(data);
    }

    if (path === 'dashboard') {
      // Busca agentes SAC diretamente da Neppo
      let neppoAgentNames = [];
      try {
        // Auth Neppo
        const basicAuth = Buffer.from(
          `${process.env.NEPPO_CONSUMER_KEY}:${process.env.NEPPO_CONSUMER_SECRET}`
        ).toString('base64');
        const tokenRes = await fetch('https://api-auth.neppo.com.br/oauth2/token', {
          method: 'POST',
          headers: { 'Authorization': `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'password', username: process.env.NEPPO_USER, password: process.env.NEPPO_PASS })
        });
        const tokenData = await tokenRes.json();
        const neppoToken = tokenData.access_token || process.env.NEPPO_ACCESS_TOKEN;

        // Buscar sessões SAC ativas
        const sessRes = await fetch('https://api.neppo.com.br/chatapi/1.0/api/user-session', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${neppoToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conditions: [
              { key: 'groupConf.operation.operationName', value: 'Sac', operator: 'EQ', logic: 'AND' },
              { key: 'status', value: 'CLOSED', operator: 'NEQ', logic: 'AND' }
            ],
            sort: true, sortColumn: 'id', direction: 'DESC', page: 0, size: 200
          })
        });
        const sessData = await sessRes.json();
        const BOT_KW = ['bot', 'pesquisa', '@botserver', 'csat', 'nps', 'inatividade', 'inicial'];
        const isBot = n => !n || BOT_KW.some(k => n.toLowerCase().includes(k));
        const seen = new Set();
        (sessData.results || []).forEach(s => {
          const name = s.agent?.displayName;
          if (name && !isBot(name) && !seen.has(name)) {
            seen.add(name);
            neppoAgentNames.push(name.toLowerCase().trim());
          }
        });
      } catch(e) {}

      // Função para checar se nome GoTo bate com algum agente Neppo
      // GoTo usa "Nome Sobrenome - Departamento", Neppo usa "Nome Sobrenome"
      const isSacAgent = (gotoName) => {
        if (!gotoName || !neppoAgentNames.length) return true;
        // Remove sufixo " - Departamento" do nome GoTo
        const cleanGoto = gotoName.toLowerCase().replace(/\s*-\s*\w.*$/, '').trim();
        return neppoAgentNames.some(neppoName => {
          const cleanNeppo = neppoName.replace(/\s*-\s*\w.*$/, '').trim();
          // Compara nome limpo diretamente
          if (cleanGoto === cleanNeppo) return true;
          // Ou verifica se primeiro nome + sobrenome batem
          const parts = cleanNeppo.split(' ').filter(Boolean);
          if (parts.length >= 2) {
            return cleanGoto.includes(parts[0]) && cleanGoto.includes(parts[1]);
          }
          return cleanGoto.startsWith(parts[0]);
        });
      };

      const [usersData] = await Promise.all([
        gotoGet(`/users/v1/users?accountKey=${ACCOUNT_KEY}`, token)
      ]);

      // Buscar presença
      const userKeys = (usersData.items || []).map(u => u.userKey).filter(Boolean).slice(0, 100);
      let presenceData = { items: [] };
      if (userKeys.length) {
        const qs = userKeys.map(k => `userKey=${k}`).join('&');
        presenceData = await gotoGet(`/presence/v1/presence?${qs}`, token);
      }

      // Mapa userKey -> linha/nome
      const userMap = {};
      (usersData.items || []).forEach(u => {
        const line = (u.lines || []).find(l => l.primary) || u.lines?.[0];
        userMap[u.userKey] = {
          name: line?.name || u.userId,
          number: line?.number || '',
        };
      });

      // Presença por userKey
      const presenceMap = {};
      (presenceData.items || []).forEach(p => {
        presenceMap[p.userKey] = p.appearance || 'OFFLINE';
      });

      // Combinar e filtrar só SAC
      const allAgents = Object.entries(userMap).map(([key, info]) => ({
        name: info.name,
        number: info.number,
        status: presenceMap[key] || 'OFFLINE'
      }));

      const agents = allAgents.filter(a => a.name && isSacAgent(a.name));

      const online  = agents.filter(a => a.status === 'AVAILABLE').length;
      const busy    = agents.filter(a => ['BUSY','ON_A_CALL'].includes(a.status)).length;
      const away    = agents.filter(a => ['AWAY','DO_NOT_DISTURB','IDLE','ONLINE'].includes(a.status)).length;
      const offline = agents.filter(a => a.status === 'OFFLINE').length;

      return res.status(200).json({
        totalAgents: agents.length,
        online, busy, away, offline,
        agents: agents.sort((a,b) => {
          const order = {'AVAILABLE':0,'ON_A_CALL':1,'BUSY':2,'AWAY':3,'IDLE':4,'ONLINE':5,'OFFLINE':6};
          return (order[a.status]??9) - (order[b.status]??9);
        }),
        neppoAgentsFound: neppoAgentNames.length,
        _debug: {
          neppoNames: neppoAgentNames,
          gotoNamesSample: allAgents.slice(0,10).map(a => a.name)
        }
      });
    }

    // Genérico
    const data = await gotoGet(`/${path}`, token);
    return res.status(200).json(data);
  } catch(err) {
    return res.status(500).json({ error: 'Erro GoTo: ' + err.message });
  }
}
