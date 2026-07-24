// micro:bit V1 (0x0D28:0x0204) — KL26Z DAPLink with transmit-only CDC.
// Serial relay connects but telemetry never arrives. MSD flash is the reliable path.
const MICROBIT_V1_PID = 0x0204;
const MICROBIT_V2_PID = 0x0209;

// Check if the serial port belongs to a micro:bit V1 (KL26Z).
function isMicrobitV1(portInfo) {
  return portInfo.usbVendorId === 0x0D28 && portInfo.usbProductId === MICROBIT_V1_PID;
}
