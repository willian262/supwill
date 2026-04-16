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
      // Busca todas as sessões ativas do SAC paginando
      const SAC_CONDITIONS = [
        { key: 'groupConf.operation.operationName', value: 'Sac', operator: 'EQ', logic: 'AND' },
        { key: 'status', value: 'CLOSED', operator: 'NEQ', logic: 'AND' }
      ];

      let sac = [];
      let page = 0;
      while (true) {
        const data = await neppoPost('/chatapi/1.0/api/user-session', {
          conditions: SAC_CONDITIONS,
          sort: true, sortColumn: 'id', direction: 'DESC', page, size: 50
        }, token);

        // Se retornou erro de autenticação, tentar renovar token
        if (data.fault || data.message || data.error) {
          if (page === 0) {
            // Forçar renovação do token e tentar novamente
            _neppoToken = null;
            _neppoExpires = 0;
            token = await getNeppoToken();
            const retry = await neppoPost('/chatapi/1.0/api/user-session', {
              conditions: SAC_CONDITIONS,
              sort: true, sortColumn: 'id', direction: 'DESC', page: 0, size: 50
            }, token);
            const retryBatch = retry.results || [];
            sac = sac.concat(retryBatch);
            page = 1;
            if (retryBatch.length < 50) break;
            continue;
          }
          break;
        }
        const batch = data.results || [];
        if (batch.length === 0) break;
        sac = sac.concat(batch);
        page++;
        if (page > 20) break; // segurança
      }

      const BOT_KEYWORDS = ['pesquisa', '@botserver', 'csat', 'nps', 'inatividade', 'inicial'];
      const isBot = name => {
        if (!name) return true;
        const lower = name.toLowerCase();
        return BOT_KEYWORDS.some(k => lower.includes(k));
      };

      const now = Date.now();

      // Mapa de agentes
      const agentMap = {};
      sac.forEach(s => {
        const name = s.agent?.displayName || null;
        if (isBot(name)) return;
        const agStatus = s.agent?.agent?.status || 'UNKNOWN';
        if (!agentMap[name]) {
          agentMap[name] = { name, status: agStatus, conversations: 0, waiting: 0 };
        }
        agentMap[name].conversations++;
        if (s.status === 'WAITING') agentMap[name].waiting++;
      });

      // Fila por grupo (aguardando) e total por grupo
      const groupQueue = {};
      const groupTotal = {};
      sac.filter(s => s.status === 'WAITING').forEach(s => {
        const g = s.groupConf?.name || 'Sem grupo';
        if (!groupQueue[g]) groupQueue[g] = 0;
        groupQueue[g]++;
      });
      sac.filter(s => !isBot(s.agent?.displayName)).forEach(s => {
        const g = s.groupConf?.name || 'Sem grupo';
        if (!groupTotal[g]) groupTotal[g] = { total: 0, waiting: 0 };
        groupTotal[g].total++;
        if (s.status === 'WAITING') groupTotal[g].waiting++;
      });

      // Cliente há mais tempo aguardando
      const waitingSessions = sac
        .filter(s => s.status === 'WAITING' && s.createdAt)
        .map(s => ({
          name: s.user?.displayName || s.user?.phone || 'Desconhecido',
          phone: s.user?.phone || '',
          group: s.groupConf?.name || '',
          waitMs: now - new Date(s.createdAt).getTime(),
          agent: s.agent?.displayName || null
        }))
        .sort((a,b) => b.waitMs - a.waitMs);

      // TME médio (tempo até ser atendido)
      const attended = sac.filter(s => s.attendedAt && s.createdAt);
      const avgTme = attended.length
        ? Math.round(attended.reduce((sum, s) =>
            sum + (new Date(s.attendedAt) - new Date(s.createdAt)), 0) / attended.length / 1000)
        : null;

      // TMA médio (tempo em atendimento)
      const inAttendance = sac.filter(s => s.status === 'OPEN' && s.attendedAt && !isBot(s.agent?.displayName));
      const avgTma = inAttendance.length
        ? Math.round(inAttendance.reduce((sum, s) =>
            sum + (now - new Date(s.attendedAt).getTime()), 0) / inAttendance.length / 1000)
        : null;

      // Histórico do dia
      const todayBR = new Date(now - 3*3600000).toISOString().slice(0,10);
      const abertasHoje = sac.filter(s => {
        if (!s.createdAt) return false;
        return new Date(new Date(s.createdAt).getTime() - 3*3600000).toISOString().slice(0,10) === todayBR;
      }).length;

      const agents = Object.values(agentMap).sort((a,b) => b.conversations - a.conversations);

      // Contadores
      const online   = agents.filter(a => a.status === 'ONLINE').length;
      const paused   = agents.filter(a => !['ONLINE','OFFLINE'].includes(a.status)).length;
      const offline  = agents.filter(a => a.status === 'OFFLINE').length;
      const waiting  = sac.filter(s => s.status === 'WAITING').length;
      const inQueue  = sac.filter(s => isBot(s.agent?.displayName)).length;

      const fmtTime = secs => {
        if (!secs) return null;
        if (secs < 60) return `${secs}s`;
        if (secs < 3600) return `${Math.floor(secs/60)}m ${secs%60}s`;
        return `${Math.floor(secs/3600)}h ${Math.floor((secs%3600)/60)}m`;
      };

      return res.status(200).json({
        totalConversations: sac.length,
        totalAgents: agents.length,
        online, paused, offline,
        waiting, inQueue,
        avgTme: avgTme ? fmtTime(avgTme) : null,
        avgTma: avgTma ? fmtTime(avgTma) : null,
        abertasHoje,
        longestWaiting: waitingSessions.slice(0,5).map(s => ({
          name: s.name,
          group: s.group,
          agent: s.agent,
          waitTime: fmtTime(Math.round(s.waitMs/1000))
        })),
        groupQueue: Object.entries(groupQueue).sort((a,b)=>b[1]-a[1]).map(([g,c])=>({group:g,count:c})),
        groupTotal: Object.entries(groupTotal).sort((a,b)=>b[1].total-a[1].total).map(([g,v])=>({group:g,...v})),
        agents,
        _sessions: sac.map(s => ({
          status: s.status,
          createdAt: s.createdAt,
          attendedAt: s.attendedAt,
          user: { displayName: s.user?.displayName || null, phone: s.user?.phone || null },
          agent: { displayName: s.agent?.displayName || null },
          groupConf: { name: s.groupConf?.name || null }
        }))
      });
    }

    if (path === 'response-time') {
      // Tempo médio de resposta por agente — baseado nas sessões SAC ativas + fechadas hoje
      const todayStart = new Date();
      todayStart.setHours(0,0,0,0);
      const todayISO = todayStart.toISOString();

      // Buscar sessões SAC ativas (sem filtro de data — pegar as atuais)
      let sessions = [];
      let page = 0;
      while (true) {
        const data = await neppoPost('/chatapi/1.0/api/user-session', {
          conditions: [
            { key: 'groupConf.operation.operationName', value: 'Sac', operator: 'EQ', logic: 'AND' },
            { key: 'status', value: 'CLOSED', operator: 'NEQ', logic: 'AND' }
          ],
          sort: true, sortColumn: 'id', direction: 'DESC', page, size: 50
        }, token);
        if (data.fault || data.message || data.error) break;
        const batch = data.results || [];
        if (batch.length === 0) break;
        sessions = sessions.concat(batch);
        page++;
        if (page > 10) break;
      }

      // Agrupar por agente e calcular TMA (tempo médio de atendimento)
      const agentMap = {};
      const BOT_KW = ['pesquisa','@botserver','csat','nps','inatividade','inicial'];
      const isBot = n => !n || BOT_KW.some(k => (n||'').toLowerCase().includes(k));

      sessions.forEach(s => {
        const name = s.agent?.displayName;
        if (isBot(name)) return;
        if (!s.tma && !s.tme) return; // sem dados de tempo
        if (!agentMap[name]) agentMap[name] = { name, tmaTotal: 0, tmeTotal: 0, count: 0 };
        if (s.tma) agentMap[name].tmaTotal += s.tma;
        if (s.tme) agentMap[name].tmeTotal += s.tme;
        agentMap[name].count++;
      });

      const fmtMs = ms => {
        if (!ms) return null;
        const s = Math.round(ms / 1000);
        if (s < 60) return s + 's';
        if (s < 3600) return Math.floor(s/60) + 'm ' + (s%60) + 's';
        return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
      };

      const agents = Object.values(agentMap)
        .filter(a => a.count > 0)
        .map(a => ({
          name: a.name,
          count: a.count,
          avgTma: a.tmaTotal ? fmtMs(Math.round(a.tmaTotal / a.count)) : null,
          avgTme: a.tmeTotal ? fmtMs(Math.round(a.tmeTotal / a.count)) : null,
        }))
        .sort((a,b) => b.count - a.count);

      // Debug: mostrar campos de uma sessão para entender estrutura
      const sample = sessions[0] ? {
        tme: sessions[0].tme,
        tma: sessions[0].tma,
        attendedAt: sessions[0].attendedAt,
        createdAt: sessions[0].createdAt,
        fields: Object.keys(sessions[0]).filter(k => k.includes('time') || k.includes('Time') || k.includes('tme') || k.includes('tma') || k.includes('response'))
      } : null;

      return res.status(200).json({ agents, totalSessions: sessions.length, sample });
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

    if (path === 'history-test') {
      // Testa se a API aceita filtro por data em sessões fechadas (para histórico)
      const results = {};

      // Teste 1: Sessões CLOSED com createdAt AFTER (últimos 7 dias)
      const since7d = new Date(Date.now() - 7 * 24 * 3600000).toISOString();
      const t1 = await neppoPost('/chatapi/1.0/api/user-session', {
        conditions: [
          { key: 'groupConf.operation.operationName', value: 'Sac', operator: 'EQ', logic: 'AND' },
          { key: 'status', value: 'CLOSED', operator: 'EQ', logic: 'AND' },
          { key: 'createdAt', value: since7d, operator: 'AFTER', logic: 'AND' }
        ],
        sort: true, sortColumn: 'createdAt', direction: 'DESC', page: 0, size: 5
      }, token);
      results.closedAfter7d = { total: t1.size, count: (t1.results||[]).length, error: t1.message||t1.fault||null };

      // Teste 2: Qualquer status SAC com createdAt AFTER (últimos 7 dias)
      const t2 = await neppoPost('/chatapi/1.0/api/user-session', {
        conditions: [
          { key: 'groupConf.operation.operationName', value: 'Sac', operator: 'EQ', logic: 'AND' },
          { key: 'createdAt', value: since7d, operator: 'AFTER', logic: 'AND' }
        ],
        sort: true, sortColumn: 'createdAt', direction: 'DESC', page: 0, size: 5
      }, token);
      results.anyStatusAfter7d = {
        total: t2.size, count: (t2.results||[]).length, error: t2.message||t2.fault||null,
        statusSample: (t2.results||[]).map(s => ({ status: s.status, createdAt: s.createdAt, id: s.id }))
      };

      // Teste 3: Últimos 30 dias
      const since30d = new Date(Date.now() - 30 * 24 * 3600000).toISOString();
      const t3 = await neppoPost('/chatapi/1.0/api/user-session', {
        conditions: [
          { key: 'groupConf.operation.operationName', value: 'Sac', operator: 'EQ', logic: 'AND' },
          { key: 'createdAt', value: since30d, operator: 'AFTER', logic: 'AND' }
        ],
        sort: true, sortColumn: 'createdAt', direction: 'DESC', page: 0, size: 3
      }, token);
      results.anyStatus30d = {
        total: t3.size, count: (t3.results||[]).length, error: t3.message||t3.fault||null
      };

      // Teste 4: Campos disponíveis numa sessão fechada
      const t4 = await neppoPost('/chatapi/1.0/api/user-session', {
        conditions: [
          { key: 'groupConf.operation.operationName', value: 'Sac', operator: 'EQ', logic: 'AND' },
          { key: 'status', value: 'CLOSED', operator: 'EQ', logic: 'AND' }
        ],
        sort: true, sortColumn: 'id', direction: 'DESC', page: 0, size: 1
      }, token);
      results.closedFields = t4.results?.[0] ? Object.keys(t4.results[0]) : [];
      results.closedSample = t4.results?.[0] || null;

      return res.status(200).json(results);
    }

    if (path === 'debug') {
      // Debug: mais recentes primeiro, operação SAC
      const data = await neppoPost('/chatapi/1.0/api/user-session', {
        conditions: [
          { key: 'groupConf.operation.operationName', value: 'Sac', operator: 'EQ', logic: 'AND' }
        ],
        sort: true, sortColumn: 'id', direction: 'DESC', page: 0, size: 20
      }, token);
      const preview = (data.results || []).map(s => ({
        id: s.id,
        status: s.status,
        agentName: s.agent?.displayName,
        groupName: s.groupConf?.name,
        operationName: s.groupConf?.operation?.operationName,
        createdAt: s.createdAt,
        attendedAt: s.attendedAt,
        tme: s.tme,
        userDisplayName: s.user?.displayName
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
