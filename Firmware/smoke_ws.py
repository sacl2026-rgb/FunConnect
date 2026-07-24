# smoke_ws.py  -- Phase 1 telemetry, HARDENED
# Adds: exponential-backoff reconnect, periodic gc.collect (heap hygiene for
# multi-day runs), graceful error-frame handling (DO alive but rejected != drop),
# and a WDT availability probe (reported on LCD; not engaged yet - a mis-set
# watchdog causes reset loops, so we confirm it's safe before wiring it).
# Keeps: telemetry+ack, buf-driven dead-alarm auto-rotation, stable identity.
# CyberPi -> ws://funconnect-v1.funconnect.workers.dev:80/device/<id> -> DO
#
# LED: orange=connecting  green flash=connected  dim green=idle
#      blue blip=state sent  green blip=ack  magenta blip=missed ack
#      red blip=DO error frame  yellow blinks=rotating id  orange blinks=reconnect
from cyberpi import *
import cyberpi
import utime
import usocket as socket
import uos as os
import ustruct as struct
import ujson as json
import ubinascii
try:
    import gc
except Exception:
    gc = None
try:
    import machine
except Exception:
    machine = None

HOST = "funconnect-v1.funconnect.workers.dev"
PORT = 80
DEVICE_BASE = "mbot2-01"          # unique STABLE identity for this physical device
PATH_FIXED = "/device/" + DEVICE_BASE  # WSS path never changes — one DO forever
WIFI_SSID = "CMHK-ECch"
WIFI_PASS = "gt5cqu69"
SOCK_TIMEOUT = 10
ACK_TIMEOUT = 5
TELEMETRY_INTERVAL = 1            # seconds — near-real-time dashboards, 86% SQLite quota (upsert lowers)
MAX_MISSED = 3                    # missed acks -> reconnect
BUF_ROTATE_THRESHOLD = 120        # ack buf past this = dead alarm -> rotate id
RECONNECT_BASE = 2                # backoff start (s)
RECONNECT_MAX = 30                # backoff ceiling (s)
GC_EVERY = 5                      # gc.collect every N telemetry cycles

device_id = DEVICE_BASE           # rotates ONLY on dead-alarm detection
rotation = 0

show = lambda r, g, b: led.on(r, g, b)
def scr(msg):
    try:
        cyberpi.console.println(str(msg))
    except Exception:
        pass

def blink(r, g, b, n):
    for _ in range(n):
        show(r, g, b); utime.sleep(0.15); show(0, 0, 0); utime.sleep(0.15)

def _recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise OSError("closed")
        buf += chunk
    return buf

def _send_frame(sock, opcode, payload=b""):
    n = len(payload)
    hdr = bytearray()
    hdr.append(0x80 | opcode)
    if n < 126:
        hdr.append(0x80 | n)
    elif n < 65536:
        hdr.append(0x80 | 126); hdr += struct.pack(">H", n)
    else:
        hdr.append(0x80 | 127); hdr += struct.pack(">Q", n)
    mask = os.urandom(4)
    hdr += mask
    out = bytearray(n)
    for i in range(n):
        out[i] = payload[i] ^ mask[i & 3]
    sock.send(bytes(hdr) + bytes(out))

def ws_send_text(sock, text):
    _send_frame(sock, 0x1, text.encode())

