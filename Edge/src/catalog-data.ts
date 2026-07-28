/**
 * FunConnect Program Catalog
 *
 * Static catalog of .py programs for CyberPi.
 * Each entry has id, name, description, tags, and the file content.
 * Served via GET /api/catalog and GET /api/catalog/:id.
 */

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  tags: string[];
  version: string;
  content: string;
  /** Output format. ".py" = Python source (default). ".hex" = compile via py2hex at request time. */
  format?: ".py" | ".hex";
}

export const CATALOG: CatalogEntry[] = [
  {
    id: "hello-world",
    name: "Hello World",
    description: "Connect your CyberPi to WiFi and say hello to the cloud. The simplest way to verify your device is online.",
    tags: ["cyberpi", "beginner", "wifi", "display"],
    version: "1.0.0",
    content: `# hello-world.py — FunConnect Catalog
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
`,
  },
  {
    id: "led-blink",
    name: "LED Blink",
    description: "Cycle the CyberPi LEDs through colors while reporting state to your cloud dashboard.",
    tags: ["cyberpi", "beginner", "led", "dashboard"],
    version: "1.0.0",
    content: `# led-blink.py — FunConnect Catalog
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
`,
  },
  {
    id: "imu-stream",
    name: "IMU Stream",
    description: "Stream accelerometer and gyroscope data to the cloud. Shake the board to trigger disturbance alerts on your dashboard.",
    tags: ["cyberpi", "intermediate", "imu", "alerts", "sensors"],
    version: "1.0.0",
    content: `# imu-stream.py — FunConnect Catalog
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
`,
  },
  // ── micro:bit programs (compiled to .hex at request time) ─────────────
  {
    id: "heart-badge",
    name: "Heart Badge",
    description: "A beating heart on the LED matrix. The simplest possible program.",
    tags: ["microbit", "beginner", "led"],
    version: "1.0.0",
    format: ".hex",
    content: `from microbit import *
while True:
    display.show(Image.HEART)
    sleep(500)
    display.show(Image.HEART_SMALL)
    sleep(500)
`,
  },
  {
    id: "name-tag",
    name: "Name Tag",
    description: "Scrolls a message across the display. Customize the text.",
    tags: ["microbit", "beginner", "display"],
    version: "1.0.0",
    format: ".hex",
    content: `from microbit import *
display.scroll("Hello!")
display.show(Image.HEART)
`,
  },
  {
    id: "emotion-badge",
    name: "Emotion Badge",
    description: "Press A for happy, B for sad. Your first input program.",
    tags: ["microbit", "beginner", "buttons"],
    version: "1.0.0",
    format: ".hex",
    content: `from microbit import *
while True:
    if button_a.is_pressed():
        display.show(Image.HAPPY)
    elif button_b.is_pressed():
        display.show(Image.SAD)
    else:
        display.show(Image.HEART)
    sleep(100)
`,
  },
  {
    id: "dice",
    name: "Dice",
    description: "Shake to roll. Shows 1–6 and holds the result.",
    tags: ["microbit", "beginner", "sensors"],
    version: "1.0.0",
    format: ".hex",
    content: `from microbit import *
while True:
    if accelerometer.was_gesture("shake"):
        n = (running_time() % 6) + 1
        display.show(str(n))
        sleep(500)
    sleep(80)
`,
  },
  // === Direct Flash Compatible (under 207 bytes) ===
  {
    id: "red-blink",
    name: "Red Blink",
    description: "Blinks the CyberPi LED red. Ultra-simple � no WiFi needed.",
    tags: ["cyberpi", "beginner", "led", "direct-flash"],
    version: "1.0.0",
    format: ".py",
    content: `from cyberpi import *
import time
while True:
    led.on(255,0,0,1)
    time.sleep(0.5)
    led.off(1)
    time.sleep(0.5)
`,
  },
  {
    id: "green-blink",
    name: "Green Blink",
    description: "Blinks the CyberPi LED green. Ultra-simple � no WiFi needed.",
    tags: ["cyberpi", "beginner", "led", "direct-flash"],
    version: "1.0.0",
    format: ".py",
    content: `from cyberpi import *
import time
while True:
    led.on(0,255,0,1)
    time.sleep(0.5)
    led.off(1)
    time.sleep(0.5)
`,
  },
  {
    id: "blue-blink",
    name: "Blue Blink",
    description: "Blinks the CyberPi LED blue. Ultra-simple � no WiFi needed.",
    tags: ["cyberpi", "beginner", "led", "direct-flash"],
    version: "1.0.0",
    format: ".py",
    content: `from cyberpi import *
import time
while True:
    led.on(0,0,255,1)
    time.sleep(0.5)
    led.off(1)
    time.sleep(0.5)
`,
  },
];

