from microbit import *

DEVICE_ID = "microbit-01"

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
display.show(Image.YES)
sleep(2000)

prev_acc = (0, 0, 0)
prev_temp = 0
prev_a = False
prev_b = False

while True:
    x, y, z = accelerometer.get_values()
    temp = temperature()
    btn_a = button_a.is_pressed()
    btn_b = button_b.is_pressed()

    changed = ((x, y, z) != prev_acc or temp != prev_temp or
               btn_a != prev_a or btn_b != prev_b)

    if changed:
        uart.write(dumps({
            "type": "state",
            "device_id": DEVICE_ID,
            "telemetry": {
                "acc_x": x,
                "acc_y": y,
                "acc_z": z,
                "temp": temp,
            },
            "buttons": {
                "a": btn_a,
                "b": btn_b,
            },
            "ts": running_time(),
        }) + "\n")
        prev_acc = (x, y, z)
        prev_temp = temp
        prev_a = btn_a
        prev_b = btn_b

    sleep(200)
