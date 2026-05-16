# SockeText — Chat Multiusuário com Failover Automático

Chat em tempo real com arquitetura cliente-servidor, threads por conexão, banco de dados compartilhado e tolerância a falhas com failover automático entre servidor primário e secundário.

## Arquitetura

```
┌─────────────────────────────────────────────────────────────┐
│                        RENDER.COM                           │
│                                                             │
│  ┌──────────────┐     ┌──────────────┐    ┌─────────────┐ │
│  │   Primário   │     │  Secundário  │    │  PostgreSQL │ │
│  │  Flask +     │     │  Flask +     │    │  (único     │ │
│  │  SocketIO    │     │  SocketIO    │    │   banco)    │ │
│  │  (threads)   │     │  (threads)   │    │             │ │
│  └──────┬───────┘     └──────┬───────┘    └──────┬──────┘ │
│         │                    │                   │         │
│         └──────────┬─────────┘                   │         │
│                    │      ambos lêem/escrevem     │         │
│                    └──────────────────────────────┘         │
└────────────────────────────┬────────────────────────────────┘
                             │ WebSocket
                    ┌────────┴────────┐
                    │   Navegador     │
                    │   (cliente)     │
                    │                 │
                    │  1. Conecta ao  │
                    │     primário    │
                    │  2. Se cair →   │
                    │     failover    │
                    │     instantâneo │
                    │     p/ secundár │
                    └─────────────────┘
```

## Requisitos atendidos

| Requisito | Como atendido |
|-----------|--------------|
| Comunicação simultânea múltiplos usuários | Flask-SocketIO com rooms |
| Thread por conexão de cliente | `async_mode="threading"` no Flask-SocketIO |
| Thread dedicada à recepção (cliente) | Socket.IO JS roda em loop de eventos separado |
| Acesso via navegador | Static site no Render + HTML/CSS/JS puro |
| Tolerância a falhas / replicação | 2 servidores Flask + PostgreSQL compartilhado |
| Failover automático | Cliente detecta disconnect e reconecta ao secundário |
| Histórico preservado | Banco de dados único lido por ambos os servidores |

## Deploy no Render (passo a passo)

### 1. Suba o repositório para o GitHub

```bash
git init
git add .
git commit -m "SockeText inicial"
git remote add origin https://github.com/SEU_USUARIO/socketext.git
git push -u origin main
```

### 2. Crie o Blueprint no Render

1. Acesse [render.com](https://render.com) → **New** → **Blueprint**
2. Conecte seu repositório GitHub
3. O Render vai detectar o `render.yaml` e criar automaticamente:
   - `socketext-db` — PostgreSQL
   - `socketext-primary` — Servidor primário
   - `socketext-secondary` — Servidor secundário
   - `socketext-client` — Site estático do frontend

### 3. Anote as URLs após o deploy

Após o build, você verá algo como:
- Primário: `https://socketext-primary.onrender.com`
- Secundário: `https://socketext-secondary.onrender.com`
- Cliente: `https://socketext-client.onrender.com`

### 4. Atualize as URLs no cliente

Edite `client/script.js`, seção `CONFIG`:

```javascript
const CONFIG = {
  PRIMARY_URL:   "https://socketext-primary.onrender.com",    // ← sua URL real
  SECONDARY_URL: "https://socketext-secondary.onrender.com",  // ← sua URL real
  ROOM: "geral",
};
```

Faça commit e push — o Render vai re-deployar o cliente automaticamente.

### 5. Mantenha o secundário "quente"

O Render free tier hiberna serviços sem requisições. Para garantir que o secundário responda instantaneamente:

- Use [UptimeRobot](https://uptimerobot.com) (gratuito) para fazer ping a cada 14 minutos em `https://socketext-secondary.onrender.com/health`
- Ou deixe uma aba do browser aberta com o link do secundário

## Como funciona o failover

1. Todos os usuários se conectam ao **primário** via WebSocket
2. Você clica em **"Derrubar Primário"** no header do chat
3. O cliente envia `POST /admin/kill` ao primário → o processo Flask termina em 500ms
4. O Socket.IO detecta a desconexão em ~1 segundo (timeout de transporte TCP)
5. O cliente **imediatamente** conecta ao secundário (sem recarregar a página)
6. O secundário carrega o histórico do banco compartilhado
7. Um banner amarelo confirma a migração

## Estrutura de arquivos

```
socketext/
├── render.yaml                  ← Blueprint completo do Render
├── server_primary/
│   ├── app.py                   ← Servidor Flask primário
│   ├── requirements.txt
│   └── gunicorn.conf.py
├── server_secondary/
│   ├── app.py                   ← Servidor Flask secundário
│   ├── requirements.txt
│   └── gunicorn.conf.py
└── client/
    ├── index.html               ← Interface (modal + chat + botão kill)
    ├── style.css                ← Estilos (dark theme)
    └── script.js                ← Lógica de conexão + failover automático
```

## Testando localmente

```bash
# Terminal 1 — Primário
cd server_primary
pip install -r requirements.txt
PORT=5001 python app.py

# Terminal 2 — Secundário
cd server_secondary
PORT=5002 python app.py

# No client/script.js, mude temporariamente:
# PRIMARY_URL:   "http://localhost:5001"
# SECONDARY_URL: "http://localhost:5002"

# Abra client/index.html no navegador (com Live Server ou similar)
```
