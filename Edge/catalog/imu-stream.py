# imu-stream.py — FunConnect Catalog
# Streams accelerometer and gyroscope data to the cloud.
# Shake the CyberPi to trigger disturbance alerts.

import time
from cyberpi import *

# ── Config ──
WIFI_SSID = "YOUR_WIFI"
WIFI_PASS = "YOUR_PASSWORD"
DEVICE_ID = "cyberpi"

console.print("IMU Stream starting...")
console.print("Shake the board to see alerts on the dashboard!")

# The cloud DO runs Madgwick AHRS on disturbance events.
# Your job: send 50-sample 6-DOF ring buffers on impact.
# The firmware handles all of this — just flash and shake.

prev_acc = (0, 0, 0)
while True:
    ax = accelerometer.get_x()
    ay = accelerometer.get_y()
    az = accelerometer.get_z()
    gx = gyroscope.get_x()
    gy = gyroscope.get_y()
    gz = gyroscope.get_z()

    # Simple jerk detection: any axis delta > threshold = disturbance
    jerk = abs(ax - prev_acc[0]) + abs(ay - prev_acc[1]) + abs(az - prev_acc[2])
    if jerk > 0.5:
        console.print("Disturbance! Jerk: " + str(jerk))

    prev_acc = (ax, ay, az)
    time.sleep(0.04)  # 25 Hz
