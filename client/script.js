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
  let hadConnection = false;
  let killedByUser  = false;
  let typingTimeout = null;
  let isTyping      = false;
  let typingUsers   = new Set();
  let returnPoller  = null;
  let initRetries   = 0;

  const outbox = new Map();
  let msgSeq = 0;
  const seenMessages = new Set();

  function getMessageKey(msg) {
    return `${msg.sender}::${msg.text}::${msg.timestamp || ""}`;
  }

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
    btn.className   = "emoji-item";
    btn.textContent = e;
    btn.addEventListener("click", () => {
      const pos = inputEl.selectionStart;
      const val = inputEl.value;
      inputEl.value = val.slice(0, pos) + e + val.slice(pos);
      inputEl.focus();
      inputEl.setSelectionRange(pos + e.length, pos + e.length);
      emojiPicker.hidden = true;
    });
    emojiGrid.appendChild(btn);
  });

  emojiBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    emojiPicker.hidden = !emojiPicker.hidden;
  });
  document.addEventListener("click", () => { emojiPicker.hidden = true; });
  emojiPicker.addEventListener("click", e => e.stopPropagation());

  /* ══════════════════════════════════
     GERENCIAMENTO DE GRUPOS DINÂMICOS
  ══════════════════════════════════ */
  const ROOM_EMOJIS = { "geral":"💬" };

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

  function addRoomChip(slug, name) {
    if (roomList.querySelector(`[data-room="${slug}"]`)) return;
    const chip = document.createElement("button");
    chip.className = "room-chip";
    if (slug === currentRoom) chip.className += " active";
    chip.dataset.room = slug;
    chip.textContent = "💬 " + name;
    newRoomBtn.before(chip);
  }

  function createRoom(name) {
    const cleaned = name.trim();
    if (!cleaned) return;

    if (socket && socket.connected) {
      socket.emit("create_room", { name: cleaned }, (ack) => {
        if (ack && ack.ok) {
          currentRoom = ack.slug;
          setTimeout(() => {
            const chip = roomList.querySelector(`[data-room="${ack.slug}"]`);
            if (chip) {
              roomList.querySelectorAll(".room-chip").forEach(c => c.classList.remove("active"));
              chip.classList.add("active");
            }
          }, 50);
          newRoomRow.style.display = "none";
          newRoomInput.value = "";
        }
      });
    }
  }

  newRoomConfirm.addEventListener("click", () => createRoom(newRoomInput.value));
  newRoomInput.addEventListener("keydown", e => { if (e.key === "Enter") createRoom(newRoomInput.value); });

  /* ══════════════════════════════════
     MODAL — ENTRAR
  ══════════════════════════════════ */
  function openChat(name) {
    username = name.trim();
    if (!username) return;

    const activeChip = roomList.querySelector(".room-chip.active");
    currentRoom = activeChip ? activeChip.dataset.room : "geral";

    const emoji = ROOM_EMOJIS[currentRoom] || "💬";
    roomEmojiEl.textContent  = emoji;
    headerRoomName.textContent = activeChip
      ? activeChip.textContent.replace(/^.\s/, "")
      : "Geral";

    modalOverlay.style.display = "none";
    chatWrapper.style.display  = "flex";
    
    if (socket && socket.connected) {
      socket.emit("join", { username, room: currentRoom });
    } else {
      connectTo("primary");
    }
  }

  joinBtn.addEventListener("click",   () => openChat(usernameInput.value));
  usernameInput.addEventListener("keydown", e => { if (e.key === "Enter") openChat(usernameInput.value); });

  /* ══════════════════════════════════
     CONEXÃO
  ══════════════════════════════════ */
  function connectTo(server) {
    const url     = server === "primary" ? CONFIG.PRIMARY_URL : CONFIG.SECONDARY_URL;
    currentServer = server;
    setStatus("connecting");
    updateServerBadge(server);

    if (socket) { socket.off(); socket.disconnect(); socket = null; }

    socket = io(url, { transports: ["websocket"], reconnection: false, timeout: 6000 });

    socket.on("connect", () => {
      reconnecting = false;
      initRetries  = 0;
      setStatus("online");

      if (username) {
        socket.emit("join", { username, room: currentRoom });
      }

      if (server === "primary") {
        hadConnection         = true;
        killBtn.disabled      = false;
        killBtn.style.opacity = "1";
        stopReturnPoller();

        if (killedByUser) {
          killedByUser = false;
          hideBanner();
          showBanner("green", "✅ Servidor primário voltou — reconectado");
          setTimeout(hideBanner, 5000);
          addSystemMsg("✅ De volta ao servidor primário");
        }
      }

      if (server === "secondary") {
        killBtn.disabled      = true;
        killBtn.style.opacity = "0.3";
        startReturnPoller();
      }

      flushOutbox();
    });

    socket.on("connect_error", () => {
      if (server === "primary" && !reconnecting) {
        if (hadConnection) {
          triggerFailover();
        } else {
          initRetries++;
          if (initRetries < 3) setTimeout(() => connectTo("primary"), 2000);
          else { initRetries = 0; reconnecting = true; connectTo("secondary"); }
        }
      } else if (server === "secondary") {
        setStatus("offline");
        setTimeout(() => connectTo("secondary"), 3000);
      }
    });

    socket.on("disconnect", (reason) => {
      const dropped = ["transport close","transport error","ping timeout","io server disconnect"];
      if (server === "primary" && !reconnecting && dropped.includes(reason)) {
        triggerFailover();
      } else if (server === "secondary" && dropped.includes(reason)) {
        setStatus("connecting");
        setTimeout(() => connectTo("secondary"), 2000);
      }
    });

    socket.on("server_shutdown", () => {
      if (server === "primary" && !reconnecting) {
        console.log("[SockeText] server_shutdown recebido — migrando ao secundário");
        triggerFailover();
      }
    });

    socket.on("server_info",  d => updateServerBadge(d.role === "primary" ? "primary" : "secondary"));

    /* Sincronização em tempo real de salas criadas */
    socket.on("room_list", rooms => {
      roomList.querySelectorAll(".room-chip:not(#newRoomBtn)").forEach(c => {
        if (c.dataset.room !== "geral") c.remove();
      });
      rooms.forEach(r => {
        if (r.slug !== "geral") addRoomChip(r.slug, r.name);
      });
      roomList.querySelectorAll(".room-chip").forEach(c => {
        c.classList.toggle("active", c.dataset.room === currentRoom);
      });
    });

    socket.on("room_created", room => {
      addRoomChip(room.slug, room.name);
    });

    socket.on("history", messages => {
      renderHistory(messages);
    });

    socket.on("message", msg => {
      renderMessage(msg);
    });

    socket.on("user_joined", d => { if (d.username !== username) addSystemMsg(`${d.username} entrou no chat`); });
    socket.on("user_left",   d => { if (d.username !== username) addSystemMsg(`${d.username} saiu do chat`); });
    socket.on("user_list",   renderUserList);
    socket.on("typing",      d => { typingUsers.add(d.username);    updateTypingStatus(); });
    socket.on("stop_typing", d => { typingUsers.delete(d.username); updateTypingStatus(); });

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
    killedByUser = true;
    setStatus("connecting");
    showBanner("warn", "⚠️ Servidor primário caiu — conectando ao secundário...");
    connectTo("secondary");
  }

  /* ── OUTBOX ── */
  function flushOutbox() {
    if (outbox.size === 0) return;
    console.log(`[SockeText] Reenviando ${outbox.size} mensagem(ns) da outbox...`);
    for (const [clientMsgId, entry] of outbox) {
      _emitMessage(entry.text, entry.room, clientMsgId, entry.el);
    }
  }

  function _emitMessage(text, room, clientMsgId, el) {
    if (!socket || !socket.connected) return;
    socket.emit("message", { text, room, client_msg_id: clientMsgId }, (ack) => {
      if (ack && ack.ok) {
        outbox.delete(clientMsgId);
        if (el) {
          el.classList.remove("pending");
          el.removeAttribute("data-pending");
        }
      }
    });
  }

  /* ── BOTÃO KILL ── */
  killBtn.addEventListener("click", () => {
    if (killBtn.disabled) return;
    if (!confirm("Derrubar o servidor primário?\nO chat migra automaticamente para o secundário.")) return;

    killBtn.disabled = true;

    fetch(`${CONFIG.PRIMARY_URL}/admin/kill`, {
      method: "POST", mode: "cors",
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
  });

  /* ── POLLING ── */
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
    }, 60000);
  }

  function stopReturnPoller() {
    if (returnPoller) { clearTimeout(returnPoller); returnPoller = null; }
  }

  /* ── ENVIO DE MENSAGEM ── */
  function sendMessage() {
    const text = inputEl.value.trim();
    if (!text) return;

    inputEl.value = "";
    inputEl.style.height = "auto";
    stopTyping();

    const clientMsgId = `${Date.now()}-${++msgSeq}`;
    const el = renderPendingMessage(text, clientMsgId);

    outbox.set(clientMsgId, { text, room: currentRoom, el });

    if (socket && socket.connected) {
      _emitMessage(text, currentRoom, clientMsgId, el);
    }
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

  /* ── TYPING ── */
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

  /* ── RENDERIZAÇÃO ── */
  function renderHistory(messages) {
    messages.forEach(msg => {
      renderMessage(msg);
    });
    for (const [, entry] of outbox) {
      if (entry.el && !messagesEl.contains(entry.el)) {
        messagesEl.appendChild(entry.el);
      }
    }
    scrollToBottom();
  }

  function renderMessage(msg) {
    const key = getMessageKey(msg);
    const pendingKey = `${msg.sender}:${msg.text}`;
    const pending = messagesEl.querySelector(`[data-pending="${pendingKey}"]`);
    
    if (pending) {
      pending.removeAttribute("data-pending");
      pending.classList.remove("pending");
      const timeEl = pending.querySelector(".msg-time");
      if (timeEl) timeEl.textContent = msg.timestamp || getTime();
      seenMessages.add(key);
      return pending;
    }

    if (seenMessages.has(key)) return null; 
    seenMessages.add(key);

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
    row.className = "msg-row outgoing pending";
    row.dataset.pending = `${username}:${text}`;
    row.innerHTML = `
      <div class="msg-bubble">${escapeHTML(text)}</div>
      <div class="msg-time">enviando...</div>`;
    messagesEl.appendChild(row);
    scrollToBottom();
    return row;
  }

  function addSystemMsg(text, variant = "") {
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
    const styles = {
      warn:  { bg:"rgba(239,159,39,0.1)",  border:"rgba(239,159,39,0.3)",  color:"var(--warn)"   },
      green: { bg:"rgba(63,207,142,0.1)",  border:"rgba(63,207,142,0.3)",  color:"var(--green)"  },
    };
    const s = styles[type] || styles.warn;
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

  function getTime() {
    const d = new Date();
    return d.getHours().toString().padStart(2,"0") + ":" + d.getMinutes().toString().padStart(2,"0");
  }
  function scrollToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }
  function escapeHTML(str) {
    return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  /* Conecta de imediato ao carregar a página para receber e sincronizar as salas disponíveis */
  connectTo("primary");

})();