def recv_frame(sock):
    h = _recv_exact(sock, 2)
    b1 = h[0]; b2 = h[1]
    opcode = b1 & 0x0F
    masked = b2 & 0x80
    length = b2 & 0x7F
    if length == 126:
        length = struct.unpack(">H", _recv_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack(">Q", _recv_exact(sock, 8))[0]
    m = _recv_exact(sock, 4) if masked else None
    payload = _recv_exact(sock, length) if length else b""
    if m:
        pb = bytearray(length)
        for i in range(length):
            pb[i] = payload[i] ^ m[i & 3]
        payload = bytes(pb)
    if opcode == 0x9:
        _send_frame(sock, 0xA, payload)
    return opcode, payload

def ws_handshake(sock, host, path):
    key = ubinascii.b2a_base64(os.urandom(16)).rstrip().decode()
    req = ("GET " + path + " HTTP/1.1\r\nHost: " + host +
           "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
           "Sec-WebSocket-Key: " + key +
           "\r\nSec-WebSocket-Version: 13\r\n\r\n")
    sock.send(req.encode())
    resp = b""
    while b"\r\n\r\n" not in resp:
        chunk = sock.recv(256)
        if not chunk:
            raise OSError("closed in handshake")
        resp += chunk
        if len(resp) > 2048:
            break
    if b"101" not in resp.split(b"\r\n", 1)[0]:
        raise OSError("no 101")
    return True

def ensure_wifi():
    if wifi.is_connected():
        return
    show(40, 40, 40)
    wifi.connect(WIFI_SSID, WIFI_PASS)
    t_end = utime.ticks_add(utime.ticks_ms(), 20000)
    while not wifi.is_connected():
        if utime.ticks_diff(t_end, utime.ticks_ms()) < 0:
            raise OSError("wifi timeout")
        utime.sleep(0.5)

def connect():
    ensure_wifi()
    path = PATH_FIXED   # stable — rotation only changes JSON device_id, not the DO
    addr = socket.getaddrinfo(HOST, PORT)[0][-1]
    s = socket.socket()
    try:
        s.settimeout(SOCK_TIMEOUT)
    except Exception:
        pass
    s.connect(addr)
    ws_handshake(s, HOST, path)
    _send_frame(s, 0x1, json.dumps({"type": "hello", "device_id": device_id}).encode())
    recv_frame(s)   # welcome
    recv_frame(s)   # sync
    return s

def read_telemetry():
    def rd(fn, *a):
        try:
            return fn(*a)
        except Exception:
            return 0
    return {
        "tilt": rd(get_roll),
        "vibration": rd(get_shakeval) / 100.0,
        "acc_x": rd(get_acc, "x"), "acc_y": rd(get_acc, "y"), "acc_z": rd(get_acc, "z"),
        "gyro_x": rd(get_gyro, "x"), "gyro_y": rd(get_gyro, "y"), "gyro_z": rd(get_gyro, "z"),
    }

def memfree():
    try:
        return gc.mem_free() if gc else -1
    except Exception:
        return -1

# main
wdt_avail = 1 if (machine is not None and hasattr(machine, "WDT")) else 0
scr("Phase1 hardened " + device_id)
scr("WDT avail=" + str(wdt_avail) + " gc=" + str(1 if gc else 0))

sock = None
sent = 0
acks = 0
missed = 0
errs = 0
reconns = 0
backoff = RECONNECT_BASE

while True:
    if sock is None:
        try:
            show(255, 120, 0)
            sock = connect()
            scr("conn " + device_id)
            show(0, 255, 0); utime.sleep(0.3); show(0, 0, 0)
            missed = 0
            backoff = RECONNECT_BASE          # recovered -> reset backoff
        except Exception as e:
            reconns += 1
            scr("reconn " + str(reconns) + " in " + str(backoff) + "s " + str(e))
            blink(255, 120, 0, 3)
            utime.sleep(backoff)
            backoff = min(backoff * 2, RECONNECT_MAX)   # exponential backoff
            continue

    # send telemetry
    try:
        show(0, 0, 255)
        t0 = utime.ticks_ms()
        frame = {"type": "state", "device_id": device_id,
                 "esp32_ms": t0, "telemetry": read_telemetry(),
                 "health": {"mem": memfree(), "reconns": reconns,
                            "errs": errs, "rot": rotation}}
        ws_send_text(sock, json.dumps(frame))
        sent += 1
        utime.sleep(0.1); show(0, 0, 0)
    except Exception as e:
        scr("send fail:" + str(e))
        try:
            sock.close()
        except Exception:
            pass
        sock = None
        continue

    # wait for ack (ref=state), read buf, handle error frames
    got = False
    buf = None
    try:
        sock.settimeout(ACK_TIMEOUT)
        for _ in range(4):
            op, pl = recv_frame(sock)
            if op == 0x8:                      # server close
                raise OSError("server close")
            if op == 0x1:
                mm = json.loads(pl)
                t = mm.get("type")
                if t == "ack" and mm.get("ref") == "state":
                    got = True; buf = mm.get("buf"); break
                if t == "error":               # DO alive, frame rejected -> not a drop
                    errs += 1
                    scr("DO err: " + str(mm.get("message")))
                    show(255, 0, 0); utime.sleep(0.15); show(0, 0, 0)
                    got = True                 # connection is fine; don't reconnect
                    break
                if mm.get("command") == "echo":
                    text = None
                    p = mm.get("params")
                    if isinstance(p, dict):
                        text = p.get("text")
                    scr("ECHO: " + str(text))
                    show(255, 255, 0); utime.sleep(0.12); show(0, 0, 0)
                    ws_send_text(sock, json.dumps(
                        {"type": "echo_ack", "device_id": device_id,
                         "text": text, "ts": utime.ticks_ms()}))
                    got = True
                    break
                if mm.get("command") == "exec":
                    code = mm.get("code", "")
                    ok = True; err = None
                    try:
                        exec(code)
                    except Exception as e:
                        ok = False; err = str(e)
                    scr("EXEC: " + ("ok" if ok else "ERR:" + str(err)))
                    show(255, 0, 255); utime.sleep(0.12); show(0, 0, 0)
                    ws_send_text(sock, json.dumps(
                        {"type": "exec_ack", "device_id": device_id,
                         "status": "ok" if ok else "error",
                         "error": err, "ts": utime.ticks_ms()}))
                    got = True
                    break
                if mm.get("command") == "fs_test":
                    w = False; r = False; d = False; ferr = None
                    try:
                        try:
                            f = open("__test__.txt", "w")
                            f.write("ok"); f.close()
                            w = True
                        except Exception as e2:
                            ferr = "write:" + str(e2)
                        try:
                            f = open("__test__.txt", "r")
                            r = (f.read() == "ok"); f.close()
                        except Exception as e2:
                            if not ferr: ferr = "read:" + str(e2)
                        try:
                            os.remove("__test__.txt"); d = True
                        except Exception:
                            pass
                    except Exception as e2:
                        if not ferr: ferr = str(e2)
                    scr("FS: w=" + str(w) + " r=" + str(r) + " d=" + str(d))
                    show(0, 255, 255); utime.sleep(0.12); show(0, 0, 0)
                    ws_send_text(sock, json.dumps(
                        {"type": "fs_ack", "device_id": device_id,
                         "write": w, "read": r, "delete": d,
                         "error": ferr, "ts": utime.ticks_ms()}))
                    got = True
                    break
    except Exception as e:
        scr("ack err:" + str(e))
        try:
            sock.close()
        except Exception:
            pass
        sock = None
        continue

    if got and buf is not None:
        acks += 1
        missed = 0
        rtt = utime.ticks_diff(utime.ticks_ms(), t0)
        show(0, 255, 0); utime.sleep(0.15); show(0, 0, 0)
        scr("st " + str(sent) + " ack " + str(acks) + " rtt " + str(rtt) +
            " buf " + str(buf) + " mem " + str(memfree()))
        if buf > BUF_ROTATE_THRESHOLD:         # dead alarm -> rotate to fresh DO
            rotation += 1
            device_id = DEVICE_BASE + "-r" + str(rotation)
            scr("ALARM DEAD buf=" + str(buf) + " -> " + device_id)
            blink(255, 255, 0, 4)
            try:
                sock.close()
            except Exception:
                pass
            sock = None
            continue
    elif got:
        pass                                   # error frame already handled
    else:
        missed += 1
        show(255, 0, 255); utime.sleep(0.15); show(0, 0, 0)
        scr("no-ack x" + str(missed))
        if missed >= MAX_MISSED:
            scr("reconnect (no ack)")
            try:
                sock.close()
            except Exception:
                pass
            sock = None
            continue

    # heap hygiene for long runs
    if gc and (sent % GC_EVERY == 0):
        try:
            gc.collect()
        except Exception:
            pass

    show(0, 40, 0)
    # responsive idle: 1s chunks, poll for inbound commands (echo, set_led)
    for _ in range(TELEMETRY_INTERVAL):
        utime.sleep(1)
        try:
            sock.settimeout(0.3)
            op, pl = recv_frame(sock)
            if op == 0x1:
                mm = json.loads(pl)
                if mm.get("command") == "echo":
                    p = mm.get("params")
                    text = p.get("text") if isinstance(p, dict) else None
                    scr("ECHO: " + str(text))
                    show(255, 255, 0); utime.sleep(0.12); show(0, 0, 0)
                    ws_send_text(sock, json.dumps(
                        {"type": "echo_ack", "device_id": device_id,
                         "text": text, "ts": utime.ticks_ms()}))
                if mm.get("command") == "exec":
                    code = mm.get("code", "")
                    ok = True; err = None
                    try:
                        exec(code)
                    except Exception as e2:
                        ok = False; err = str(e2)
                    scr("EXEC: " + ("ok" if ok else "ERR:" + str(err)))
                    show(255, 0, 255); utime.sleep(0.12); show(0, 0, 0)
                    ws_send_text(sock, json.dumps(
                        {"type": "exec_ack", "device_id": device_id,
                         "status": "ok" if ok else "error",
                         "error": err, "ts": utime.ticks_ms()}))
                if mm.get("command") == "fs_test":
                    w = False; r = False; d = False; ferr = None
                    try:
                        try:
                            f = open("__test__.txt", "w")
                            f.write("ok"); f.close()
                            w = True
                        except Exception as e2:
                            ferr = "write:" + str(e2)
                        try:
                            f = open("__test__.txt", "r")
                            r = (f.read() == "ok"); f.close()
                        except Exception as e2:
                            if not ferr: ferr = "read:" + str(e2)
                        try:
                            os.remove("__test__.txt"); d = True
                        except Exception:
                            pass
                    except Exception as e2:
                        if not ferr: ferr = str(e2)
                    scr("FS: w=" + str(w) + " r=" + str(r) + " d=" + str(d))
                    show(0, 255, 255); utime.sleep(0.12); show(0, 0, 0)
                    ws_send_text(sock, json.dumps(
                        {"type": "fs_ack", "device_id": device_id,
                         "write": w, "read": r, "delete": d,
                         "error": ferr, "ts": utime.ticks_ms()}))
        except Exception:
            pass
