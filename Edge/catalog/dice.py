from microbit import *
while True:
    if accelerometer.was_gesture("shake"):
        n = (running_time() % 6) + 1
        display.show(str(n))
        sleep(500)
    sleep(80)
