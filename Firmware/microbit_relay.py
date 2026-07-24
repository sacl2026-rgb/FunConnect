from microbit import *

DEVICE_ID = "microbit-01"
DEVICE_TYPE = "microbit"

PATTERNS = {
    "heart": Image("09090:99999:99999:09990:00900"),
    "smile": Image("00000:09090:00000:90009:09990"),
    "sad":   Image("00000:09090:00000:09990:90009"),
    "star":  Image("00900:00900:99999:00900:00900"),
    "clear": Image("00000:00000:00000:00000:00000"),
}

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

try:
    import micropython
    micropython.kbd_intr(-1)
except Exception:
    pass

uart.init(baudrate=115200)
display.show(Image.YES)
sleep(2000)

hello_frame = dumps({
    "type": "hello",
    "device_id": DEVICE_ID,
    "device_type": DEVICE_TYPE,
    "ts": running_time(),
}) + "\n"
uart.write(hello_frame)
display.show(Image.HEART)
sleep(500)
display.clear()

buf = ""
while True:
    if uart.any():
        ch = uart.read(1)
        if ch:
            c = chr(ch[0])
            if c == "\n":
                try:
                    cmd = loads(buf)
                    if cmd and cmd.get("command") == "led_matrix":
                        pattern = cmd.get("pattern", "")
                        if pattern in PATTERNS:
                            display.show(PATTERNS[pattern])
                            uart.write(dumps({
                                "type": "led_ack",
                                "device_id": DEVICE_ID,
                                "pattern": pattern,
                                "ts": running_time(),
                            }) + "\n")
                        else:
                            uart.write(dumps({
                                "type": "led_ack",
                                "device_id": DEVICE_ID,
                                "error": "unknown pattern: " + str(pattern),
                                "ts": running_time(),
                            }) + "\n")
                    elif cmd and cmd.get("command") == "echo":
                        params = cmd.get("params", {})
                        text = params.get("text", "") if isinstance(params, dict) else ""
                        uart.write(dumps({
                            "type": "echo_ack",
                            "device_id": DEVICE_ID,
                            "text": text,
                            "ts": running_time(),
                        }) + "\n")
                except Exception:
                    display.show(Image.NO)
                    sleep(300)
                    display.clear()
                buf = ""
            else:
                buf += c
            continue
    sleep(5)
