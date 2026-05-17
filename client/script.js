(function () {
  "use strict";

  const CONFIG = {
    PRIMARY_URL:   "https://socketext-primary.onrender.com",
    SECONDARY_URL: "https://socketext-secondary.onrender.com",
    ROOM: "geral",
  };

  /* ── Estado ── */
  let socket          = null;
  let username        = "";
  let currentServer   = "primary";
  let typingTimeout   = null;
  let isTyping        = false;
  let reconnecting    = false;
  let typingUsers     = new Set();
  let historyLoaded   = false;
  let failedOver      = false;   // true = já fez failover, não mostrar banner de novo

  /* ── DOM ── */
  const modalOverlay     = document.getElementById("modalOverlay");
  const usernameInput    = document.getElementById("usernameInput");
  const joinBtn          = document.getElementById("joinBtn");
  const chatWrapper      = document.getElementById("chatWrapper");
  const messagesEl       = document.getElementById("messages");
  const inputEl          = document.getElementById("msgInput");
  const sendBtn          = document.getElementById("sendBtn");
  const statusDot        = document.getElementById("statusDot");
  const statusLabel      = document.getElementById("statusLabel");
  const serverBadge      = document.getElementById("serverBadge");
  const serverBadgeLabel = document.getElementById("serverBadgeLabel");
  const killBtn          = document.getElementById("killBtn");
  const usersToggleBtn   = document.getElementById("usersToggleBtn");
  const usersPanel       = document.getElementById("usersPanel");
  const usersList        = document.getElementById("usersList");
  const usersCount       = document.getElementById("usersCount");
  const failoverBanner   = document.getElementById("failoverBanner");
  const failoverMsg      = document.getElementById("failoverMsg");
  const typingStatusEl   = document.getElementById("typingStatus");

  /* ══════════════════════════════════════════════════════
     MODAL
  ══════════════════════════════════════════════════════ */
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

  /* ══════════════════════════════════════════════════════
     CONEXÃO / FAILOVER
  ══════════════════════════════════════════════════════ */
  function connectTo(server) {
    const url = server === "primary" ? CONFIG.PRIMARY_URL : CONFIG.SECONDARY_URL;
    currentServer = server;
    setStatus("connecting");
    updateServerBadge(server);

    if (socket) {
      socket.off();
      socket.disconnect();
      socket = null;
    }

    socket = io(url, {
      transports: ["websocket"],
      reconnection: false,
      timeout: 6000,
    });

    socket.on("connect", () => {
      reconnecting = false;
      setStatus("online");
      socket.emit("join", { username, room: CONFIG.ROOM });

      // Banner de failover: só aparece quando realmente migrou pro secundário
      if (server === "secondary" && failedOver) {
        showFailoverBanner("secundário");
      }
      // Banner de retorno ao primário
      if (server === "primary" && failedOver) {
        showReturnBanner();
        failedOver = false;
      }

      // Botão kill: só habilitado no primário
      killBtn.disabled = (server === "secondary");
      killBtn.style.opacity = (server === "secondary") ? "0.3" : "1";
    });

    socket.on("connect_error", () => {
      if (server === "primary" && !reconnecting) {
        doFailover();
      } else if (server === "secondary") {
        setStatus("offline");
        // Tenta secundário de novo em 3s
        setTimeout(() => connectTo("secondary"), 3000);
      }
    });

    socket.on("disconnect", (reason) => {
      const dropped = ["transport close","transport error","ping timeout","io server disconnect"];
      if (server === "primary" && !reconnecting && dropped.includes(reason)) {
        doFailover();
      } else if (server === "secondary" && dropped.includes(reason)) {
        setStatus("connecting");
        setTimeout(() => connectTo("secondary"), 2000);
      }
    });

    /* ── Eventos da app ── */
    socket.on("server_info", (data) => {
      updateServerBadge(data.role === "primary" ? "primary" : "secondary");
    });

    socket.on("history", (messages) => {
      renderHistory(messages);
      historyLoaded = true;
    });

    socket.on("message", renderMessage);

    socket.on("user_joined", (data) => {
      // Só mostra "X entrou" se for outra pessoa
      if (data.username !== username) {
        addSystemMessage(`${data.username} entrou no chat`);
      }
    });

    socket.on("user_left", (data) => {
      if (data.username !== username) {
        addSystemMessage(`${data.username} saiu do chat`);
      }
    });

    socket.on("user_list", renderUserList);

    socket.on("typing",      (d) => { typingUsers.add(d.username);    updateTypingStatus(); });
    socket.on("stop_typing", (d) => { typingUsers.delete(d.username); updateTypingStatus(); });

    // Secundário avisa que o primário voltou
    socket.on("primary_back", () => {
      if (currentServer === "secondary") {
        addSystemMessage("🔄 Servidor primário voltou! Reconectando...", "warn");
        reconnecting = false;
        historyLoaded = false;
        connectTo("primary");
      }
    });
  }

  function doFailover() {
    if (reconnecting) return;
    reconnecting = true;
    failedOver   = true;
    setStatus("connecting");
    connectTo("secondary");
  }

  /* ══════════════════════════════════════════════════════
     BOTÃO KILL — fire-and-forget (não espera resposta)
  ══════════════════════════════════════════════════════ */
  killBtn.addEventListener("click", () => {
    if (killBtn.disabled) return;
    if (!confirm("Derrubar o servidor primário agora?\nO chat vai migrar automaticamente para o secundário.")) return;

    killBtn.disabled = true;
    addSystemMessage("⚡ Derrubando servidor primário...", "warn");

    // Fire-and-forget: não aguarda resposta (o servidor vai morrer antes de responder)
    fetch(`${CONFIG.PRIMARY_URL}/admin/kill`, {
      method: "POST",
      mode: "cors",
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
    // A desconexão do socket vai disparar o failover automaticamente
  });

  /* ══════════════════════════════════════════════════════
     ENVIO DE MENSAGEM
  ══════════════════════════════════════════════════════ */
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
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  inputEl.addEventListener("input", function () {
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 100) + "px";
    handleTyping();
  });

  /* ══════════════════════════════════════════════════════
     TYPING
  ══════════════════════════════════════════════════════ */
  function handleTyping() {
    if (!socket || !socket.connected) return;
    if (!isTyping) { isTyping = true; socket.emit("typing", { room: CONFIG.ROOM }); }
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
    if (!others.length) { typingStatusEl.textContent = ""; return; }
    typingStatusEl.textContent = others.length === 1
      ? `${others[0]} está digitando...`
      : `${others.join(", ")} estão digitando...`;
  }

  /* ══════════════════════════════════════════════════════
     RENDERIZAÇÃO
  ══════════════════════════════════════════════════════ */
  function renderHistory(messages) {
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
      ? `<div class="msg-sender">${escapeHTML(msg.sender)}</div>` : "";
    row.innerHTML = `
      ${senderHTML}
      <div class="msg-bubble">${escapeHTML(msg.text)}</div>
      <div class="msg-time">${msg.timestamp || getTime()}</div>`;
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
    usersList.innerHTML = users.map(u => `<li>${escapeHTML(u)}</li>`).join("");
  }

  /* ══════════════════════════════════════════════════════
     UI
  ══════════════════════════════════════════════════════ */
  function setStatus(state) {
    const colors = { online:"var(--green)", offline:"var(--danger)", connecting:"var(--warn)" };
    const labels = { online:"ao vivo", offline:"desconectado", connecting:"conectando..." };
    statusDot.style.background = colors[state] || colors.connecting;
    statusLabel.textContent    = labels[state]  || state;
  }

  function updateServerBadge(server) {
    serverBadge.className = `server-badge ${server}`;
    serverBadgeLabel.textContent = server === "primary" ? "primary" : "secondary";
  }

  function showFailoverBanner(dest) {
    failoverBanner.hidden = false;
    failoverMsg.textContent = `Servidor primário caiu — usando ${dest} ✓`;
    addSystemMessage("🔄 Migrado para o servidor secundário — histórico preservado", "warn");
  }

  function showReturnBanner() {
    failoverBanner.hidden = false;
    failoverBanner.style.background = "rgba(63,207,142,0.1)";
    failoverBanner.style.borderColor = "rgba(63,207,142,0.25)";
    failoverBanner.style.color = "var(--green)";
    failoverMsg.textContent = "Servidor primário voltou — reconectado ✓";
    addSystemMessage("✅ De volta ao servidor primário", "");
    setTimeout(() => { failoverBanner.hidden = true; }, 5000);
  }

  usersToggleBtn.addEventListener("click", () => {
    usersPanel.hidden = !usersPanel.hidden;
  });

  /* ══════════════════════════════════════════════════════
     HELPERS
  ══════════════════════════════════════════════════════ */
  function getTime() {
    const d = new Date();
    return d.getHours().toString().padStart(2,"0") + ":" + d.getMinutes().toString().padStart(2,"0");
  }
  function scrollToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }
  function escapeHTML(str) {
    return String(str)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

})();
