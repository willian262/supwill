# NeoSolar — Painel SAC

Dashboard para acompanhamento de tickets do Zoho Desk em tempo real.

## Como fazer o deploy no Vercel.

### 1. Pré-requisito
Crie uma conta gratuita em https://vercel.com (pode entrar com GitHub, Google ou e-mail).

### 2. Deploy via interface (mais simples)
1. Acesse https://vercel.com/new
2. Escolha **"Deploy from template"** → **"Browse templates"** → ou arraste a pasta diretamente
3. Na tela de upload, selecione a pasta `neosolar-sac` inteira
4. Clique em **Deploy**
5. Em ~30 segundos você terá um link público (ex: `neosolar-sac.vercel.app`)

### 3. Deploy via CLI (opcional)
```bash
npm install -g vercel
cd neosolar-sac
vercel
```

---

## Configuração do Zoho Desk

### Onde encontrar o API Token (Zapitoken)
1. Faça login no Zoho Desk
2. Vá em **Settings → Developer Space → API**
3. Copie o **Zapitoken**

### Onde encontrar o Org ID
1. Vá em **Settings → General → Account Details**
2. O **Org ID** aparece no topo

### Como inserir no painel
1. Acesse a URL do seu painel
2. Clique em **⚙ Configurar** (canto superior direito)
3. Preencha Org ID, API Key e domínio
4. Clique em **Salvar e conectar**

As credenciais ficam salvas apenas no **navegador local** (localStorage) de quem acessar. Cada usuário precisará inserir uma vez.

---

## Domínio do Zoho por região

| Região | Domínio |
|--------|---------|
| Global | desk.zoho.com |
| Europa | desk.zoho.eu |
| Índia  | desk.zoho.in |
| Austrália | desk.zoho.com.au |

---

## Funcionalidades

- **Métricas principais**: tickets abertos, SLA cumprido, TMA médio, escalados
- **Tickets por status**: barra visual com abertos, pendentes, escalados, resolvidos
- **TMA por categoria**: tempo médio por tipo de atendimento
- **Volume por agente**: distribuição visual com alerta de sobrecarga
- **Tickets críticos**: lista com SLA em risco ou rompido
- **Atualização automática** a cada 5 minutos
- **Alerta visual** quando há tickets com SLA rompido ou em risco

---

## Expansões futuras

- Volume por canal (e-mail, telefone, chat)
- Histórico 7/30 dias com gráfico de tendência
- Filtro por agente ou categoria
- Notificação por e-mail/WhatsApp quando SLA romper
- Multi-departamento
