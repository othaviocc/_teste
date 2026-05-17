"""
SockeText — Servidor Primário v4
Melhorias críticas:
- Confirmação de mensagem (ACK) via callback do Socket.IO
- Broadcast de "server_shutdown" antes de morrer (clientes migram antes do TCP fechar)
- Limpeza de usuários órfãos no startup
- /health com CORS explícito para polling do cliente
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
    room     = db.Column(db.String(64), default="geral")
    joined   = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))


with app.app_context():
    db.create_all()
    try:
        db.session.query(ActiveUser).delete()
        db.session.commit()
    except Exception:
        db.session.rollback()


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
        # 1. Avisa TODOS os clientes conectados para migrarem AGORA
        #    Isso acontece antes do TCP fechar — clientes recebem o evento
        #    e iniciam a reconexão ao secundário antes de perder a conexão
        try:
            socketio.emit("server_shutdown", {"role": "primary"}, namespace="/")
        except Exception:
            pass
        time.sleep(0.3)  # aguarda o evento chegar nos clientes
        os.kill(os.getpid(), signal.SIGTERM)

    threading.Thread(target=_die, daemon=True).start()
    return jsonify({"msg": "encerrando"}), 200


@socketio.on("connect")
def on_connect():
    emit("server_info", {"role": SERVER_ROLE})

@socketio.on("disconnect")
def on_disconnect():
    user = ActiveUser.query.get(request.sid)
    if user:
        uname = user.username
        room  = user.room
        db.session.delete(user)
        db.session.commit()
        socketio.emit("user_left", {"username": uname}, to=room)
        socketio.emit("user_list", _get_users(room), to=room)

@socketio.on("join")
def on_join(data):
    uname = data.get("username", "Anônimo").strip()[:32]
    room  = data.get("room", "geral")

    for stale in ActiveUser.query.filter_by(username=uname).all():
        if stale.sid != request.sid:
            db.session.delete(stale)

    existing = ActiveUser.query.get(request.sid)
    if existing:
        existing.username = uname
        existing.room     = room
    else:
        db.session.add(ActiveUser(sid=request.sid, username=uname, room=room))
    db.session.commit()

    join_room(room)

    msgs = (Message.query.filter_by(room=room)
            .order_by(Message.timestamp.asc()).limit(80).all())
    emit("history", [m.to_dict() for m in msgs])
    emit("user_joined", {"username": uname}, to=room, include_self=False)
    socketio.emit("user_list", _get_users(room), to=room)

@socketio.on("message")
def on_message(data, *args):
    """
    Aceita callback (ACK) do Socket.IO.
    Fluxo: cliente envia {text, room, client_msg_id}
           servidor salva no banco
           servidor faz broadcast
           servidor chama callback({"ok": True, "id": msg.id})
           cliente remove da outbox ao receber ACK
    """
    user = ActiveUser.query.get(request.sid)
    if not user:
        return

    text          = data.get("text", "").strip()
    room          = data.get("room", "geral")
    client_msg_id = data.get("client_msg_id")  # ID local do cliente para ACK

    if not text:
        return

    msg = Message(sender=user.username, text=text, room=room)
    db.session.add(msg)
    db.session.commit()

    socketio.emit("message", msg.to_dict(), to=room)

    # Confirma para o remetente que a mensagem foi persistida
    if args and callable(args[0]):
        args[0]({"ok": True, "server_id": msg.id, "client_msg_id": client_msg_id})

@socketio.on("typing")
def on_typing(data):
    user = ActiveUser.query.get(request.sid)
    if not user: return
    emit("typing", {"username": user.username},
         to=data.get("room", "geral"), include_self=False)

@socketio.on("stop_typing")
def on_stop_typing(data):
    user = ActiveUser.query.get(request.sid)
    if not user: return
    emit("stop_typing", {"username": user.username},
         to=data.get("room", "geral"), include_self=False)

def _get_users(room="geral"):
    return [u.username for u in ActiveUser.query.filter_by(room=room).all()]

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    socketio.run(app, host="0.0.0.0", port=port, debug=False, allow_unsafe_werkzeug=True)
