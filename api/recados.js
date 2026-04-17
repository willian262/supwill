// api/recados.js — Busca o recado do dia na planilha Google Sheets
const SPREADSHEET_ID = '1gi5Xncd24q8cUwhG7-AxxY9ZRlO1CKBbSPPEen_ugT0';
const SHEET_NAME     = 'Página1';
const RANGE          = `${SHEET_NAME}!A2:B200`; // dados a partir da linha 2 (linha 1 é cabeçalho)

// Gera JWT para autenticar com a Google API
async function getAccessToken() {
  const email      = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  const now = Math.floor(Date.now() / 1000);
  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const sigInput = `${b64(header)}.${b64(payload)}`;

  // Importar chave privada RSA
  const keyData = privateKey
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');

  const { createSign } = await import('crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(sigInput);
  const signature = sign.sign(
    `-----BEGIN PRIVATE KEY-----\n${keyData}\n-----END PRIVATE KEY-----`,
    'base64url'
  );

  const jwt = `${sigInput}.${signature}`;

  // Trocar JWT por access token
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  const data = await resp.json();
  if (!data.access_token) throw new Error('Token error: ' + JSON.stringify(data));
  return data.access_token;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300'); // cache 5 min no Vercel

  try {
    const token = await getAccessToken();

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(RANGE)}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(JSON.stringify(data));

    const rows = data.values || [];

    // Data de hoje no fuso de Brasília
    const hoje = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const dd   = String(hoje.getDate()).padStart(2, '0');
    const mm   = String(hoje.getMonth() + 1).padStart(2, '0');
    const yyyy = hoje.getFullYear();
    const hojeStr = `${dd}/${mm}/${yyyy}`; // formato da planilha

    // Procurar recado do dia (coluna A = data, coluna B = recado)
    let recadoHoje = null;
    for (const row of rows) {
      const dataCell   = (row[0] || '').trim();
      const recadoCell = (row[1] || '').trim();
      if (!recadoCell) continue;

      // Normalizar data — planilha pode ter dd/mm/yyyy ou mm/dd/yyyy (Excel)
      let dataFormatada = dataCell;
      // Se vier como número serial do Excel (ex: 46027)
      if (/^\d{5}$/.test(dataCell)) {
        const d = new Date((parseInt(dataCell) - 25569) * 86400000);
        const dBR = new Date(d.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
        dataFormatada = `${String(dBR.getDate()).padStart(2,'0')}/${String(dBR.getMonth()+1).padStart(2,'0')}/${dBR.getFullYear()}`;
      }

      if (dataFormatada === hojeStr) {
        recadoHoje = recadoCell;
        break;
      }
    }

    return res.status(200).json({
      hoje: hojeStr,
      recado: recadoHoje, // null se não tiver recado hoje
    });

  } catch (err) {
    console.error('recados.js error:', err);
    return res.status(500).json({ error: err.message });
  }
}
