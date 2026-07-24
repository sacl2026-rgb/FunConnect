# CyberPi auto-watcher: detects CH340, captures serial, auto-saves
import serial
import serial.tools.list_ports
import datetime
import time
import sys

OUTFILE = "C:/Users/sacl2/AppData/Roaming/reasonix/global-workspace/cyberpi_capture.txt"

def find_cyberpi():
    for p in serial.tools.list_ports.comports():
        if p.vid == 0x1A86:
            return p.device, p.description
    return None, None

print("CyberPi auto-watcher — waiting for CH340 (VID 0x1A86)...")
print("Plug in CyberPi. Ctrl+C to stop.\n")

last_port = None

try:
    while True:
        port, desc = find_cyberpi()
        if port and port != last_port:
            last_port = port
            print(f"\n[{datetime.datetime.now().strftime('%H:%M:%S')}] DETECTED: {port} ({desc})")
            print(f"Capturing at 115200 baud... Upload via mBlock now.\n")

            with open(OUTFILE, "a") as f:
                f.write(f"\n# Session: {datetime.datetime.now()}\n")
                f.write(f"# Port: {port} ({desc})\n\n")

                ser = serial.Serial(port, 115200, timeout=0.1)
                while True:
                    try:
                        data = ser.read(1024)
                        if data:
                            ts = datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3]
                            hex_str = data.hex(' ')
                            ascii_str = ''.join(chr(b) if 32 <= b < 127 else '.' for b in data)
                            line = f"[{ts}] {hex_str}  |{ascii_str}|"
                            print(line)
                            f.write(line + "\n")
                            f.flush()
                        # Check if device still connected
                        still_there = any(p.vid == 0x1A86 for p in serial.tools.list_ports.comports())
                        if not still_there:
                            print(f"\nDevice disconnected. Waiting...\n")
                            ser.close()
                            last_port = None
                            break
                    except (serial.SerialException, OSError) as e:
                        print(f"\nSerial error: {e}. Waiting for reconnect...\n")
                        try: ser.close()
                        except: pass
                        last_port = None
                        break
        elif not port:
            last_port = None
        time.sleep(1)
except KeyboardInterrupt:
    print("\nStopped. Capture saved to", OUTFILE)
