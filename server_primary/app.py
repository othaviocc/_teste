"""
SockeText — Servidor Primário v4 (Suspensão 60s + Replicação P2P)
"""
import os, threading, time
from datetime import datetime, timezone
from flask import Flask, request, jsonify
from flask_socketio import SocketIO, emit, join_room
from flask_sqlalchemy import SQLAlchemy
from flask_cors import CORS
import requests as req_lib  # Necessário para replicar com o secundário

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
SECONDARY_URL = os.environ.get("SECONDARY_URL", "https://socketext-secondary.onrender.com")

# Trava de suspensão (timestamp)
_suspended_until = 0
active_users = {}

class ChatRoom(db.Model):
    __tablename__ = "rooms"
    slug = db.Column(db.String(64), primary_key=True)
    name = db.Column(db.String(64), nullable=False)

    def to_dict(self):
        return {"slug": self.slug, "name": self.name}

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

with app.app_context():
    db.create_all()
    if not ChatRoom.query.get("geral"):
        db.session.add(ChatRoom(slug="geral", name="Geral"))
        db.session.commit()

@app.route("/")
def index():
    return jsonify({"status": "online", "role": SERVER_ROLE})

@app.route("/health")
def health():
    # Se estiver no período de suspensão, reporta offline
    if time.time() < _suspended_until:
        return jsonify({"status": "offline", "role": SERVER_ROLE, "ts": time.time()})
    return jsonify({"status": "online", "role": SERVER_ROLE, "ts": time.time()})

@app.route("/admin/suspend", methods=["POST"])
def suspend_server():
    global _suspended_until
    # Suspende o servidor por 60 segundos
    _suspended_until = time.time() + 60
    
    # Grita para os clientes migrarem
    socketio.emit("server_shutdown", {"role": "primary"}, namespace="/")
    return jsonify({"msg": "Servidor suspenso por 60 segundos"}), 200

# Rota interna para receber sincronização de salas do Secundário
@app.route("/internal/replicate_room", methods=["POST"])
def replicate_room():
    data = request.get_json() or {}
    slug = data.get("slug")
    name = data.get("name")
    if slug and name:
        if not ChatRoom.query.get(slug):
            db.session.add(ChatRoom(slug=slug, name=name))
            db.session.commit()
            socketio.emit("room_created", {"slug": slug, "name": name})
    return jsonify({"ok": True})

@socketio.on("connect")
def on_connect():
    # Rejeita conexão WebSocket se estiver suspenso
    if time.time() < _suspended_until:
        return False 
        
    emit("server_info", {"role": SERVER_ROLE})
    rooms = [r.to_dict() for r in ChatRoom.query.all()]
    emit("room_list", rooms)

@socketio.on("create_room")
def on_create_room(data):
    name = data.get("name", "").strip()
    if not name: 
        return {"ok": False, "error": "Nome de grupo inválido."}
    slug = name.lower().replace(" ", "-")[:24]
    if not slug:
        return {"ok": False, "error": "Nome de grupo inválido."}
    
    existing = ChatRoom.query.get(slug)
    if existing:
        return {"ok": False, "error": f"O grupo '{name}' já existe! Escolha ele na lista."}
        
    db.session.add(ChatRoom(slug=slug, name=name))
    db.session.commit()
    socketio.emit("room_created", {"slug": slug, "name": name})
    
    # REPLICAÇÃO ATIVA: Avisa o Secundário que a sala foi criada
    def _sync():
        try:
            req_lib.post(f"{SECONDARY_URL}/internal/replicate_room", json={"slug": slug, "name": name}, timeout=3)
        except Exception as e:
            pass
    threading.Thread(target=_sync, daemon=True).start()
        
    return {"ok": True, "slug": slug}

@socketio.on("disconnect")
def on_disconnect():
    user = active_users.pop(request.sid, None)
    if user:
        uname = user["username"]
        room  = user["room"]
        socketio.emit("user_left", {"username": uname}, to=room)
        socketio.emit("user_list", _get_users(room), to=room)

@socketio.on("join")
def on_join(data):
    if time.time() < _suspended_until: return False

    uname = data.get("username", "Anônimo").strip()[:32]
    room  = data.get("room", "geral")

    existing = ChatRoom.query.get(room)
    if not existing:
        name = room.replace("-", " ").title()
        db.session.add(ChatRoom(slug=room, name=name))
        db.session.commit()
        socketio.emit("room_created", {"slug": room, "name": name})

    active_users[request.sid] = {"username": uname, "room": room}
    join_room(room)

    msgs = (Message.query.filter_by(room=room)
            .order_by(Message.timestamp.asc()).limit(80).all())
    emit("history", [m.to_dict() for m in msgs])
    emit("user_joined", {"username": uname}, to=room, include_self=False)
    socketio.emit("user_list", _get_users(room), to=room)

@socketio.on("message")
def on_message(data):
    if time.time() < _suspended_until: return False

    user = active_users.get(request.sid)
    if not user: return

    text          = data.get("text", "").strip()
    room          = data.get("room", "geral")
    client_msg_id = data.get("client_msg_id")

    if not text: return

    msg = Message(sender=user["username"], text=text, room=room)
    db.session.add(msg)
    db.session.commit()

    socketio.emit("message", msg.to_dict(), to=room)
    return {"ok": True, "server_id": msg.id, "client_msg_id": client_msg_id}

@socketio.on("typing")
def on_typing(data):
    if time.time() < _suspended_until: return False
    user = active_users.get(request.sid)
    if not user: return
    emit("typing", {"username": user["username"]}, to=data.get("room", "geral"), include_self=False)

@socketio.on("stop_typing")
def on_stop_typing(data):
    if time.time() < _suspended_until: return False
    user = active_users.get(request.sid)
    if not user: return
    emit("stop_typing", {"username": user["username"]}, to=data.get("room", "geral"), include_self=False)

def _get_users(room="geral"):
    return [u["username"] for sid, u in active_users.items() if u["room"] == room]

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    socketio.run(app, host="0.0.0.0", port=port, debug=False, allow_unsafe_werkzeug=True)