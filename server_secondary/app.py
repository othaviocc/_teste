"""
SockeText — Servidor Secundário
Idêntico ao primário em funcionalidade.
Usa o MESMO banco de dados PostgreSQL → histórico nunca se perde.
Não expõe /admin/kill (o secundário não pode ser derrubado pela demo).
"""

import os
import threading
import time
from datetime import datetime, timezone

from flask import Flask, request, jsonify
from flask_socketio import SocketIO, emit, join_room, leave_room
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
    ping_timeout=10,
    ping_interval=5,
)

SERVER_ROLE = "secondary"


# ── Modelos (mesmas tabelas do primário) ─────────────────────────────────────
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


# ── HTTP Routes ───────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return jsonify({"status": "online", "role": SERVER_ROLE})


@app.route("/health")
def health():
    return jsonify({"status": "online", "role": SERVER_ROLE, "ts": time.time()})


@app.route("/history")
def history():
    room = request.args.get("room", "geral")
    msgs = (
        Message.query
        .filter_by(room=room)
        .order_by(Message.timestamp.asc())
        .limit(50)
        .all()
    )
    return jsonify([m.to_dict() for m in msgs])


# ── WebSocket Events ──────────────────────────────────────────────────────────
@socketio.on("connect")
def on_connect():
    print(f"[SECONDARY] Cliente conectado: {request.sid}", flush=True)
    emit("server_info", {"role": SERVER_ROLE})


@socketio.on("disconnect")
def on_disconnect():
    user = ActiveUser.query.get(request.sid)
    if user:
        username = user.username
        db.session.delete(user)
        db.session.commit()
        socketio.emit("user_left", {"username": username}, to="geral")
        socketio.emit("user_list", _get_users(), to="geral")


@socketio.on("join")
def on_join(data):
    username = data.get("username", "Anônimo").strip()[:32]
    room     = data.get("room", "geral")

    existing = ActiveUser.query.get(request.sid)
    if existing:
        existing.username = username
    else:
        db.session.add(ActiveUser(sid=request.sid, username=username))
    db.session.commit()

    join_room(room)

    msgs = (
        Message.query
        .filter_by(room=room)
        .order_by(Message.timestamp.asc())
        .limit(50)
        .all()
    )
    emit("history", [m.to_dict() for m in msgs])
    socketio.emit("user_joined", {"username": username}, to=room)
    socketio.emit("user_list", _get_users(), to=room)
    print(f"[SECONDARY] {username} entrou na sala '{room}'", flush=True)


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
    print(f"[SECONDARY] [{room}] {user.username}: {text[:40]}", flush=True)


@socketio.on("typing")
def on_typing(data):
    user = ActiveUser.query.get(request.sid)
    if not user:
        return
    room = data.get("room", "geral")
    emit("typing", {"username": user.username}, to=room, include_self=False)


@socketio.on("stop_typing")
def on_stop_typing(data):
    user = ActiveUser.query.get(request.sid)
    if not user:
        return
    room = data.get("room", "geral")
    emit("stop_typing", {"username": user.username}, to=room, include_self=False)


def _get_users():
    return [u.username for u in ActiveUser.query.all()]


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5002))
    print(f"[SECONDARY] Iniciando servidor secundário na porta {port}", flush=True)
    socketio.run(app, host="0.0.0.0", port=port, debug=False, allow_unsafe_werkzeug=True)
