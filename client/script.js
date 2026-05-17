(function () {
  "use strict";

  const CONFIG = {
    PRIMARY_URL:   "https://socketext-primary.onrender.com",
    SECONDARY_URL: "https://socketext-secondary.onrender.com",
  };

  const EMOJIS = [
    "😀","😂","😍","🤔","😎","😢","😡","🥳","😴","🤯",
    "👍","👎","❤️","🔥","✅","⚡","🎉","💯","🙏","👀",
    "😅","😭","😱","🤣","😇","🥺","😏","😤","🤩","😬",
    "💪","🤝","👋","🫡","💀","🫶","🎮","💬","🚀","⭐",
  ];

  /* ── Estado ── */
  let socket        = null;
  let username      = "";
  let currentRoom   = "geral";
  let currentServer = "primary";
  let reconnecting  = false;
  let hadConnection = false;  // já conectou ao primário ao menos uma vez
  let didFailover   = false;  // houve failover real (não primeira conexão)
  let typingTimeout = null;
  let isTyping      = false;
  let typingUsers   = new Set();
  let returnPoller  = null;
  let initRetries   = 0;
  let msgSeq        = 0;

  /*
   * OUTBOX: garante zero perda na transição de servidor.
   * Cada mensagem enviada entra aqui com um client_msg_id único.
   * Quando o servidor retorna a mensagem no broadcast com o mesmo
   * client_msg_id, removemos da outbox e marcamos como entregue.
   * Se o socket cair antes do ACK, flushOutbox() reenvia ao reconectar.
   */
  const outbox = new Map(); // clientMsgId → { text, room, el }

  /* ── DOM ── */
  const modalOverlay     = document.getElementById("modalOverlay");
  const usernameInput    = document.getElementById("usernameInput");
  const joinBtn          = document.getElementById("joinBtn");
  const newRoomBtn       = document.getElementById("newRoomBtn");
  const newRoomRow       = document.getElementById("newRoomRow");
  const newRoomInput     = document.getElementById("newRoomInput");
  const newRoomConfirm   = document.getElementById("newRoomConfirm");
  const roomList         = document.getElementById("roomList");
  const chatWrapper      = document.getElementById("chatWrapper");
  const messagesEl       = document.getElementById("messages");
  const inputEl          = document.getElementById("msgInput");
  const sendBtn          = document.getElementById("sendBtn");
  const emojiBtn         = document.getElementById("emojiBtn");
  const emojiPicker      = document.getElementById("emojiPicker");
  const emojiGrid        = document.getElementById("emojiGrid");
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
  const roomEmojiEl      = document.getElementById("roomEmoji");
  const headerRoomName   = document.getElementById("headerRoomName");

  /* ══════════════════════════════════
     EMOJI PICKER
  ══════════════════════════════════ */
  EMOJIS.forEach(e => {
    const btn = document.createElement("button");
    btn.className = "emoji-item";
    btn.textContent = e;
    btn.addEventListener("click", () => {
      const pos = inputEl.selectionStart;
      inputEl.value = inputEl.value.slice(0, pos) + e + inputEl.value.slice(pos);
      inputEl.focus();
      inputEl.setSelectionRange(pos + e.length, pos + e.length);
      emojiPicker.hidden = true;
    });
    emojiGrid.appendChild(btn);
  });

  emojiBtn.addEventListener("click", ev => {
    ev.stopPropagation();
    emojiPicker.hidden = !emojiPicker.hidden;
  });
  document.addEventListener("click", () => { emojiPicker.hidden = true; });
  emojiPicker.addEventListener("click", e => e.stopPropagation());

  /* ══════════════════════════════════
     GRUPOS NO MODAL
  ══════════════════════════════════ */
  const ROOM_EMOJIS = { "geral":"💬", "off-topic":"🎮", "trabalho":"💼" };

  roomList.addEventListener("click", e => {
    const chip = e.target.closest(".room-chip");
    if (!chip || chip.id === "newRoomBtn") return;
    roomList.querySelectorAll(".room-chip").forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    currentRoom = chip.dataset.room;
  });

  newRoomBtn.addEventListener("click", () => {
    newRoomRow.style.display = "flex";
    newRoomInput.focus();
  });

  function createRoom(rawName) {
    const name = rawName.trim();
    const slug = name.toLowerCase().replace(/\s+/g, "-").slice(0, 24);
    if (!slug) return;
    // Se já existe, só seleciona
    const existing = roomList.querySelector(`[data-room="${slug}"]`);
    if (existing) {
      roomList.querySelectorAll(".room-chip").forEach(c =>
        c.classList.toggle("active", c.dataset.room === slug));
      currentRoom = slug;
      newRoomRow.style.display = "none";
      newRoomInput.value = "";
      return;
    }
    const chip = document.createElement("button");
    chip.className    = "room-chip active";
    chip.dataset.room = slug;
    chip.textContent  = "💬 " + name;
    roomList.querySelectorAll(".room-chip").forEach(c => c.classList.remove("active"));
    newRoomBtn.before(chip);
    currentRoom = slug;
    newRoomRow.style.display = "none";
    newRoomInput.value = "";
  }

  newRoomConfirm.addEventListener("click", () => createRoom(newRoomInput.value));
  newRoomInput.addEventListener("keydown", e => {
    if (e.key === "Enter") createRoom(newRoomInput.value);
  });

  /* ══════════════════════════════════
     MODAL — ENTRAR
  ══════════════════════════════════ */
  function openChat(name) {
    username = name.trim();
    if (!username) return;

    const activeChip = roomList.querySelector(".room-chip.active");
    currentRoom = activeChip ? activeChip.dataset.room : "geral";

    roomEmojiEl.textContent    = ROOM_EMOJIS[currentRoom] || "💬";
    headerRoomName.textContent = activeChip
      ? activeChip.textContent.replace(/^.\s/, "").trim()
      : "Geral";

    modalOverlay.style.display = "none";
    chatWrapper.style.display  = "flex";

    // Banner começa sempre escondido
    hideBanner();

    connectTo("primary");
  }

  joinBtn.addEventListener("click", () => openChat(usernameInput.value));
  usernameInput.addEventListener("keydown", e => {
    if (e.key === "Enter") openChat(usernameInput.value);
  });

  /* ══════════════════════════════════
     CONEXÃO
  ══════════════════════════════════ */
  function connectTo(server) {
    const url = server === "primary" ? CONFIG.PRIMARY_URL : CONFIG.SECONDARY_URL;
    currentServer = server;
    setStatus("connecting");
    updateServerBadge(server);

    if (socket) { socket.off(); socket.disconnect(); socket = null; }

    socket = io(url, { transports: ["websocket"], reconnection: false, timeout: 6000 });

    /* ── Conectou ── */
    socket.on("connect", () => {
      reconnecting = false;
      initRetries  = 0;
      setStatus("online");
      socket.emit("join", { username, room: currentRoom });

      if (server === "primary") {
        hadConnection         = true;
        killBtn.disabled      = false;
        killBtn.style.opacity = "1";
        stopReturnPoller();

        if (didFailover) {
          didFailover = false;
          showBanner("green", "✅ Servidor primário voltou — reconectado");
          addSystemMsg("✅ De volta ao servidor primário");
          setTimeout(hideBanner, 5000);
        }
      }

      if (server === "secondary") {
        killBtn.disabled      = true;
        killBtn.style.opacity = "0.3";
        // Banner de failover só se houve failover de verdade
        if (didFailover) {
          showBanner("warn", "⚠️ Servidor primário caiu — usando secundário ✓");
          addSystemMsg("🔄 Migrado para o servidor secundário — histórico preservado");
        }
        startReturnPoller();
      }

      flushOutbox();
    });

    /* ── Erro de conexão ── */
    socket.on("connect_error", () => {
      if (server === "primary" && !reconnecting) {
        if (hadConnection) {
          triggerFailover();
        } else {
          // Primário pode estar acordando (Render free tier) — tenta 3x
          initRetries++;
          if (initRetries < 3) {
            setTimeout(() => connectTo("primary"), 3000);
          } else {
            initRetries  = 0;
            reconnecting = true;
            // Vai pro secundário mas SEM mostrar banner (não é failover real)
            connectTo("secondary");
          }
        }
      } else if (server === "secondary") {
        setStatus("offline");
        setTimeout(() => connectTo("secondary"), 3000);
      }
    });

    /* ── Desconectou ── */
    socket.on("disconnect", (reason) => {
      const dropped = ["transport close","transport error","ping timeout","io server disconnect"];
      if (server === "primary" && !reconnecting && dropped.includes(reason)) {
        triggerFailover();
      } else if (server === "secondary" && dropped.includes(reason)) {
        setStatus("connecting");
        setTimeout(() => connectTo("secondary"), 2000);
      }
    });

    /* ── server_shutdown: primário avisa ANTES de morrer ── */
    socket.on("server_shutdown", () => {
      if (server === "primary" && !reconnecting) {
        triggerFailover();
      }
    });

    /* ── Eventos da aplicação ── */
    socket.on("server_info", d =>
      updateServerBadge(d.role === "primary" ? "primary" : "secondary"));

    socket.on("history", messages => renderHistory(messages));

    socket.on("message", msg => {
      // ACK: se o client_msg_id bate com algo na outbox, confirma entrega
      if (msg.client_msg_id && outbox.has(msg.client_msg_id)) {
        const entry = outbox.get(msg.client_msg_id);
        outbox.delete(msg.client_msg_id);
        // Marca o bubble como entregue
        if (entry.el) {
          entry.el.classList.remove("pending");
          entry.el.removeAttribute("data-cmid");
          const timeEl = entry.el.querySelector(".msg-time");
          if (timeEl) timeEl.textContent = msg.timestamp || getTime();
        }
      } else {
        // Mensagem de outro usuário — renderiza normalmente
        if (msg.sender !== username) renderMessage(msg);
      }
    });

    socket.on("user_joined", d => {
      if (d.username !== username) addSystemMsg(`${d.username} entrou no chat`);
    });
    socket.on("user_left", d => {
      if (d.username !== username) addSystemMsg(`${d.username} saiu do chat`);
    });
    socket.on("user_list",    renderUserList);
    socket.on("typing",       d => { typingUsers.add(d.username);    updateTypingStatus(); });
    socket.on("stop_typing",  d => { typingUsers.delete(d.username); updateTypingStatus(); });

    socket.on("primary_back", () => {
      if (currentServer === "secondary") {
        addSystemMsg("🔄 Servidor primário voltou! Reconectando...");
        reconnecting = false;
        connectTo("primary");
      }
    });
  }

  function triggerFailover() {
    if (reconnecting) return;
    reconnecting = true;
    didFailover  = true;
    setStatus("connecting");
    connectTo("secondary");
  }

  /* ══════════════════════════════════
     OUTBOX — Zero perda na transição
  ══════════════════════════════════ */
  function flushOutbox() {
    if (!outbox.size) return;
    for (const [clientMsgId, entry] of outbox) {
      _doEmit(entry.text, entry.room, clientMsgId);
    }
  }

  function _doEmit(text, room, clientMsgId) {
    if (!socket || !socket.connected) return;
    socket.emit("message", { text, room, client_msg_id: clientMsgId });
  }

  /* ══════════════════════════════════
     BOTÃO KILL
  ══════════════════════════════════ */
  killBtn.addEventListener("click", () => {
    if (killBtn.disabled) return;
    if (!confirm("Derrubar o servidor primário?\nO chat migra automaticamente para o secundário.")) return;
    killBtn.disabled = true;
    fetch(`${CONFIG.PRIMARY_URL}/admin/kill`, {
      method: "POST", mode: "cors",
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
    // server_shutdown vai disparar triggerFailover() automaticamente
  });

  /* ══════════════════════════════════
     POLLING — Retorno ao primário
  ══════════════════════════════════ */
  function startReturnPoller() {
    stopReturnPoller();
    returnPoller = setTimeout(function poll() {
      fetch(`${CONFIG.PRIMARY_URL}/health`, {
        mode: "cors", signal: AbortSignal.timeout(5000),
      })
        .then(r => r.json())
        .then(data => {
          if (data.status === "online") {
            addSystemMsg("🔄 Servidor primário voltou! Reconectando...");
            reconnecting = false;
            connectTo("primary");
          } else {
            returnPoller = setTimeout(poll, 15000);
          }
        })
        .catch(() => { returnPoller = setTimeout(poll, 15000); });
    }, 60000); // 60s — tempo do Render reiniciar o processo
  }

  function stopReturnPoller() {
    if (returnPoller) { clearTimeout(returnPoller); returnPoller = null; }
  }

  /* ══════════════════════════════════
     ENVIO DE MENSAGEM
  ══════════════════════════════════ */
  function sendMessage() {
    const text = inputEl.value.trim();
    if (!text) return;

    inputEl.value = "";
    inputEl.style.height = "auto";
    stopTyping();

    const clientMsgId = `${Date.now()}-${++msgSeq}`;

    // Renderiza imediatamente como pending
    const el = renderPendingMessage(text, clientMsgId);
    outbox.set(clientMsgId, { text, room: currentRoom, el });

    if (socket && socket.connected) {
      _doEmit(text, currentRoom, clientMsgId);
    }
    // Se desconectado, flushOutbox() reenvia ao reconectar
  }

  sendBtn.addEventListener("click", sendMessage);
  inputEl.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  inputEl.addEventListener("input", function () {
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 100) + "px";
    handleTyping();
  });

  /* ══════════════════════════════════
     TYPING
  ══════════════════════════════════ */
  function handleTyping() {
    if (!socket || !socket.connected) return;
    if (!isTyping) { isTyping = true; socket.emit("typing", { room: currentRoom }); }
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(stopTyping, 2500);
  }
  function stopTyping() {
    if (isTyping && socket && socket.connected) {
      isTyping = false; socket.emit("stop_typing", { room: currentRoom });
    }
    clearTimeout(typingTimeout);
  }
  function updateTypingStatus() {
    const others = [...typingUsers].filter(u => u !== username);
    typingStatusEl.textContent = !others.length ? "" :
      others.length === 1 ? `${others[0]} está digitando...` :
      `${others.join(", ")} estão digitando...`;
  }

  /* ══════════════════════════════════
     RENDERIZAÇÃO
  ══════════════════════════════════ */
  function renderHistory(messages) {
    const divider = messagesEl.querySelector(".date-divider");
    messagesEl.innerHTML = "";
    if (divider) messagesEl.appendChild(divider);

    // Filtra msgs da outbox para não duplicar
    const pendingIds = new Set([...outbox.keys()]);
    messages.forEach(msg => {
      // Mensagens próprias que já estão pendentes na outbox: não renderiza de novo
      if (msg.sender === username && msg.client_msg_id && pendingIds.has(msg.client_msg_id)) return;
      renderMessage(msg);
    });

    // Recoloca os bubbles pendentes no final
    for (const [, entry] of outbox) {
      if (entry.el) messagesEl.appendChild(entry.el);
    }
    scrollToBottom();
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
    return row;
  }

  function renderPendingMessage(text, clientMsgId) {
    const row = document.createElement("div");
    row.className       = "msg-row outgoing pending";
    row.dataset.cmid    = clientMsgId;
    row.innerHTML = `
      <div class="msg-bubble">${escapeHTML(text)}</div>
      <div class="msg-time">enviando...</div>`;
    messagesEl.appendChild(row);
    scrollToBottom();
    return row;
  }

  function addSystemMsg(text) {
    const el = document.createElement("div");
    el.className   = "system-msg";
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function renderUserList(users) {
    usersCount.textContent = users.length;
    usersList.innerHTML = users.map(u => `<li>${escapeHTML(u)}</li>`).join("");
  }

  /* ══════════════════════════════════
     UI
  ══════════════════════════════════ */
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

  function showBanner(type, msg) {
    const s = type === "green"
      ? { bg:"rgba(63,207,142,0.1)",  border:"rgba(63,207,142,0.3)",  color:"var(--green)" }
      : { bg:"rgba(239,159,39,0.1)",  border:"rgba(239,159,39,0.3)",  color:"var(--warn)"  };
    failoverBanner.hidden            = false;
    failoverBanner.style.background  = s.bg;
    failoverBanner.style.borderColor = s.border;
    failoverBanner.style.color       = s.color;
    failoverMsg.textContent          = msg;
  }

  function hideBanner() {
    failoverBanner.hidden            = true;
    failoverBanner.style.background  = "";
    failoverBanner.style.borderColor = "";
    failoverBanner.style.color       = "";
  }

  usersToggleBtn.addEventListener("click", () => { usersPanel.hidden = !usersPanel.hidden; });

  /* ══════════════════════════════════
     HELPERS
  ══════════════════════════════════ */
  function getTime() {
    const d = new Date();
    return d.getHours().toString().padStart(2,"0") + ":" + d.getMinutes().toString().padStart(2,"0");
  }
  function scrollToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }
  function escapeHTML(str) {
    return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

})();
