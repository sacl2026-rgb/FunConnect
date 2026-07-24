from microbit import *

tests = [
    "micropython",
    "json",
    "ujson",
    "machine",
    "os",
    "math",
    "gc",
    "utime",
    "ustruct",
    "urandom",
    "radio",
    "music",
    "speech",
    "neopixel",
    "audio",
    "log",
]

for name in tests:
    display.scroll(name, delay=100)
    try:
        __import__(name)
        display.show(Image.YES)
    except Exception:
        display.show(Image.NO)
    sleep(3000)

display.show(Image.HEART)
