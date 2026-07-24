from microbit import *
display.show(Image.YES)
uart.init(baudrate=115200)
while True:
    uart.write("P3_OK\n")
    sleep(1000)
