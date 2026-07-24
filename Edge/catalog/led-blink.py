# led-blink.py — FunConnect Catalog
# Blinks the CyberPi LEDs and reports state to the cloud dashboard.

import time
from cyberpi import *

# ── Config ──
WIFI_SSID = "YOUR_WIFI"
WIFI_PASS = "YOUR_PASSWORD"
DEVICE_ID = "cyberpi"

console.print("LED Blink starting...")
console.print("Connect to WiFi: " + WIFI_SSID)

# LEDs will cycle through colors while connected
led_colors = [(255,0,0), (0,255,0), (0,0,255), (255,255,0), (255,0,255)]
for i in range(5):
    r, g, b = led_colors[i % 5]
    led.on(r, g, b)
    time.sleep(1)
    led.off()
    time.sleep(0.5)
