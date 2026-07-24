# hello-world.py — FunConnect Catalog
# Flash this to your CyberPi via mBlock to say hello to the cloud.
# After upload, the device connects and appears on your dashboard.

import socket
import ussl
import ustruct
import ujson
import time
import network
from cyberpi import *

# ── Config ──
WIFI_SSID = "YOUR_WIFI"
WIFI_PASS = "YOUR_PASSWORD"
DEVICE_ID = "cyberpi"
WSS_URL = "ws://funconnect-v1.funconnect.workers.dev/device/" + DEVICE_ID

# ── Connect WiFi ──
wlan = network.WLAN(network.STA_IF)
wlan.active(True)
wlan.connect(WIFI_SSID, WIFI_PASS)
while not wlan.isconnected():
    time.sleep(0.5)

display.show_label("WiFi OK", 16, 10, 10)

# ── WebSocket Handshake ──
# (simplified — real firmware uses a WSS client library)
console.print("Connected! Visit funconnect-v1.funconnect.workers.dev")
