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
      const data = await gotoGet(`/voice-admin/v1/call-queues?accountKey=${ACCOUNT_KEY}`, token);
      return res.status(200).json(data);
    }

    if (path === 'queue-stats') {
      const ORG_ID = '6e9bbc00-5714-4f56-81e4-c1f12ebbf905';

      // Busca atividade de usuários + números de fila em paralelo
      const [userResp, phoneResp] = await Promise.all([
        fetch(`https://api.goto.com/call-reports/v1/reports/user-activity?organizationId=${ORG_ID}&startTime=${startOfDay}&endTime=${now}&pageSize=200`,
          { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch(`https://api.goto.com/call-reports/v1/reports/phone-number-activity?organizationId=${ORG_ID}&startTime=${startOfDay}&endTime=${now}&pageSize=200`,
          { headers: { 'Authorization': `Bearer ${token}` } })
      ]);
      const data = await userResp.json();
      const phoneData = await phoneResp.json().catch(() => ({ items: [] }));

      const items = data.items || [];

      // Filas SAC por número de ramal
      const SAC_QUEUES_MAP = {
        '1013': 'SAC Processos',
        '1012': 'SAC Processos GD',
        '1015': 'SAC Processos VE',
        '1019': 'SAC Técnico',
        '1022': 'SAC Técnico Bombeamento',
        '1017': 'SAC Técnico GD',
        '1023': 'SAC Técnico VE',
      };

      // Filtrar phone-number-activity para filas SAC
      const queueActivity = (phoneData.items || [])
        .filter(p => SAC_QUEUES_MAP[p.phoneNumber])
        .map(p => ({
          queue: SAC_QUEUES_MAP[p.phoneNumber],
          number: p.phoneNumber,
          inbound: p.dataValues?.inboundCallVolume || 0,
          duration: p.dataValues?.inboundDuration || 0,
        }));

      // Busca agentes SAC da Neppo para filtrar
      let sacNames = [];
      try {
        const basicAuth = Buffer.from(`${process.env.NEPPO_CONSUMER_KEY}:${process.env.NEPPO_CONSUMER_SECRET}`).toString('base64');
        const tokRes = await fetch('https://api-auth.neppo.com.br/oauth2/token', {
          method: 'POST',
          headers: { 'Authorization': `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'password', username: process.env.NEPPO_USER, password: process.env.NEPPO_PASS })
        });
        const tokData = await tokRes.json();
        const neppoToken = tokData.access_token || process.env.NEPPO_ACCESS_TOKEN;
        const sessRes = await fetch('https://api.neppo.com.br/chatapi/1.0/api/user-session', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${neppoToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ conditions: [{ key: 'groupConf.operation.operationName', value: 'Sac', operator: 'EQ', logic: 'AND' }, { key: 'status', value: 'CLOSED', operator: 'NEQ', logic: 'AND' }], sort: true, sortColumn: 'id', direction: 'DESC', page: 0, size: 200 })
        });
        const sessData = await sessRes.json();
        const BOT_KW = ['bot', 'pesquisa', '@botserver', 'csat', 'nps', 'inatividade', 'inicial'];
        const isBot = n => !n || BOT_KW.some(k => n.toLowerCase().includes(k));
        const seen = new Set();
        (sessData.results || []).forEach(s => {
          const name = s.agent?.displayName;
          if (name && !isBot(name) && !seen.has(name)) { seen.add(name); sacNames.push(name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')); }
        });
      } catch(e) {}

      const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s*-\s*sac\s*$/i, '').trim();

      const isSac = (gotoName) => {
        if (!sacNames.length) return true;
        const cleanGoto = norm(gotoName);
        return sacNames.some(n => {
          const parts = n.split(' ').filter(Boolean);
          if (parts.length >= 2) {
            // Exige nome + sobrenome exatos — evita "Vinicius Souza" bater com "Vinicius Fonseca"
            return cleanGoto.startsWith(parts[0] + ' ' + parts[1]) ||
                   cleanGoto === parts[0] + ' ' + parts[1];
          }
          return false;
        });
      };

      const fmtDur = ms => {
        const s = Math.round(ms / 1000);
        if (s < 60) return `${s}s`;
        if (s < 3600) return `${Math.floor(s/60)}m ${s%60}s`;
        return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
      };

      const sacAgents = items
        .filter(u => isSac(u.userName))
        .filter(u => (u.dataValues.totalDuration || 0) > 0) // só quem efetivamente atendeu
        .map(u => {
          const totalDur = u.dataValues.totalDuration || 0;
          const avgDur   = u.dataValues.averageDuration || 0;
          // Quando totalDuration == avgDuration, foi só 1 ligação independente do inbound
          // Isso corrige duplicata de transferências no GoTo
          const realTotal = (totalDur > 0 && avgDur > 0)
            ? Math.round(totalDur / avgDur)
            : (u.dataValues.inboundVolume || 0) + (u.dataValues.outboundVolume || 0);
          const realInbound = Math.min(u.dataValues.inboundVolume || 0, realTotal);
          const queueCalls  = Math.min(u.dataValues.inboundQueueVolume || 0, realInbound);
          return {
            name: u.userName.replace(/\s*-\s*Sac\s*$/i, '').trim(),
            inbound: realInbound,
            outbound: u.dataValues.outboundVolume || 0,
            total: realTotal,
            queueCalls,
            avgDuration: avgDur ? fmtDur(avgDur) : '—',
            totalDuration: totalDur ? fmtDur(totalDur) : '—'
          };
        })
        .sort((a, b) => b.total - a.total);

      const totals = sacAgents.reduce((acc, a) => ({
        inbound: acc.inbound + a.inbound,
        outbound: acc.outbound + a.outbound,
        total: acc.total + a.total,
        queueCalls: acc.queueCalls + a.queueCalls
      }), { inbound: 0, outbound: 0, total: 0, queueCalls: 0 });

      // % atendimento por fila
      // Ligações atendidas por fila = soma de queueCalls dos agentes (já corrigido)
      // Ligações recebidas = phone-number-activity da fila
      const queuePerformance = Object.entries(SAC_QUEUES_MAP).map(([num, name]) => {
        const activity = queueActivity.find(q => q.number === num);
        const received = activity?.inbound || 0;
        const answered = sacAgents.reduce((sum, a) => sum + a.queueCalls, 0);
        return { queue: name, number: num, received, answered };
      }).filter(q => q.received > 0);

      return res.status(200).json({
        ...totals,
        agents: sacAgents,
        queuePerformance,
        sacNamesFound: sacNames.length,
        _phoneDebug: (phoneData.items||[]).slice(0,5).map(p => ({ name: p.phoneNumberName, number: p.phoneNumber, inbound: p.dataValues?.inboundCallVolume }))
      });
    }

    if (path === 'queue-status') {
      return res.status(200).json({ message: 'use queue-stats' });
    }

    if (path === 'queue-members') {
      // Busca detalhes completos de uma fila SAC para ver estrutura
      const queueId = 'abee458c-f2a0-48a1-a2aa-4ffbc60783ff'; // SAC PROCESSOS
      const attempts = [
        `/voice-admin/v1/call-queues/${queueId}`,
        `/voice-admin/v1/call-queues/${queueId}/agents`,
        `/voice-admin/v1/call-queues/${queueId}/lines`,
        `/voice-admin/v1/call-queues/${queueId}/subscribers`,
      ];
      const results = {};
      for (const p of attempts) {
        const d = await gotoGet(p, token).catch(e => ({ error: e.message }));
        results[p] = d;
      }
      return res.status(200).json(results);
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

      // Normaliza string: minúsculas + remove acentos
      const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

      // Função para checar se nome GoTo bate com algum agente Neppo
      const isSacAgent = (gotoName) => {
        if (!gotoName || !neppoAgentNames.length) return true;
        const cleanGoto = norm(gotoName).replace(/\s*-\s*\w.*$/, '').trim();
        return neppoAgentNames.some(neppoName => {
          const cleanNeppo = norm(neppoName).replace(/\s*-\s*\w.*$/, '').trim();
          if (cleanGoto === cleanNeppo) return true;
          const parts = cleanNeppo.split(' ').filter(Boolean);
          if (parts.length >= 2) {
            return cleanGoto.includes(parts[0]) && cleanGoto.includes(parts[1]);
          }
          return cleanGoto.startsWith(parts[0]);
        });
      };

      // Busca todos os usuários com paginação
      let allUsers = [];
      let nextMarker = null;
      do {
        const url = `/users/v1/users?accountKey=${ACCOUNT_KEY}${nextMarker ? '&pageMarker=' + nextMarker : ''}`;
        const page = await gotoGet(url, token);
        allUsers = allUsers.concat(page.items || []);
        nextMarker = page.nextPageMarker || null;
      } while (nextMarker && allUsers.length < 500);
      const usersData = { items: allUsers };

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

      // Status GoTo: AVAILABLE=disponível, BUSY/ON_A_CALL=em chamada, AWAY/DO_NOT_DISTURB=ausente, OFFLINE=offline
      // ONLINE = ramal conectado mas não necessariamente em chamada (tratar como disponível)
      const online  = agents.filter(a => ['AVAILABLE','ONLINE'].includes(a.status)).length;
      const busy    = agents.filter(a => ['BUSY','ON_A_CALL','RINGING'].includes(a.status)).length;
      const away    = agents.filter(a => ['AWAY','DO_NOT_DISTURB','IDLE'].includes(a.status)).length;
      const offline = agents.filter(a => a.status === 'OFFLINE').length;

      return res.status(200).json({
        totalAgents: agents.length,
        online, busy, away, offline,
        agents: agents.sort((a,b) => {
          const order = {'AVAILABLE':0,'ON_A_CALL':1,'BUSY':2,'AWAY':3,'IDLE':4,'ONLINE':5,'OFFLINE':6};
          return (order[a.status]??9) - (order[b.status]??9);
        }),
        neppoAgentsFound: neppoAgentNames.length,

      });
    }

    // Genérico
    const data = await gotoGet(`/${path}`, token);
    return res.status(200).json(data);
  } catch(err) {
    return res.status(500).json({ error: 'Erro GoTo: ' + err.message });
  }
}
