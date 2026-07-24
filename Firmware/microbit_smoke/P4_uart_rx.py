from microbit import *

uart.init(baudrate=115200)
display.show(Image.YES)

buf = ""
while True:
    if uart.any():
        ch = uart.read(1)
        if ch:
            c = chr(ch[0])
            if c == "\n":
                display.show(Image.HEART)
                uart.write("ECHO: " + buf + "\n")
                sleep(300)
                display.show(Image.YES)
                buf = ""
            else:
                buf += c
    sleep(20)
