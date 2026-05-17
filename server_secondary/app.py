"""
SockeText — Servidor Secundário v4 (Corrigido)
Mesmas funcionalidades do primário com correções de estado em memória.
Adiciona: polling para detectar quando primário voltou.
"""
import os, threading, time, requests as req_lib
from datetime import datetime, timezone
from flask import Flask, request, jsonify
from flask_socketio import SocketIO, emit, join_room
from flask_sqlalchemy import SQLAlchemy
from flask_cors import CORS

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "socktext-secondary-secret")
app.config["SQLALCHEMY_DATABASE_URI"] = os.environ.get(
    "DATABASE_URL", "sqlite:///chat_sec.db"
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

SERVER_ROLE  = "secondary"
PRIMARY_URL  = os.environ.get("PRIMARY_URL", "https://socketext-primary.onrender.com")
_primary_down   = False
_monitor_thread = None

# --- Gestão de estado em memória ---
active_users = {}

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

def _monitor_primary():
    global _primary_down
    time.sleep(60)
    print("[SECONDARY] Iniciando monitor do primário...", flush=True)
    while True:
        time.sleep(15)
        try:
            r = req_lib.get(f"{PRIMARY_URL}/health", timeout=5)
            if r.status_code == 200 and r.json().get("status") == "online":
                if _primary_down:
                    print("[SECONDARY] Primário voltou — notificando clientes", flush=True)
                    _primary_down = False
                    socketio.emit("primary_back", {"url": PRIMARY_URL}, namespace="/")
        except Exception:
            _primary_down = True

@app.route("/")
def index():
    return jsonify({"status": "online", "role": SERVER_ROLE})

@app.route("/health")
def health():
    return jsonify({"status": "online", "role": SERVER_ROLE, "ts": time.time()})

@socketio.on("connect")
def on_connect():
    global _primary_down, _monitor_thread
    _primary_down = True
    emit("server_info", {"role": SERVER_ROLE})

    if _monitor_thread is None or not _monitor_thread.is_alive():
        _monitor_thread = threading.Thread(target=_monitor_primary, daemon=True)
        _monitor_thread.start()

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
    emit("typing", {"username": user["username"]},
         to=data.get("room", "geral"), include_self=False)

@socketio.on("stop_typing")
def on_stop_typing(data):
    user = active_users.get(request.sid)
    if not user: return
    emit("stop_typing", {"username": user["username"]},
         to=data.get("room", "geral"), include_self=False)

def _get_users(room="geral"):
    return [u["username"] for sid, u in active_users.items() if u["room"] == room]

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5002))
    socketio.run(app, host="0.0.0.0", port=port, debug=False, allow_unsafe_werkzeug=True)