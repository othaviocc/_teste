/**
 * SockeText — Cliente com failover automático
 *
 * Arquitetura de failover:
 *  1. Sempre tenta conectar ao servidor PRIMÁRIO primeiro.
 *  2. Quando o primário cai, o Socket.IO detecta a desconexão em ~1s
 *     (via ping_timeout=10, ping_interval=5 no servidor, mas a
 *     detecção de transporte TCP falha muito mais rápido).
 *  3. O cliente imediatamente tenta o SECUNDÁRIO sem recarregar a página.
 *  4. O histórico de mensagens é recarregado do banco compartilhado.
 *  5. Um banner e badge informam o usuário da troca.
 *
 * Variáveis de ambiente (substituídas em build ou definidas aqui):
 *   PRIMARY_URL   — URL do servidor primário no Render
 *   SECONDARY_URL — URL do servidor secundário no Render
 */

(function () {
  "use strict";

  /* ──────────────────────────────────────────────────────────────────────
     CONFIGURAÇÃO — Edite estas URLs após o deploy no Render
     ────────────────────────────────────────────────────────────────────── */
  const CONFIG = {
    // Substitua pelos URLs reais após o deploy:
    PRIMARY_URL:   window.PRIMARY_URL   || "https://socketext-primary.onrender.com",
    SECONDARY_URL: window.SECONDARY_URL || "https://socketext-secondary.onrender.com",
    ROOM: "geral",
  };

  /* ── Estado ─────────────────────────────────────────────────────────── */
  let socket       = null;
  let username     = "";
  let currentServer = "primary";   // "primary" | "secondary"
  let typingTimeout = null;
  let isTyping     = false;
  let reconnecting = false;
  let typingUsers  = new Set();
  let historyLoaded = false;

  /* ── DOM ─────────────────────────────────────────────────────────────── */
  const modalOverlay   = document.getElementById("modalOverlay");
  const usernameInput  = document.getElementById("usernameInput");
  const joinBtn        = document.getElementById("joinBtn");
  const chatWrapper    = document.getElementById("chatWrapper");
  const messagesEl     = document.getElementById("messages");
  const inputEl        = document.getElementById("msgInput");
  const sendBtn        = document.getElementById("sendBtn");
  const statusDot      = document.getElementById("statusDot");
  const statusLabel    = document.getElementById("statusLabel");
  const serverBadge    = document.getElementById("serverBadge");
  const serverBadgeLabel = document.getElementById("serverBadgeLabel");
  const killBtn        = document.getElementById("killBtn");
  const usersToggleBtn = document.getElementById("usersToggleBtn");
  const usersPanel     = document.getElementById("usersPanel");
  const usersList      = document.getElementById("usersList");
  const usersCount     = document.getElementById("usersCount");
  const failoverBanner = document.getElementById("failoverBanner");
  const failoverMsg    = document.getElementById("failoverMsg");
  const typingStatus   = document.getElementById("typingStatus");


  /* ══════════════════════════════════════════════════════════════════════
     MODAL DE IDENTIFICAÇÃO
     ════════════════════════════════════════════════════════════════════ */
  function openChat(name) {
    username = name.trim();
    if (!username) return;

    modalOverlay.style.display = "none";
    chatWrapper.style.display  = "flex";

    connectTo("primary");
  }

  joinBtn.addEventListener("click", () => openChat(usernameInput.value));
  usernameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") openChat(usernameInput.value);
  });


  /* ══════════════════════════════════════════════════════════════════════
     CONEXÃO / FAILOVER
     ════════════════════════════════════════════════════════════════════ */

  /**
   * Conecta ao servidor especificado.
   * Se já houver um socket, desconecta antes.
   *
   * @param {"primary"|"secondary"} server
   */
  function connectTo(server) {
    const url = server === "primary" ? CONFIG.PRIMARY_URL : CONFIG.SECONDARY_URL;
    currentServer = server;

    setStatus("connecting");
    updateServerBadge(server);

    // Desconecta socket anterior sem disparar lógica de failover
    if (socket) {
      socket.off();   // remove todos os listeners antes de destruir
      socket.disconnect();
      socket = null;
    }

    console.log(`[SockeText] Conectando ao servidor ${server}: ${url}`);

    socket = io(url, {
      transports: ["websocket"],   // WebSocket puro, sem long-polling
      reconnection: false,         // gerenciamos o reconnect manualmente
      timeout: 8000,
    });

    // ── Eventos de ciclo de vida ─────────────────────────────────────
    socket.on("connect", () => {
      console.log(`[SockeText] Conectado ao ${server} (sid: ${socket.id})`);
      reconnecting = false;
      setStatus("online");

      // Entra na sala com o username
      socket.emit("join", { username, room: CONFIG.ROOM });

      // Se for failover, mostra banner
      if (server === "secondary") {
        showFailoverBanner();
      }
    });

    socket.on("connect_error", (err) => {
      console.warn(`[SockeText] Erro de conexão no ${server}:`, err.message);
      if (server === "primary" && !reconnecting) {
        failoverToSecondary("Servidor primário inacessível");
      } else {
        setStatus("offline");
      }
    });

    socket.on("disconnect", (reason) => {
      console.warn(`[SockeText] Desconectado do ${server}:`, reason);

      // "io server disconnect" = servidor fechou a conexão deliberadamente
      // "transport close" / "transport error" = conexão caiu
      if (server === "primary" && !reconnecting) {
        const shouldFailover = [
          "transport close",
          "transport error",
          "ping timeout",
          "io server disconnect",
        ].includes(reason);

        if (shouldFailover) {
          failoverToSecondary(`Servidor primário caiu (${reason})`);
        }
      } else if (server === "secondary") {
        // Tenta reconectar ao secundário
        setStatus("connecting");
        setTimeout(() => connectTo("secondary"), 2000);
      }
    });

    // ── Eventos da aplicação ─────────────────────────────────────────
    socket.on("server_info", (data) => {
      console.log(`[SockeText] Servidor informou role: ${data.role}`);
      updateServerBadge(data.role === "primary" ? "primary" : "secondary");
    });

    socket.on("history", (messages) => {
      // Recebemos o histórico após o join — renderiza tudo
      if (!historyLoaded) {
        renderHistory(messages);
        historyLoaded = true;
      }
    });

    socket.on("message", (msg) => {
      renderMessage(msg);
    });

    socket.on("user_joined", (data) => {
      addSystemMessage(`${data.username} entrou no chat`);
    });

    socket.on("user_left", (data) => {
      addSystemMessage(`${data.username} saiu do chat`);
    });

    socket.on("user_list", (users) => {
      renderUserList(users);
    });

    socket.on("typing", (data) => {
      typingUsers.add(data.username);
      updateTypingStatus();
    });

    socket.on("stop_typing", (data) => {
      typingUsers.delete(data.username);
      updateTypingStatus();
    });
  }

  /**
   * Failover instantâneo para o servidor secundário.
   * Chama connectTo("secondary") imediatamente — sem delay.
   */
  function failoverToSecondary(reason) {
    if (reconnecting) return;
    reconnecting = true;

    console.warn(`[SockeText] FAILOVER → secundário. Motivo: ${reason}`);
    setStatus("connecting");

    // Sem setTimeout: troca imediata
    connectTo("secondary");
  }


  /* ══════════════════════════════════════════════════════════════════════
     BOTÃO KILL — derruba o servidor primário para demonstração
     ════════════════════════════════════════════════════════════════════ */
  killBtn.addEventListener("click", async () => {
    if (killBtn.disabled) return;

    if (!confirm("Derrubar o servidor primário? O chat vai migrar automaticamente para o secundário.")) {
      return;
    }

    killBtn.disabled = true;

    try {
      // Chama o endpoint /admin/kill no primário via fetch normal
      // (não precisa que o socket esteja conectado)
      await fetch(`${CONFIG.PRIMARY_URL}/admin/kill`, {
        method: "POST",
        mode: "cors",
      });
      // O servidor vai morrer — a desconexão do socket vai disparar o failover
      addSystemMessage("⚡ Servidor primário sendo derrubado...", "warn");
    } catch {
      // O fetch pode falhar se o servidor caiu antes de responder — tudo bem
      addSystemMessage("⚡ Servidor primário sendo derrubado...", "warn");
    }
  });


  /* ══════════════════════════════════════════════════════════════════════
     ENVIO DE MENSAGEM
     ════════════════════════════════════════════════════════════════════ */
  function sendMessage() {
    const text = inputEl.value.trim();
    if (!text || !socket || !socket.connected) return;

    socket.emit("message", { text, room: CONFIG.ROOM });

    inputEl.value = "";
    inputEl.style.height = "auto";

    stopTyping();
  }

  sendBtn.addEventListener("click", sendMessage);

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-resize textarea
  inputEl.addEventListener("input", function () {
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 100) + "px";
    handleTyping();
  });


  /* ══════════════════════════════════════════════════════════════════════
     INDICADOR DE DIGITAÇÃO
     ════════════════════════════════════════════════════════════════════ */
  function handleTyping() {
    if (!socket || !socket.connected) return;

    if (!isTyping) {
      isTyping = true;
      socket.emit("typing", { room: CONFIG.ROOM });
    }

    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(stopTyping, 2500);
  }

  function stopTyping() {
    if (isTyping && socket && socket.connected) {
      isTyping = false;
      socket.emit("stop_typing", { room: CONFIG.ROOM });
    }
    clearTimeout(typingTimeout);
  }

  function updateTypingStatus() {
    const others = [...typingUsers].filter(u => u !== username);
    if (others.length === 0) {
      typingStatus.textContent = "";
    } else if (others.length === 1) {
      typingStatus.textContent = `${others[0]} está digitando...`;
    } else {
      typingStatus.textContent = `${others.join(", ")} estão digitando...`;
    }
  }


  /* ══════════════════════════════════════════════════════════════════════
     RENDERIZAÇÃO
     ════════════════════════════════════════════════════════════════════ */
  function renderHistory(messages) {
    // Limpa mensagens existentes (mantém o date-divider)
    const divider = messagesEl.querySelector(".date-divider");
    messagesEl.innerHTML = "";
    if (divider) messagesEl.appendChild(divider);

    messages.forEach(renderMessage);
  }

  function renderMessage(msg) {
    const direction = msg.sender === username ? "outgoing" : "incoming";
    const row = document.createElement("div");
    row.className = `msg-row ${direction}`;

    const senderHTML = direction === "incoming"
      ? `<div class="msg-sender">${escapeHTML(msg.sender)}</div>`
      : "";

    row.innerHTML = `
      ${senderHTML}
      <div class="msg-bubble">${escapeHTML(msg.text)}</div>
      <div class="msg-time">${msg.timestamp || getTime()}</div>
    `;

    messagesEl.appendChild(row);
    scrollToBottom();
  }

  function addSystemMessage(text, variant = "") {
    const el = document.createElement("div");
    el.className = `system-msg${variant ? " " + variant : ""}`;
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function renderUserList(users) {
    usersCount.textContent = users.length;
    usersList.innerHTML = users
      .map(u => `<li>${escapeHTML(u)}</li>`)
      .join("");
  }


  /* ══════════════════════════════════════════════════════════════════════
     UI — STATUS / BADGE / BANNER
     ════════════════════════════════════════════════════════════════════ */
  function setStatus(state) {
    const colors = {
      online:     "var(--green)",
      offline:    "var(--danger)",
      connecting: "var(--warn)",
    };
    const labels = {
      online:     "ao vivo",
      offline:    "desconectado",
      connecting: "conectando...",
    };
    statusDot.style.background = colors[state] || colors.connecting;
    statusLabel.textContent    = labels[state]  || state;
  }

  function updateServerBadge(server) {
    serverBadge.className = `server-badge ${server}`;
    serverBadgeLabel.textContent = server === "primary" ? "primary" : "secondary";
  }

  function showFailoverBanner() {
    failoverBanner.hidden = false;
    failoverMsg.textContent = "Servidor primário caiu — conectado ao secundário ✓";
    addSystemMessage("🔄 Migrado para o servidor secundário — histórico preservado", "warn");
  }

  // Painel de usuários
  usersToggleBtn.addEventListener("click", () => {
    usersPanel.hidden = !usersPanel.hidden;
  });


  /* ══════════════════════════════════════════════════════════════════════
     HELPERS
     ════════════════════════════════════════════════════════════════════ */
  function getTime() {
    const d = new Date();
    return d.getHours().toString().padStart(2, "0") + ":" +
           d.getMinutes().toString().padStart(2, "0");
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function escapeHTML(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

})();
