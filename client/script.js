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
  let hadConnection   = false;  // já conectou ao primário ao menos uma vez
  let killedByButton  = false;  // botão foi clicado
  let returnPoller    = null;
  let _initialRetries = 0;

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
     CONEXÃO
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
      reconnecting    = false;
      _initialRetries = 0;
      setStatus("online");
      socket.emit("join", { username, room: CONFIG.ROOM });

      if (server === "primary") {
        hadConnection = true;
        hideBanner();
        if (killedByButton) {
          killedByButton = false;
          showReturnBanner();
        }
        killBtn.disabled      = false;
        killBtn.style.opacity = "1";
        stopReturnPoller();
      }

      if (server === "secondary") {
        if (killedByButton) showFailoverBanner();
        killBtn.disabled      = true;
        killBtn.style.opacity = "0.3";
        startReturnPoller();
      }
    });

    socket.on("connect_error", () => {
      if (server === "primary" && !reconnecting) {
        if (hadConnection) {
          doFailover();
        } else {
          handleInitialConnectError();
        }
      } else if (server === "secondary") {
        setStatus("offline");
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

    socket.on("server_info",  (d) => updateServerBadge(d.role === "primary" ? "primary" : "secondary"));
    socket.on("history",      (messages) => { renderHistory(messages); historyLoaded = true; });
    socket.on("message",      renderMessage);
    socket.on("user_list",    renderUserList);
    socket.on("user_joined",  (d) => { if (d.username !== username) addSystemMessage(`${d.username} entrou no chat`); });
    socket.on("user_left",    (d) => { if (d.username !== username) addSystemMessage(`${d.username} saiu do chat`); });
    socket.on("typing",       (d) => { typingUsers.add(d.username);    updateTypingStatus(); });
    socket.on("stop_typing",  (d) => { typingUsers.delete(d.username); updateTypingStatus(); });
  }

  function handleInitialConnectError() {
    _initialRetries++;
    if (_initialRetries < 3) {
      setTimeout(() => connectTo("primary"), 3000);
    } else {
      _initialRetries = 0;
      reconnecting = true;
      connectTo("secondary");
    }
  }

  function doFailover() {
    if (reconnecting) return;
    reconnecting   = true;
    killedByButton = true;
    connectTo("secondary");
  }

  /* ══════════════════════════════════════════════════════
     BOTÃO KILL
     Estratégia: fecha o WebSocket direto + dispara o fetch /admin/kill.
     O socket fechando já é suficiente para disparar o failover.
     O fetch é só para matar o processo no servidor mesmo.
  ══════════════════════════════════════════════════════ */
  killBtn.addEventListener("click", () => {
    if (killBtn.disabled) return;
    if (!confirm("Derrubar o servidor primário agora?\nO chat migra automaticamente para o secundário.")) return;

    killedByButton   = true;
    killBtn.disabled = true;
    addSystemMessage("⚡ Derrubando servidor primário...", "warn");

    // 1. Fecha o socket manualmente — isso dispara o failover imediatamente
    //    sem esperar o HTTP do /admin/kill
    if (socket && socket.connected) {
      socket.disconnect();
    }

    // 2. Manda o kill pro servidor em paralelo (fire-and-forget)
    fetch(`${CONFIG.PRIMARY_URL}/admin/kill`, {
      method: "POST",
      mode: "cors",
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
  });

  /* ══════════════════════════════════════════════════════
     POLLING PARA VOLTAR AO PRIMÁRIO
     - Aguarda 60s (tempo que o Render leva pra reiniciar o serviço)
     - Depois faz ping a cada 15s no /health do primário
     - Quando responder online, reconecta automaticamente
  ══════════════════════════════════════════════════════ */
  function startReturnPoller() {
    stopReturnPoller();
    console.log("[SockeText] Aguardando 60s para o primário reiniciar...");

    returnPoller = setTimeout(function poll() {
      fetch(`${CONFIG.PRIMARY_URL}/health`, {
        mode: "cors",
        signal: AbortSignal.timeout(5000),
      })
        .then(r => r.json())
        .then(data => {
          if (data.status === "online") {
            console.log("[SockeText] Primário online! Voltando...");
            addSystemMessage("🔄 Servidor primário voltou! Reconectando...", "warn");
            reconnecting  = false;
            historyLoaded = false;
            connectTo("primary");
          } else {
            returnPoller = setTimeout(poll, 15000);
          }
        })
        .catch(() => {
          console.log("[SockeText] Primário ainda offline, tentando em 15s...");
          returnPoller = setTimeout(poll, 15000);
        });
    }, 60000); // 60s de espera inicial — tempo do Render reiniciar
  }

  function stopReturnPoller() {
    if (returnPoller) { clearTimeout(returnPoller); returnPoller = null; }
  }

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
    typingStatusEl.textContent = others.length === 0 ? "" :
      others.length === 1 ? `${others[0]} está digitando...` :
      `${others.join(", ")} estão digitando...`;
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
    row.innerHTML = `${senderHTML}
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

  function showFailoverBanner() {
    failoverBanner.hidden            = false;
    failoverBanner.style.background  = "rgba(239,159,39,0.1)";
    failoverBanner.style.borderColor = "rgba(239,159,39,0.25)";
    failoverBanner.style.color       = "var(--warn)";
    failoverMsg.textContent = "Servidor primário caiu — usando secundário ✓";
    addSystemMessage("🔄 Migrado para o servidor secundário — histórico preservado", "warn");
  }

  function showReturnBanner() {
    failoverBanner.hidden            = false;
    failoverBanner.style.background  = "rgba(63,207,142,0.1)";
    failoverBanner.style.borderColor = "rgba(63,207,142,0.25)";
    failoverBanner.style.color       = "var(--green)";
    failoverMsg.textContent = "Servidor primário voltou — reconectado ✓";
    addSystemMessage("✅ De volta ao servidor primário", "");
    setTimeout(hideBanner, 5000);
  }

  function hideBanner() {
    failoverBanner.hidden            = true;
    failoverBanner.style.background  = "";
    failoverBanner.style.borderColor = "";
    failoverBanner.style.color       = "";
  }

  usersToggleBtn.addEventListener("click", () => { usersPanel.hidden = !usersPanel.hidden; });

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
