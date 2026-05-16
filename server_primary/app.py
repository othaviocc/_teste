"""
SockeText — Servidor Primário
Correções:
- Limpa active_users órfãos no startup (evita usuário duplicado)
- /admin/kill responde imediatamente e mata em 150ms (kill mais rápido)
- user_joined só emite para os OUTROS (não dispara para o próprio usuário)
"""

import os
import threading
import time
import signal
from datetime import datetime, timezone

from flask import Flask, request, jsonify
from flask_socketio import SocketIO, emit, join_room
from flask_sqlalchemy import SQLAlchemy
from flask_cors import CORS

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "socktext-primary-secret")
app.config["SQLALCHEMY_DATABASE_URI"] = os.environ.get(
    "DATABASE_URL", "sqlite:///chat.db"
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

SERVER_ROLE = "primary"
_killing = False


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
        print("[PRIMARY] Startup: active_users limpos.", flush=True)
    except Exception as e:
        db.session.rollback()
        print(f"[PRIMARY] Aviso startup: {e}", flush=True)


@app.route("/")
def index():
    return jsonify({"status": "online", "role": SERVER_ROLE})

@app.route("/health")
def health():
    return jsonify({"status": "online", "role": SERVER_ROLE, "ts": time.time()})

@app.route("/admin/kill", methods=["POST"])
def kill_server():
    global _killing
    if _killing:
        return jsonify({"msg": "ja encerrando"}), 200
    _killing = True
    def _die():
        time.sleep(0.15)
        os.kill(os.getpid(), signal.SIGTERM)
    threading.Thread(target=_die, daemon=True).start()
    return jsonify({"msg": "encerrando"}), 200


@socketio.on("connect")
def on_connect():
    print(f"[PRIMARY] + {request.sid}", flush=True)
    emit("server_info", {"role": SERVER_ROLE})

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

    # Remove sessões duplicadas do mesmo username
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

    # Só notifica os OUTROS que alguém entrou (não o próprio)
    emit("user_joined", {"username": username}, to=room, include_self=False)
    socketio.emit("user_list", _get_users(), to=room)
    print(f"[PRIMARY] {username} entrou", flush=True)

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
    port = int(os.environ.get("PORT", 5001))
    socketio.run(app, host="0.0.0.0", port=port, debug=False, allow_unsafe_werkzeug=True)
