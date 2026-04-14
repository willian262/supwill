const GOTO_AUTH = 'https://authentication.logmeininc.com/oauth/token';
const GOTO_BASE = 'https://api.goto.com';

let _gotoToken = null;
let _gotoExpires = 0;

async function getGotoToken() {
  if (_gotoToken && Date.now() < _gotoExpires) return _gotoToken;

  const basicAuth = Buffer.from(
    `${process.env.GOTO_CLIENT_ID}:${process.env.GOTO_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetch(GOTO_AUTH, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' })
  });

  const data = await res.json();
  if (!data.access_token) throw new Error('GoTo token falhou: ' + JSON.stringify(data));

  _gotoToken   = data.access_token;
  _gotoExpires = Date.now() + (data.expires_in - 60) * 1000;
  return _gotoToken;
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

  const { path } = req.query;
  if (!path) return res.status(400).json({ error: 'path obrigatório' });

  let token;
  try {
    token = await getGotoToken();
  } catch(err) {
    return res.status(401).json({ error: 'Falha ao obter token GoTo', detail: err.message });
  }

  try {
    if (path === 'me') {
      // Descobrir accountKey do usuário
      const data = await gotoGet('/users/v1/me', token);
      return res.status(200).json(data);
    }

    if (path === 'accounts') {
      const data = await gotoGet('/users/v1/accounts', token);
      return res.status(200).json(data);
    }

    // Path genérico
    const data = await gotoGet(`/${path}`, token);
    return res.status(200).json(data);

  } catch(err) {
    return res.status(500).json({ error: 'Erro GoTo: ' + err.message, cause: err.cause?.message });
  }
}
