"""
SockeText — Servidor Secundário
Mesmas correções do primário.
Adicionado: polling para detectar quando o primário voltou e avisar os clientes.
"""

import os
import threading
import time
import signal
import requests
from datetime import datetime, timezone

from flask import Flask, request, jsonify
from flask_socketio import SocketIO, emit, join_room
from flask_sqlalchemy import SQLAlchemy
from flask_cors import CORS

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "socktext-secondary-secret")
app.config["SQLALCHEMY_DATABASE_URI"] = os.environ.get(
    "DATABASE_URL", "sqlite:///chat_secondary.db"
).replace("postgres://", "postgresql://")
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

CORS(app, origins="*")
db = SQLAlchemy(app)
socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode="threading",
    logger=False,
    engineio_logger=False,
    ping_timeout=8,
    ping_interval=4,
)

SERVER_ROLE = "secondary"
PRIMARY_URL = os.environ.get("PRIMARY_URL", "https://socketext-primary.onrender.com")

# Controla se o primário estava fora e voltou
_primary_was_down = False
_monitor_started  = False


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


with app.app_context():
    db.create_all()
    try:
        db.session.query(ActiveUser).delete()
        db.session.commit()
        print("[SECONDARY] Startup: active_users limpos.", flush=True)
    except Exception as e:
        db.session.rollback()
        print(f"[SECONDARY] Aviso startup: {e}", flush=True)


# ── Monitor do primário ───────────────────────────────────────────────────────
def _monitor_primary():
    """
    Roda em thread separada.
    Verifica a cada 15s se o primário voltou.
    Quando detecta que voltou, emite "primary_back" para todos os clientes
    conectados ao secundário — o cliente JS então migra de volta sozinho.
    """
    global _primary_was_down
    time.sleep(20)  # aguarda o secundário estabilizar antes de começar

    while True:
        time.sleep(15)
        try:
            r = requests.get(f"{PRIMARY_URL}/health", timeout=4)
            if r.status_code == 200:
                if _primary_was_down:
                    print("[SECONDARY] Primário voltou! Avisando clientes...", flush=True)
                    _primary_was_down = False
                    with app.app_context():
                        socketio.emit("primary_back", {"url": PRIMARY_URL}, namespace="/")
            else:
                _primary_was_down = True
        except Exception:
            _primary_was_down = True


# ── HTTP Routes ───────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return jsonify({"status": "online", "role": SERVER_ROLE})

@app.route("/health")
def health():
    return jsonify({"status": "online", "role": SERVER_ROLE, "ts": time.time()})


# ── WebSocket Events ──────────────────────────────────────────────────────────
@socketio.on("connect")
def on_connect():
    global _monitor_started, _primary_was_down
    print(f"[SECONDARY] + {request.sid}", flush=True)
    emit("server_info", {"role": SERVER_ROLE})

    # Marca que o primário estava fora (alguém conectou no secundário)
    _primary_was_down = True

    # Inicia o monitor só uma vez
    if not _monitor_started:
        _monitor_started = True
        t = threading.Thread(target=_monitor_primary, daemon=True)
        t.start()
        print("[SECONDARY] Monitor do primário iniciado.", flush=True)

@socketio.on("disconnect")
def on_disconnect():
    user = ActiveUser.query.get(request.sid)
    if user:
        uname = user.username
        db.session.delete(user)
        db.session.commit()
        socketio.emit("user_left", {"username": uname}, to="geral")
        socketio.emit("user_list", _get_users(), to="geral")

@socketio.on("join")
def on_join(data):
    username = data.get("username", "Anônimo").strip()[:32]
    room     = data.get("room", "geral")

    for stale in ActiveUser.query.filter_by(username=username).all():
        if stale.sid != request.sid:
            db.session.delete(stale)

    existing = ActiveUser.query.get(request.sid)
    if existing:
        existing.username = username
    else:
        db.session.add(ActiveUser(sid=request.sid, username=username))
    db.session.commit()

    join_room(room)

    msgs = (
        Message.query.filter_by(room=room)
        .order_by(Message.timestamp.asc()).limit(50).all()
    )
    emit("history", [m.to_dict() for m in msgs])

    emit("user_joined", {"username": username}, to=room, include_self=False)
    socketio.emit("user_list", _get_users(), to=room)
    print(f"[SECONDARY] {username} entrou", flush=True)

@socketio.on("message")
def on_message(data):
    user = ActiveUser.query.get(request.sid)
    if not user:
        return
    text = data.get("text", "").strip()
    room = data.get("room", "geral")
    if not text:
        return
    msg = Message(sender=user.username, text=text, room=room)
    db.session.add(msg)
    db.session.commit()
    socketio.emit("message", msg.to_dict(), to=room)

@socketio.on("typing")
def on_typing(data):
    user = ActiveUser.query.get(request.sid)
    if not user: return
    emit("typing", {"username": user.username}, to=data.get("room","geral"), include_self=False)

@socketio.on("stop_typing")
def on_stop_typing(data):
    user = ActiveUser.query.get(request.sid)
    if not user: return
    emit("stop_typing", {"username": user.username}, to=data.get("room","geral"), include_self=False)

def _get_users():
    return [u.username for u in ActiveUser.query.all()]

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5002))
    socketio.run(app, host="0.0.0.0", port=port, debug=False, allow_unsafe_werkzeug=True)
