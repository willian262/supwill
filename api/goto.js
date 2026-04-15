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
      // Dashboard completo de telefonia
      const [usersData, extensionsData] = await Promise.all([
        gotoGet(`/users/v1/users?accountKey=${ACCOUNT_KEY}`, token),
        gotoGet(`/voice-admin/v1/extensions?accountKey=${ACCOUNT_KEY}`, token)
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
          lineId: line?.id || ''
        };
      });

      // Presença por userKey
      const presenceMap = {};
      (presenceData.items || []).forEach(p => {
        presenceMap[p.userKey] = p.status || p.presence || 'UNKNOWN';
      });

      // Combinar
      const agents = Object.entries(userMap).map(([key, info]) => ({
        name: info.name,
        number: info.number,
        status: presenceMap[key] || 'UNKNOWN'
      })).filter(a => a.name && !a.name.toLowerCase().includes('test'));

      const online  = agents.filter(a => a.status === 'AVAILABLE').length;
      const busy    = agents.filter(a => ['BUSY','ON_CALL','IN_CALL'].includes(a.status)).length;
      const away    = agents.filter(a => ['AWAY','DO_NOT_DISTURB'].includes(a.status)).length;
      const offline = agents.filter(a => a.status === 'OFFLINE' || a.status === 'UNKNOWN').length;

      return res.status(200).json({
        totalAgents: agents.length,
        online, busy, away, offline,
        agents: agents.sort((a,b) => a.name.localeCompare(b.name))
      });
    }

    // Genérico
    const data = await gotoGet(`/${path}`, token);
    return res.status(200).json(data);
  } catch(err) {
    return res.status(500).json({ error: 'Erro GoTo: ' + err.message });
  }
}
