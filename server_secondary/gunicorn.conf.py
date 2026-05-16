# gunicorn.conf.py — configuração para Flask-SocketIO com eventlet
# O Flask-SocketIO EXIGE worker_class=eventlet e apenas 1 worker
# quando não há message queue (Redis). Com 1 worker, todas as conexões
# WebSocket são gerenciadas por coroutines do eventlet na mesma instância.

import eventlet
eventlet.monkey_patch()

worker_class = "eventlet"
workers = 1
bind = "0.0.0.0:10000"
timeout = 120
keepalive = 5
loglevel = "info"
accesslog = "-"
errorlog = "-"
