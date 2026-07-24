# relay.py -- FunConnect JSON-over-serial firmware for browser relay
# Transport: CyberPi → USB/Serial → Browser (WebSerial) → WSS → DO
#
# Stripped from ws_client.py — no WiFi, no socket, no WebSocket framing.
# print(json.dumps(frame)) replaces ws_send_text(). Inbound commands read
# from serial stdin via uselect polling, dispatched to same handlers.
#
# LED (event-only):
#   dark           = STILL / ACTIVE (detector live)
#   red flash      = jerk gate trigger
#   yellow solid   = post-trigger capture (1s aftermath)
#   blue flash     = alert assembled, sent
#   cyan flash     = inbound command processed
#
# Protocol — identical to ws_client.py:
#   Outbound (print): hello, state, alert
#   Inbound (serial): echo, exec, fs_test

# ===== CONFIG =====
DEVICE_ID = "cyberpi-relay"
DEVICE_TYPE = "cyberpi"

# Timing
INTERVAL_25HZ = 40        # ms between IMU reads in ACTIVE
RING_SIZE = 50            # pre-trigger samples
POST_SAMPLES = 25         # 1s aftermath at 25 Hz
COOLDOWN_MS = 3000        # between triggers

# Thresholds
J_ACCEL = 0.08            # jerk gate
J_GYRO  = 10.0
DELTA_ACCEL = 0.15        # wake from STILL (g)
DELTA_GYRO  = 15.0        # wake from STILL (deg/s)
SIG_ACCEL = 0.4           # 6-bit signature per-sample threshold (g)
SIG_GYRO  = 50.0          # 6-bit signature per-sample threshold (deg/s)

# Dual-state timing
HEARTBEAT_S = 30           # STILL telemetry interval
SETTLE_SAMPLES = 75        # 3s at 25 Hz of calm -> return to STILL
TELEMETRY_ACTIVE_MS = 250  # ACTIVE dashboard update (4 Hz)

# ===== IMPORTS =====
from cyberpi import *
import cyberpi
import utime
import ujson as json
import sys
try:
    import uselect
except Exception:
    uselect = None
try:
    import gc
except Exception:
    gc = None

# ===== GLOBALS =====
device_id = DEVICE_ID

# Ring buffer + jerk state
ring = [[0.0] * 6 for _ in range(RING_SIZE)]
rp = 0
filled = False

prev_ax = 0.0; prev_ay = 0.0; prev_az = 1.0
prev_gx = 0.0; prev_gy = 0.0; prev_gz = 0.0
prev_vel_ax = 0.0; prev_vel_ay = 0.0; prev_vel_az = 0.0
prev_vel_gx = 0.0; prev_vel_gy = 0.0; prev_vel_gz = 0.0

# Trigger / alert state
triggers = 0; alerts = 0
last_trigger_ms = 0; rp_at_trig = 0
capturing = False; post_buf = []; post_count = 0

# Dual-state
state = "STILL"
settle_count = 0
last_sent_ax = 0.0; last_sent_ay = 0.0; last_sent_az = 0.0
last_sent_gx = 0.0; last_sent_gy = 0.0; last_sent_gz = 0.0

# Counters
sent = 0; last_telemetry = 0; last_print = 0

# ===== HELPERS =====
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

# ===== SERIAL TRANSPORT =====
# print() writes to CyberPiOS USB serial output. The browser reads it via
# WebSerial and relays to the DO over WebSocket.
def send_frame(data):
    """Print a JSON frame to serial. One line per frame — the browser
    splits on newlines for message boundaries."""
    print(json.dumps(data))

# ===== INBOUND COMMAND POLLING =====
# uselect polls sys.stdin for available data without blocking the IMU loop.
# When a line arrives, parse it as JSON and dispatch to the same command
# handlers as ws_client.py. Response is printed (same as outbound frames).
_stdin_poller = None
if uselect:
    try:
        _stdin_poller = uselect.poll()
        _stdin_poller.register(sys.stdin, uselect.POLLIN)
    except Exception:
        _stdin_poller = None

def poll_commands():
    """Non-blocking poll for inbound serial commands. Call during idle time."""
    if _stdin_poller is None:
        return
    try:
        events = _stdin_poller.poll(0)  # 0 = non-blocking
        if not events:
            return
        line = sys.stdin.readline()
        if line:
            msg = json.loads(line.strip())
            dispatch_command(msg)
    except Exception:
        pass

