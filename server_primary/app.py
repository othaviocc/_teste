"""
SockeText — Servidor Primário v4 (Grupos Eternos no BD + Validação de Criação)
"""
import os, threading, time, signal
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
    return jsonify({"status": "online", "role": SERVER_ROLE, "ts": time.time()})

@app.route("/admin/kill", methods=["POST"])
def kill_server():
    global _killing
    if _killing:
        return jsonify({"msg": "ja encerrando"}), 200
    _killing = True

    def _die():
        try:
            socketio.emit("server_shutdown", {"role": "primary"}, namespace="/")
        except Exception:
            pass
        time.sleep(1.0)  
        os.kill(os.getpid(), signal.SIGTERM)

    threading.Thread(target=_die, daemon=True).start()
    return jsonify({"msg": "encerrando"}), 200

@socketio.on("connect")
def on_connect():
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
    
    # Validação rigorosa: Impede a re-criação do grupo se ele já existe
    existing = ChatRoom.query.get(slug)
    if existing:
        return {"ok": False, "error": f"O grupo '{name}' já existe! Escolha ele na lista."}
        
    db.session.add(ChatRoom(slug=slug, name=name))
    db.session.commit()
    socketio.emit("room_created", {"slug": slug, "name": name})
        
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
    user = active_users.get(request.sid)
    if not user:
        return

    text          = data.get("text", "").strip()
    room          = data.get("room", "geral")
    client_msg_id = data.get("client_msg_id")

    if not text:
        return

    msg = Message(sender=user["username"], text=text, room=room)
    db.session.add(msg)
    db.session.commit()

    socketio.emit("message", msg.to_dict(), to=room)
    return {"ok": True, "server_id": msg.id, "client_msg_id": client_msg_id}

@socketio.on("typing")
def on_typing(data):
    user = active_users.get(request.sid)
    if not user: return
    emit("typing", {"username": user["username"]}, to=data.get("room", "geral"), include_self=False)

@socketio.on("stop_typing")
def on_stop_typing(data):
    user = active_users.get(request.sid)
    if not user: return
    emit("stop_typing", {"username": user["username"]}, to=data.get("room", "geral"), include_self=False)

def _get_users(room="geral"):
    return [u["username"] for sid, u in active_users.items() if u["room"] == room]

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    socketio.run(app, host="0.0.0.0", port=port, debug=False, allow_unsafe_werkzeug=True)