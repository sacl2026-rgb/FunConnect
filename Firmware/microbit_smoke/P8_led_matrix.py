# P8: Prove led_matrix command dispatch.
# Flash this. Open a serial terminal (115200 baud).
# 1. LED shows checkmark (ready).
# 2. Type {"command":"led_matrix","pattern":"heart"} + Enter -> LED shows heart.
# 3. Type {"command":"led_matrix","pattern":"smile"} + Enter -> LED shows smile.
# 4. Type {"command":"led_matrix","pattern":"clear"} + Enter -> LED goes dark.
# 5. Each command gets a led_ack response on serial.
# Proves: led_matrix command, pattern lookup, display.show(), led_ack response.
from microbit import *

PATTERNS = {
    "heart": Image(5, 5, bytearray([
        0,9,0,9,0, 9,9,9,9,9, 9,9,9,9,9, 0,9,9,9,0, 0,0,9,0,0,
    ])),
    "smile": Image(5, 5, bytearray([
        0,0,0,0,0, 0,9,0,9,0, 0,0,0,0,0, 9,0,0,0,9, 0,9,9,9,0,
    ])),
    "sad": Image(5, 5, bytearray([
        0,0,0,0,0, 0,9,0,9,0, 0,0,0,0,0, 0,9,9,9,0, 9,0,0,0,9,
    ])),
    "star": Image(5, 5, bytearray([
        0,0,9,0,0, 0,0,9,0,0, 9,9,9,9,9, 0,0,9,0,0, 0,0,9,0,0,
    ])),
    "check": Image(5, 5, bytearray([
        0,0,0,0,9, 0,0,0,9,0, 9,0,0,9,0, 0,9,9,0,0, 0,0,0,0,0,
    ])),
    "clear": Image(5, 5, bytearray([0] * 25)),
    "yes": Image.YES,
    "no": Image.NO,
}

try:
    import micropython
    micropython.kbd_intr(-1)
except Exception:
    pass

def dumps(obj):
    if isinstance(obj, dict):
        items = []
        for k in sorted(obj.keys()):
            items.append(dumps(k) + ":" + dumps(obj[k]))
        return "{" + ",".join(items) + "}"
    if isinstance(obj, str):
        s = obj.replace("\\", "\\\\").replace('"', '\\"')
        return '"' + s + '"'
    if isinstance(obj, bool):
        return "true" if obj else "false"
    if obj is None:
        return "null"
    if isinstance(obj, (int, float)):
        return str(obj)
    return "null"

def loads(text):
    text = text.strip()
    if not text.startswith("{"):
        return None
    text = text.replace("true", "True").replace("false", "False").replace("null", "None")
    return eval(text)

uart.init(baudrate=115200)
display.show(PATTERNS["check"], wait=False)

while True:
    if uart.any():
        line = uart.readline()
        if line:
            try:
                cmd = loads(line.decode("utf-8"))
                if cmd and cmd.get("command") == "led_matrix":
                    pattern = cmd.get("pattern", "")
                    if pattern in PATTERNS:
                        display.show(PATTERNS[pattern], wait=False)
                        uart.write(dumps({
                            "type": "led_ack",
                            "pattern": pattern,
                            "ts": running_time(),
                        }) + "\n")
                    else:
                        uart.write(dumps({
                            "type": "led_ack",
                            "error": "unknown: " + str(pattern),
                            "ts": running_time(),
                        }) + "\n")
            except Exception:
                pass
    sleep(30)