def dispatch_command(mm):
    """Handle one inbound command. Same handlers as ws_client.py."""
    cmd = mm.get("command", "")
    if cmd == "echo":
        p = mm.get("params")
        text = p.get("text") if isinstance(p, dict) else None
        scr("ECHO: " + str(text))
        show(255, 255, 0); utime.sleep(0.12); show(0, 0, 0)
        send_frame({"type": "echo_ack", "device_id": device_id,
                     "text": text, "ts": utime.ticks_ms()})
        return True
    if cmd == "exec":
        code = mm.get("code", "")
        ok = True; err = None
        try:
            exec(code)
        except Exception as e2:
            ok = False; err = str(e2)
        scr("EXEC: " + ("ok" if ok else "ERR:" + str(err)))
        show(255, 0, 255); utime.sleep(0.12); show(0, 0, 0)
        send_frame({"type": "exec_ack", "device_id": device_id,
                     "status": "ok" if ok else "error",
                     "error": err, "ts": utime.ticks_ms()})
        return True
    if cmd == "fs_test":
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
        send_frame({"type": "fs_ack", "device_id": device_id,
                     "write": w, "read": r, "delete": d,
                     "error": ferr, "ts": utime.ticks_ms()})
        return True
    return False

# ===== IMU + TELEMETRY =====
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

# ===== TELEMETRY SEND (no ack — serial is one-way) =====
def send_telemetry(now):
    """Print state frame to serial. No server to ack — fire-and-forget."""
    global sent
    try:
        frame = {"type": "state", "device_id": device_id,
                 "device_type": DEVICE_TYPE,
                 "esp32_ms": now, "telemetry": read_telemetry(),
                 "health": {"mem": memfree(), "reconns": 0,
                            "errs": 0, "rot": 0}}
        send_frame(frame)
        sent += 1
        return True
    except Exception as e:
        scr("tele fail:" + str(e))
        return False

# ===== ALERT ASSEMBLY =====
def send_alert():
    """Assemble 75-sample alert frame, print to serial."""
    global alerts
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
        if abs(s[0]) > SIG_ACCEL: sig |= 32
        if abs(s[1]) > SIG_ACCEL: sig |= 16
        if abs(s[2]) > SIG_ACCEL: sig |= 8
        if abs(s[3]) > SIG_GYRO:  sig |= 4
        if abs(s[4]) > SIG_GYRO:  sig |= 2
        if abs(s[5]) > SIG_GYRO:  sig |= 1
    try:
        frame = {"type": "alert", "device_id": device_id,
                 "event": "disturbance",
                 "accel_peak": pk, "omega_peak": om * 3.14159 / 180,
                 "signature": sig, "samples": all_s}
        send_frame(frame)
        alerts += 1
        show(0, 0, 255); utime.sleep(0.3); show(0, 0, 0)
        scr("ALERT " + str(alerts) + " samp=75 sig=" + str(sig) +
            " pk=" + str(round(pk, 2)) + " om=" + str(round(om, 1)))
        return True
    except Exception as e:
        scr("alert fail:" + str(e))
        return False

# ===== MAIN =====
scr("relay " + device_id)
show(0, 255, 0)  # green — ready, waiting for serial
utime.sleep(0.5)
show(0, 0, 0)

# Send hello frame on startup so the browser/DO knows we're alive.
send_frame({"type": "hello", "device_id": device_id,
            "device_type": DEVICE_TYPE, "ts": utime.ticks_ms()})

last_telemetry = utime.ticks_ms()
last_print = utime.ticks_ms()

