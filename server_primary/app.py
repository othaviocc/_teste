"""
SockeText — Servidor Primário
Arquitetura: Flask + Flask-SocketIO (threading mode)
Cada conexão WebSocket roda em thread dedicada (via eventlet/threading).
Banco de dados: PostgreSQL compartilhado com o servidor secundário.
"""

import os
import sys
import threading
import time
import signal
from datetime import datetime, timezone

from flask import Flask, request, jsonify
from flask_socketio import SocketIO, emit, join_room, leave_room
from flask_sqlalchemy import SQLAlchemy
from flask_cors import CORS

# ── App ──────────────────────────────────────────────────────────────────────
app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "socktext-primary-secret")
app.config["SQLALCHEMY_DATABASE_URI"] = os.environ.get(
    "DATABASE_URL", "sqlite:///chat.db"
).replace("postgres://", "postgresql://")  # Render usa "postgres://", SQLAlchemy precisa de "postgresql://"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

CORS(app, origins="*")

db = SQLAlchemy(app)
socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode="threading",   # uma thread por conexão ← requisito do trabalho
    logger=False,
    engineio_logger=False,
    ping_timeout=10,
    ping_interval=5,
)

SERVER_ROLE = "primary"

# ── Modelos ──────────────────────────────────────────────────────────────────
class Message(db.Model):
    __tablename__ = "messages"
    id        = db.Column(db.Integer, primary_key=True)
    sender    = db.Column(db.String(64), nullable=False)
    text      = db.Column(db.Text, nullable=False)
    timestamp = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    room      = db.Column(db.String(64), default="geral")

    def to_dict(self):
        return {
            "id":        self.id,
            "sender":    self.sender,
            "text":      self.text,
            "timestamp": self.timestamp.strftime("%H:%M"),
            "room":      self.room,
        }


class ActiveUser(db.Model):
    __tablename__ = "active_users"
    sid      = db.Column(db.String(128), primary_key=True)
    username = db.Column(db.String(64), nullable=False)
    joined   = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))


# ── Inicialização ─────────────────────────────────────────────────────────────
with app.app_context():
    db.create_all()


# ── HTTP Routes ───────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return jsonify({"status": "online", "role": SERVER_ROLE})


@app.route("/health")
def health():
    return jsonify({"status": "online", "role": SERVER_ROLE, "ts": time.time()})


@app.route("/history")
def history():
    """Retorna as últimas 50 mensagens para reconstruir histórico no cliente."""
    room = request.args.get("room", "geral")
    msgs = (
        Message.query
        .filter_by(room=room)
        .order_by(Message.timestamp.asc())
        .limit(50)
        .all()
    )
    return jsonify([m.to_dict() for m in msgs])


@app.route("/admin/kill", methods=["POST"])
def kill_server():
    """
    Endpoint para demonstração: simula falha do servidor primário.
    Mata o processo após 500ms (tempo suficiente para o cliente receber a resposta).
    Em produção real, nunca exponha isso — aqui é só para a demo do trabalho.
    """
    def _shutdown():
        time.sleep(0.5)
        os.kill(os.getpid(), signal.SIGTERM)

    t = threading.Thread(target=_shutdown, daemon=True)
    t.start()
    return jsonify({"msg": "Servidor primário sendo encerrado..."})


# ── WebSocket Events ──────────────────────────────────────────────────────────
@socketio.on("connect")
def on_connect():
    """
    Thread dedicada à conexão do cliente é gerenciada pelo Flask-SocketIO
    em async_mode='threading'. Cada 'on_connect' roda em sua própria thread.
    """
    print(f"[PRIMARY] Cliente conectado: {request.sid}", flush=True)
    emit("server_info", {"role": SERVER_ROLE})


@socketio.on("disconnect")
def on_disconnect():
    """Remove usuário da lista de ativos e notifica a sala."""
    user = ActiveUser.query.get(request.sid)
    if user:
        username = user.username
        room     = "geral"
        db.session.delete(user)
        db.session.commit()
        socketio.emit("user_left", {"username": username}, to=room)
        socketio.emit("user_list", _get_users(), to=room)
        print(f"[PRIMARY] {username} desconectou", flush=True)


@socketio.on("join")
def on_join(data):
    """
    Usuário entra no chat com um username.
    data = { "username": "...", "room": "geral" }
    """
    username = data.get("username", "Anônimo").strip()[:32]
    room     = data.get("room", "geral")

    # Persiste usuário ativo
    existing = ActiveUser.query.get(request.sid)
    if existing:
        existing.username = username
    else:
        db.session.add(ActiveUser(sid=request.sid, username=username))
    db.session.commit()

    join_room(room)

    # Envia histórico apenas para quem acabou de entrar
    msgs = (
        Message.query
        .filter_by(room=room)
        .order_by(Message.timestamp.asc())
        .limit(50)
        .all()
    )
    emit("history", [m.to_dict() for m in msgs])

    # Notifica sala sobre novo usuário
    socketio.emit("user_joined", {"username": username}, to=room)
    socketio.emit("user_list", _get_users(), to=room)
    print(f"[PRIMARY] {username} entrou na sala '{room}'", flush=True)


@socketio.on("message")
def on_message(data):
    """
    Recebe mensagem de um cliente, persiste no banco e retransmite a TODOS na sala.
    data = { "text": "...", "room": "geral" }
    """
    user = ActiveUser.query.get(request.sid)
    if not user:
        return

    text = data.get("text", "").strip()
    room = data.get("room", "geral")
    if not text:
        return

    # Persiste
    msg = Message(sender=user.username, text=text, room=room)
    db.session.add(msg)
    db.session.commit()

    # Broadcast para todos na sala (inclusive o remetente)
    socketio.emit("message", msg.to_dict(), to=room)
    print(f"[PRIMARY] [{room}] {user.username}: {text[:40]}", flush=True)


@socketio.on("typing")
def on_typing(data):
    """Broadcast do indicador de digitação para os outros usuários da sala."""
    user = ActiveUser.query.get(request.sid)
    if not user:
        return
    room = data.get("room", "geral")
    # Emite para todos EXCETO o remetente
    emit("typing", {"username": user.username}, to=room, include_self=False)


@socketio.on("stop_typing")
def on_stop_typing(data):
    user = ActiveUser.query.get(request.sid)
    if not user:
        return
    room = data.get("room", "geral")
    emit("stop_typing", {"username": user.username}, to=room, include_self=False)


# ── Helpers ───────────────────────────────────────────────────────────────────
def _get_users():
    return [u.username for u in ActiveUser.query.all()]


# ── Entry Point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    print(f"[PRIMARY] Iniciando servidor primário na porta {port}", flush=True)
    socketio.run(app, host="0.0.0.0", port=port, debug=False, allow_unsafe_werkzeug=True)
