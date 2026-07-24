# disturbance.py  -- S6: dual-state send-on-change + ring buffer
# STILL: 1 Hz IMU poll, delta check, 30s heartbeat, no ring, no jerk, 3% quota.
# ACTIVE: 25 Hz IMU, ring buffer, jerk gate, alert pipeline. 1s telemetry.
# IMU delta wakes the detector. Settle returns to idle. Ring only runs on activity.
# CyberPi -> ws://funconnect-v1.funconnect.workers.dev:80/device/mbot2-01 -> DO
#
# LED: dim green      = STILL (idle, heartbeat only)
#      bright green   = ACTIVE (detector live)
#      RED flash      = trigger
#      YELLOW solid   = post-trigger capture
#      BLUE flash     = alert sent + ack
#      orange         = reconnecting
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

# config
HOST = "funconnect-v1.funconnect.workers.dev"
PORT = 80
DEVICE_ID = "mbot2-01"
PATH_FIXED = "/device/" + DEVICE_ID
WIFI_SSID = "Redmi 15 5G"
WIFI_PASS = "alpha102938A!"
SOCK_TIMEOUT = 10
ACK_TIMEOUT = 3

# detector
RING_SIZE = 50
INTERVAL_25HZ = 40       # ms
POST_SAMPLES = 25        # 1s aftermath
J_ACCEL = 0.08       # generous — even tilting triggers. Madgwick classifies server-side
J_GYRO  = 10.0       # generous — gentle rotation triggers
COOLDOWN_MS = 3000    # short — let events through, server filters duplicates

# dual-state
DELTA_ACCEL = 0.15       # g — harder to wake (was 0.05, triggered on desk vibrations)
DELTA_GYRO  = 15.0       # deg/s — harder to wake
HEARTBEAT_S = 30         # send telemetry in STILL even if no delta
SETTLE_SAMPLES = 75      # 3s at 25 Hz of calm -> return to STILL
TELEMETRY_ACTIVE_MS = 250   # ms between sends while ACTIVE (4 Hz dashboard, fire-and-forget)
TELEMETRY_STILL_S = 30   # send every 30s while STILL (heartbeat)

device_id = DEVICE_ID
ring = [[0.0] * 6 for _ in range(RING_SIZE)]
rp = 0; filled = False

prev_ax = 0.0; prev_ay = 0.0; prev_az = 1.0
prev_gx = 0.0; prev_gy = 0.0; prev_gz = 0.0
prev_vel_ax = 0.0; prev_vel_ay = 0.0; prev_vel_az = 0.0
prev_vel_gx = 0.0; prev_vel_gy = 0.0; prev_vel_gz = 0.0

triggers = 0; alerts = 0
last_trigger_ms = 0; rp_at_trig = 0
capturing = False; post_buf = []; post_count = 0

sent = 0; acks = 0; missed = 0; reconns = 0
last_telemetry = 0; last_print = 0
last_sent_ax = 0.0; last_sent_ay = 0.0; last_sent_az = 0.0
last_sent_gx = 0.0; last_sent_gy = 0.0; last_sent_gz = 0.0

state = "STILL"          # STILL | ACTIVE
settle_count = 0

show = lambda r, g, b: led.on(r, g, b)
def scr(msg):
    try:
        cyberpi.console.println(str(msg))
    except Exception:
        pass

def blink(r, g, b, n):
    for _ in range(n):
        show(r, g, b); utime.sleep(0.15); show(0, 0, 0); utime.sleep(0.15)

def memfree():
    try:
        return gc.mem_free() if gc else -1
    except Exception:
        return -1

