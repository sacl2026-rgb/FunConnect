from microbit import *

DEVICE_ID = "microbit-01"
DEVICE_TYPE = "microbit"

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
display.show(Image.YES)

hello_frame = dumps({
    "type": "hello",
    "device_id": DEVICE_ID,
    "device_type": DEVICE_TYPE,
    "ts": running_time(),
}) + "\n"

for _ in range(3):
    uart.write(hello_frame)
    sleep(1000)

buf = ""
while True:
    if uart.any():
        ch = uart.read(1)
        if ch:
            c = chr(ch[0])
            if c == "\n":
                try:
                    cmd = loads(buf)
                    if cmd and cmd.get("command") == "echo":
                        display.show(Image.HEART)
                        params = cmd.get("params", {})
                        text = params.get("text", "") if isinstance(params, dict) else ""
                        uart.write(dumps({
                            "type": "echo_ack",
                            "device_id": DEVICE_ID,
                            "text": text,
                            "ts": running_time(),
                        }) + "\n")
                        sleep(200)
                        display.show(Image.YES)
                except Exception:
                    display.show(Image.NO)
                    sleep(300)
                    display.show(Image.YES)
                buf = ""
            else:
                buf += c
    sleep(20)
