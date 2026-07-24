# P7: Prove shake detection + alert frame.
# Flash this. Open a serial terminal (115200 baud).
# 1. LED dark (idle).
# 2. Shake the micro:bit vigorously.
# 3. Serial shows: {"type":"alert","device_id":"microbit-01","event":"shake","accel_peak":...,"ts":...}
# 4. LED flashes heart briefly on each alert.
# Proves: accelerometer.was_gesture("shake"), get_strength(), alert frame shape.
from microbit import *

DEVICE_ID = "microbit-01"

HEART = Image(5, 5, bytearray([
    0,9,0,9,0,
    9,9,9,9,9,
    9,9,9,9,9,
    0,9,9,9,0,
    0,0,9,0,0,
]))

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

uart.init(baudrate=115200)
display.clear()

while True:
    if accelerometer.was_gesture("shake"):
        display.show(HEART, wait=False)
        uart.write(dumps({
            "type": "alert",
            "device_id": DEVICE_ID,
            "event": "shake",
            "accel_peak": accelerometer.get_strength(),
            "ts": running_time(),
        }) + "\n")
        sleep(300)
        display.clear()

    sleep(80)