# ===== DUAL-STATE LOOP =====
while True:
    now = utime.ticks_ms()

    # --- Read IMU ---
    ax, ay, az, gx, gy, gz = read_imu()

    # ===================================================================
    # STILL STATE: 1 Hz IMU poll, delta check, 30s heartbeat
    # ===================================================================
    if state == "STILL":
        da = (abs(ax - last_sent_ax) > DELTA_ACCEL or
              abs(ay - last_sent_ay) > DELTA_ACCEL or
              abs(az - last_sent_az) > DELTA_ACCEL)
        dg = (abs(gx - last_sent_gx) > DELTA_GYRO or
              abs(gy - last_sent_gy) > DELTA_GYRO or
              abs(gz - last_sent_gz) > DELTA_GYRO)

        if da or dg:
            # Wake to ACTIVE
            state = "ACTIVE"
            filled = False; rp = 0; settle_count = 0
            capturing = False; post_buf = []; post_count = 0
            prev_ax = ax; prev_ay = ay; prev_az = az
            prev_gx = gx; prev_gy = gy; prev_gz = gz
            prev_vel_ax = 0; prev_vel_ay = 0; prev_vel_az = 0
            prev_vel_gx = 0; prev_vel_gy = 0; prev_vel_gz = 0
            scr("-> ACTIVE")
        else:
            # Heartbeat telemetry
            if utime.ticks_diff(now, last_telemetry) > HEARTBEAT_S * 1000:
                send_telemetry(now)
                last_sent_ax = ax; last_sent_ay = ay; last_sent_az = az
                last_sent_gx = gx; last_sent_gy = gy; last_sent_gz = gz
                last_telemetry = now

            # Responsive idle ~1s — poll for serial commands
            elapsed = utime.ticks_diff(utime.ticks_ms(), now)
            rem = 900 - elapsed
            if rem > 0:
                ms_left = rem
                while ms_left > 0:
                    chunk = min(ms_left, 500)
                    utime.sleep_ms(chunk)
                    ms_left -= chunk
                    poll_commands()

            # Periodic status
            if utime.ticks_diff(now, last_print) > 5000:
                last_print = now
                scr("STILL st=" + str(sent) + " mem=" + str(memfree()))

            continue  # back to STILL poll

    # ===================================================================
    # ACTIVE STATE: 25 Hz IMU, ring buffer, jerk gate, alert pipeline
    # ===================================================================

    # Compute jerk
    j_ax, j_ay, j_az, j_gx, j_gy, j_gz = detect_jerk(ax, ay, az, gx, gy, gz)

    # Ring buffer
    ring[rp] = [ax, ay, az, gx, gy, gz]
    rp = (rp + 1) % RING_SIZE
    if rp == 0:
        filled = True

    # Post-trigger capture
    if capturing:
        post_buf.append([ax, ay, az, gx, gy, gz])
        post_count += 1
        show(255, 255, 0)  # yellow — capturing
        if post_count >= POST_SAMPLES:
            capturing = False
            send_alert()
            post_buf = []; post_count = 0

    # Jerk gate (arms after 5 samples = 200ms)
    in_cooldown = utime.ticks_diff(now, last_trigger_ms) < COOLDOWN_MS
    if not capturing and rp >= 5 and not in_cooldown:
        trig = (abs(j_ax) > J_ACCEL or abs(j_ay) > J_ACCEL or abs(j_az) > J_ACCEL or
                abs(j_gx) > J_GYRO or abs(j_gy) > J_GYRO or abs(j_gz) > J_GYRO)
        if trig:
            triggers += 1
            last_trigger_ms = now
            rp_at_trig = rp
            capturing = True
            post_buf = []; post_count = 0
            show(255, 0, 0); utime.sleep(0.12); show(0, 0, 0)  # red flash
            scr("TRIG " + str(triggers))

    # Settle check
    da = (abs(ax - last_sent_ax) > DELTA_ACCEL or
          abs(ay - last_sent_ay) > DELTA_ACCEL or
          abs(az - last_sent_az) > DELTA_ACCEL)
    dg = (abs(gx - last_sent_gx) > DELTA_GYRO or
          abs(gy - last_sent_gy) > DELTA_GYRO or
          abs(gz - last_sent_gz) > DELTA_GYRO)
    in_cooldown = utime.ticks_diff(now, last_trigger_ms) < COOLDOWN_MS
    if da or dg or in_cooldown or capturing:
        settle_count = 0
    else:
        settle_count += 1

    if settle_count >= SETTLE_SAMPLES:
        state = "STILL"
        scr("-> STILL")
        utime.sleep(0.2)
        last_sent_ax = ax; last_sent_ay = ay; last_sent_az = az
        last_sent_gx = gx; last_sent_gy = gy; last_sent_gz = gz
        last_telemetry = now
        continue

    # Telemetry fire-and-forget at 250ms (4 Hz dashboard)
    if utime.ticks_diff(now, last_telemetry) > TELEMETRY_ACTIVE_MS:
        send_telemetry(now)
        last_sent_ax = ax; last_sent_ay = ay; last_sent_az = az
        last_sent_gx = gx; last_sent_gy = gy; last_sent_gz = gz
        last_telemetry = now

    # Heap hygiene
    if gc and (sent % 20 == 0):
        try:
            gc.collect()
        except Exception:
            pass

    # Responsive idle between 25 Hz samples — poll for serial commands
    elapsed = utime.ticks_diff(utime.ticks_ms(), now)
    rem = INTERVAL_25HZ - elapsed
    if rem > 0:
        utime.sleep_ms(rem // 2)
        poll_commands()
        rem2 = INTERVAL_25HZ - utime.ticks_diff(utime.ticks_ms(), now)
        if rem2 > 0:
            utime.sleep_ms(rem2)

    # Periodic status
    if utime.ticks_diff(now, last_print) > 3000:
        last_print = now
        scr(state + " trg=" + str(triggers) + " alt=" + str(alerts) +
            " st=" + str(sent) + " az=" + str(round(az, 2)) +
            " mem=" + str(memfree()))
