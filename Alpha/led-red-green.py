# led-test.py — Simple LED blink, no WiFi needed
from cyberpi import *
import time

while True:
    led.on(255, 0, 0, 1)  # red
    time.sleep(1)
    led.on(0, 255, 0, 1)  # green
    time.sleep(1)