# framing
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
    hdr = bytearray([0x80 | opcode])
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
    opcode = b1 & 0x0F; length = b2 & 0x7F
    if length == 126:
        length = struct.unpack(">H", _recv_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack(">Q", _recv_exact(sock, 8))[0]
    m = _recv_exact(sock, 4) if (b2 & 0x80) else None
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
    wifi.connect(WIFI_SSID, WIFI_PASS)
    t_end = utime.ticks_add(utime.ticks_ms(), 20000)
    while not wifi.is_connected():
        if utime.ticks_diff(t_end, utime.ticks_ms()) < 0:
            raise OSError("wifi timeout")
        utime.sleep(0.5)

def connect():
    ensure_wifi()
    addr = socket.getaddrinfo(HOST, PORT)[0][-1]
    s = socket.socket()
    try:
        s.settimeout(SOCK_TIMEOUT)
    except Exception:
        pass
    s.connect(addr)
    ws_handshake(s, HOST, PATH_FIXED)
    _send_frame(s, 0x1, json.dumps({"type": "hello", "device_id": device_id}).encode())
    recv_frame(s)
    recv_frame(s)
    return s

def read_imu():
    ax = ay = az = gx = gy = gz = 0.0
    try:
        ax = get_acc("x") / 9.81
    except Exception:
        pass
    try:
        ay = get_acc("y") / 9.81
    except Exception:
        pass
    try:
        az = get_acc("z") / 9.81
    except Exception:
        pass
    try:
        gx = get_gyro("x")
    except Exception:
        pass
    try:
        gy = get_gyro("y")
    except Exception:
        pass
    try:
        gz = get_gyro("z")
    except Exception:
        pass
    return (ax, ay, az, gx, gy, gz)

def detect_jerk(ax, ay, az, gx, gy, gz):
    global prev_ax, prev_ay, prev_az, prev_gx, prev_gy, prev_gz
    global prev_vel_ax, prev_vel_ay, prev_vel_az, prev_vel_gx, prev_vel_gy, prev_vel_gz
    v_ax = ax - prev_ax; v_ay = ay - prev_ay; v_az = az - prev_az
    v_gx = gx - prev_gx; v_gy = gy - prev_gy; v_gz = gz - prev_gz
    j_ax = v_ax - prev_vel_ax; j_ay = v_ay - prev_vel_ay; j_az = v_az - prev_vel_az
    j_gx = v_gx - prev_vel_gx; j_gy = v_gy - prev_vel_gy; j_gz = v_gz - prev_vel_gz
    prev_ax = ax; prev_ay = ay; prev_az = az
    prev_gx = gx; prev_gy = gy; prev_gz = gz
    prev_vel_ax = v_ax; prev_vel_ay = v_ay; prev_vel_az = v_az
    prev_vel_gx = v_gx; prev_vel_gy = v_gy; prev_vel_gz = v_gz
    return (j_ax, j_ay, j_az, j_gx, j_gy, j_gz)

def read_telemetry():
    def rd(fn, *a):
        try:
            return fn(*a)
        except Exception:
            return 0
    return {
        "tilt": rd(get_roll), "vibration": rd(get_shakeval) / 100.0,
        "acc_x": rd(get_acc, "x"), "acc_y": rd(get_acc, "y"), "acc_z": rd(get_acc, "z"),
        "gyro_x": rd(get_gyro, "x"), "gyro_y": rd(get_gyro, "y"), "gyro_z": rd(get_gyro, "z"),
    }

# connect transport
scr("S6: dual-state")
show(255, 120, 0)
sock = None
backoff = 2
while sock is None:
    try:
        sock = connect()
        scr("conn " + device_id)
        utime.sleep(0.5)  # connected (LED off — LCD has conn status)
        last_telemetry = utime.ticks_ms()
        last_print = utime.ticks_ms()
        sent += 1  # initial state frame
        break
    except Exception as e:
        reconns += 1
        scr("reconn " + str(reconns) + " in " + str(backoff) + "s " + str(e))
        blink(255, 120, 0, 3)
        utime.sleep(backoff)
        backoff = min(backoff * 2, 30)

# main loop
while True:
    now = utime.ticks_ms()

    # reconnect if socket died
    if sock is None:
        show(255, 120, 0)
        try:
            sock = connect()
            scr("reconnected " + device_id)
            utime.sleep(0.3)  # reconnected
            last_telemetry = now
            backoff = 2
        except Exception as e:
            reconns += 1
            scr("reconn " + str(reconns) + " in " + str(backoff) + "s")
            blink(255, 120, 0, 3)
            utime.sleep(backoff)
            backoff = min(backoff * 2, 30)
            continue

    # 1) read IMU
    ax, ay, az, gx, gy, gz = read_imu()

    if state == "STILL":
        # check delta against last sent snapshot — any axis crosses -> wake
        da = abs(ax - last_sent_ax) > DELTA_ACCEL
        da = da or abs(ay - last_sent_ay) > DELTA_ACCEL
        da = da or abs(az - last_sent_az) > DELTA_ACCEL
        dg = abs(gx - last_sent_gx) > DELTA_GYRO
        dg = dg or abs(gy - last_sent_gy) > DELTA_GYRO
        dg = dg or abs(gz - last_sent_gz) > DELTA_GYRO
        if da or dg:
            state = "ACTIVE"
            filled = False; rp = 0; settle_count = 0
            capturing = False; post_buf = []; post_count = 0
            # reset jerk state for clean start
            prev_ax = ax; prev_ay = ay; prev_az = az
            prev_gx = gx; prev_gy = gy; prev_gz = gz
            prev_vel_ax = 0; prev_vel_ay = 0; prev_vel_az = 0
            prev_vel_gx = 0; prev_vel_gy = 0; prev_vel_gz = 0
            scr("-> ACTIVE")
            # transition to ACTIVE — LED stays off until red
        else:
            # STILL — LED off (transport proven, only events matter)
            # heartbeat: send telemetry every HEARTBEAT_S even if no delta
            if utime.ticks_diff(now, last_telemetry) > TELEMETRY_STILL_S * 1000:
                try:
                    frame = {"type": "state", "device_id": device_id,
                             "esp32_ms": now, "telemetry": read_telemetry(),
                             "health": {"mem": memfree(), "reconns": reconns,
                                        "errs": 0, "rot": 0}}
                    ws_send_text(sock, json.dumps(frame))
                    sent += 1; utime.sleep_ms(50)
                    last_sent_ax = ax; last_sent_ay = ay; last_sent_az = az
                    last_sent_gx = gx; last_sent_gy = gy; last_sent_gz = gz
                    # consume ack
                    try:
                        sock.settimeout(ACK_TIMEOUT)
                        for _ in range(4):
                            op, pl = recv_frame(sock)
                            if op == 0x1:
                                mm = json.loads(pl)
                                if mm.get("type") == "ack" and mm.get("ref") == "state":
                                    acks += 1
                                    break
                    except Exception:
                        missed += 1
                    last_telemetry = now
                except Exception as e:
                    scr("tele fail:" + str(e))
                    try:
                        sock.close()
                    except Exception:
                        pass
                    sock = None
            # idle poll for commands while STILL
            for _ in range(1):  # minimal — will be in the outer sleep
                pass
            # 1 Hz STILL -> sleep after work
            elapsed = utime.ticks_diff(utime.ticks_ms(), now)
            rem = 900 - elapsed  # ~1s cycle
            if rem > 0:
                # responsive idle — poll for commands
                ms_left = rem
                while ms_left > 0:
                    chunk = min(ms_left, 500)
                    utime.sleep_ms(chunk)
                    ms_left -= chunk
                    try:
                        sock.settimeout(0.1)
                        op, pl = recv_frame(sock)
                        if op == 0x1:
                            mm = json.loads(pl)
                            cmd = mm.get("command", "")
                            if cmd == "echo":
                                p = mm.get("params")
                                text = p.get("text") if isinstance(p, dict) else None
                                scr("ECHO: " + str(text))
                                show(255, 255, 0); utime.sleep(0.12); show(0, 0, 0)
                                ws_send_text(sock, json.dumps(
                                    {"type": "echo_ack", "device_id": device_id,
                                     "text": text, "ts": utime.ticks_ms()}))
                            if cmd == "exec":
                                code = mm.get("code", "")
                                ok = True; err = None
                                try:
                                    exec(code)
                                except Exception as e2:
                                    ok = False; err = str(e2)
                                scr("EXEC: " + ("ok" if ok else "ERR"))
                                show(255, 0, 255); utime.sleep(0.12); show(0, 0, 0)
                                ws_send_text(sock, json.dumps(
                                    {"type": "exec_ack", "device_id": device_id,
                                     "status": "ok" if ok else "error",
                                     "error": err, "ts": utime.ticks_ms()}))
                    except Exception:
                        pass
            continue  # back to STILL poll

    # === ACTIVE state: 25 Hz IMU + ring + jerk + alert ===
    # ACTIVE — LED off, only events light up

    # 2) compute jerk
    j_ax, j_ay, j_az, j_gx, j_gy, j_gz = detect_jerk(ax, ay, az, gx, gy, gz)

    # 3) ring buffer
    ring[rp] = [ax, ay, az, gx, gy, gz]
    rp = (rp + 1) % RING_SIZE
    if rp == 0:
        filled = True

    # 4) post-trigger capture
    if capturing:
        post_buf.append([ax, ay, az, gx, gy, gz])
        post_count += 1
        show(255, 255, 0)
        if post_count >= POST_SAMPLES:
            capturing = False
            alerts += 1
            pre = []
            for i in range(RING_SIZE):
                pre.append(ring[(rp_at_trig + i) % RING_SIZE])
            all_s = pre + post_buf
            sig = 0; pk = 0.0; om = 0.0
            for s in all_s:
                d = (s[0]*s[0] + s[1]*s[1] + s[2]*s[2]) ** 0.5
                if d > pk:
                    pk = d
                o = (s[3]*s[3] + s[4]*s[4] + s[5]*s[5]) ** 0.5
                if o > om:
                    om = o
                if abs(s[0]) > 0.4: sig |= 32
                if abs(s[1]) > 0.4: sig |= 16
                if abs(s[2]) > 0.4: sig |= 8
                if abs(s[3]) > 50:  sig |= 4
                if abs(s[4]) > 50:  sig |= 2
                if abs(s[5]) > 50:  sig |= 1
            do_ts = None
            try:
                frame = {"type": "alert", "device_id": device_id,
                         "event": "disturbance",
                         "accel_peak": pk, "omega_peak": om * 3.14159 / 180,
                         "signature": sig, "samples": all_s}
                ws_send_text(sock, json.dumps(frame))
                try:
                    sock.settimeout(3)
                    for _ in range(3):
                        op, pl = recv_frame(sock)
                        if op == 0x1:
                            mm = json.loads(pl)
                            if mm.get("type") == "ack" and mm.get("ref") == "alert":
                                do_ts = mm.get("doTs")
                                break
                except Exception:
                    pass
            except Exception as e:
                scr("alert fail:" + str(e))
                try:
                    sock.close()
                except Exception:
                    pass
                sock = None
            show(0, 0, 255); utime.sleep(0.3); show(0, 0, 0)
            scr("ALERT " + str(alerts) + " samp=75 sig=" + str(sig) +
                " pk=" + str(round(pk, 2)) + " om=" + str(round(om, 1)) +
                (" ack" if do_ts else ""))
            post_buf = []; post_count = 0

    # 5) jerk gate
    in_cooldown = utime.ticks_diff(now, last_trigger_ms) < COOLDOWN_MS
    if not capturing and rp >= 5 and not in_cooldown:  # arm after 200ms (5 samples)
        trig = (abs(j_ax) > J_ACCEL or abs(j_ay) > J_ACCEL or abs(j_az) > J_ACCEL or
                abs(j_gx) > J_GYRO or abs(j_gy) > J_GYRO or abs(j_gz) > J_GYRO)
        if trig:
            triggers += 1
            last_trigger_ms = now
            rp_at_trig = rp
            capturing = True
            post_buf = []; post_count = 0
            show(255, 0, 0); utime.sleep(0.12); show(0, 0, 0)
            scr("TRIG " + str(triggers))

    # 6) settle check: any activity resets. calm -> count toward settle
    da = (abs(ax - last_sent_ax) > DELTA_ACCEL or abs(ay - last_sent_ay) > DELTA_ACCEL or
          abs(az - last_sent_az) > DELTA_ACCEL)
    dg = (abs(gx - last_sent_gx) > DELTA_GYRO or abs(gy - last_sent_gy) > DELTA_GYRO or
          abs(gz - last_sent_gz) > DELTA_GYRO)
    in_cooldown = utime.ticks_diff(now, last_trigger_ms) < COOLDOWN_MS
    if da or dg or in_cooldown or capturing:
        settle_count = 0
    else:
        settle_count += 1

    if settle_count >= SETTLE_SAMPLES:
        state = "STILL"
        scr("-> STILL")
        utime.sleep(0.2)  # settled back to STILL
        last_sent_ax = ax; last_sent_ay = ay; last_sent_az = az
        last_sent_gx = gx; last_sent_gy = gy; last_sent_gz = gz
        last_telemetry = now
        continue

    # 7) telemetry while ACTIVE — fire-and-forget, ~5ms block
    if utime.ticks_diff(now, last_telemetry) > TELEMETRY_ACTIVE_MS:
        try:
            frame = {"type": "state", "device_id": device_id,
                     "esp32_ms": now, "telemetry": read_telemetry(),
                     "health": {"mem": memfree(), "reconns": reconns,
                                "errs": 0, "rot": 0}}
            ws_send_text(sock, json.dumps(frame))
            sent += 1
            last_sent_ax = ax; last_sent_ay = ay; last_sent_az = az
            last_sent_gx = gx; last_sent_gy = gy; last_sent_gz = gz
            # quick ack poll — don't block, catch on next cycle if missed
            try:
                sock.settimeout(0.1)
                for _ in range(2):
                    op, pl = recv_frame(sock)
                    if op == 0x1:
                        mm = json.loads(pl)
                        if mm.get("type") == "ack" and mm.get("ref") == "state":
                            acks += 1; break
            except Exception:
                pass
            last_telemetry = now
        except Exception as e:
            scr("tele fail:" + str(e))
            try:
                sock.close()
            except Exception:
                pass
            sock = None

    # 8) responsive idle between 25 Hz samples — poll for commands
    elapsed = utime.ticks_diff(utime.ticks_ms(), now)
    rem = INTERVAL_25HZ - elapsed
    if rem > 0:
        utime.sleep_ms(rem // 2)
        # quick inbound poll
        try:
            sock.settimeout(0.1)
            op, pl = recv_frame(sock)
            if op == 0x1:
                mm = json.loads(pl)
                cmd = mm.get("command", "")
                if cmd == "echo":
                    p = mm.get("params")
                    text = p.get("text") if isinstance(p, dict) else None
                    scr("ECHO: " + str(text))
                    show(255, 255, 0); utime.sleep(0.12); show(0, 0, 0)
                    ws_send_text(sock, json.dumps(
                        {"type": "echo_ack", "device_id": device_id,
                         "text": text, "ts": utime.ticks_ms()}))
                if cmd == "exec":
                    code = mm.get("code", "")
                    ok = True; err = None
                    try:
                        exec(code)
                    except Exception as e2:
                        ok = False; err = str(e2)
                    scr("EXEC: " + ("ok" if ok else "ERR"))
                    show(255, 0, 255); utime.sleep(0.12); show(0, 0, 0)
                    ws_send_text(sock, json.dumps(
                        {"type": "exec_ack", "device_id": device_id,
                         "status": "ok" if ok else "error",
                         "error": err, "ts": utime.ticks_ms()}))
        except Exception:
            pass
        rem2 = INTERVAL_25HZ - utime.ticks_diff(utime.ticks_ms(), now)
        if rem2 > 0:
            utime.sleep_ms(rem2)

    # periodic status
    if utime.ticks_diff(now, last_print) > 3000:
        last_print = now
        scr(state + " trg " + str(triggers) + " alt " + str(alerts) +
            " st " + str(sent) + " az=" + str(round(az, 2)) + " mem=" + str(memfree()))
