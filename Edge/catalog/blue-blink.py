from cyberpi import *
import time

while True:
    led.on(0,0,255,1)
    time.sleep(.5)
    led.off(1)
    time.sleep(.5)
