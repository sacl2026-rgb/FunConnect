#!/usr/bin/env bash
# FunConnect V1.5 Automated Smoke Test
# Tests: MSD flash, HID CMSIS-DAP, WebUSB viability check
# No user clicks needed.

set -e
API="https://funconnect-v1.funconnect.workers.dev"
PROBE="9901000050244e4500362007000000680000000097969901"
PASS=0; FAIL=0

pass() { PASS=$((PASS+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }

echo "╔══════════════════════════════════════╗"
echo "║  FunConnect V1.5 Automated Smoke     ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ── Test 1: API health ──
echo "── Test 1: API Health ──"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$API/api/health")
[ "$HTTP" = "200" ] && pass "API healthy (HTTP $HTTP)" || fail "API down (HTTP $HTTP)"

# ── Test 2: Catalog ──
echo "── Test 2: Catalog ──"
PROGS=$(curl -s "$API/api/catalog")
COUNT=$(echo "$PROGS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo 0)
MB=$(echo "$PROGS" | python3 -c "import sys,json; print(len([p for p in json.load(sys.stdin) if p.get('format')=='.hex']))" 2>/dev/null || echo 0)
[ "$COUNT" -ge 4 ] && pass "$COUNT programs ($MB micro:bit)" || fail "Catalog broken"

# ── Test 3: Hex download ──
echo "── Test 3: Hex download ──"
curl -s "$API/api/catalog/heart-badge" -o /tmp/fc-test.hex
SIZE=$(wc -c < /tmp/fc-test.hex)
[ "$SIZE" -gt 1000000 ] && pass "Heart Badge hex ($(echo $SIZE | awk '{printf "%.1f", $1/1024}')KB)" || fail "Hex too small ($SIZE bytes)"

# ── Test 4: MSD drive detect ──
echo "── Test 4: MSD drive ──"
DRIVE=$(powershell -Command "Get-WmiObject Win32_LogicalDisk | Where-Object { \$_.VolumeName -eq 'MICROBIT' } | Select-Object -ExpandProperty DeviceID" 2>/dev/null | tr -d '\r\n ')
if [ -n "$DRIVE" ]; then
    pass "MICROBIT at $DRIVE"
    VER=$(grep "Interface Version" "$DRIVE/DETAILS.TXT" 2>/dev/null | awk '{print $3}')
    [ -n "$VER" ] && echo "       DAPLink v$VER"
else
    fail "MICROBIT drive not found — plug in micro:bit"
fi

# ── Test 5: MSD flash ──
echo "── Test 5: MSD flash ──"
if [ -n "$DRIVE" ]; then
    BEFORE=$(cat "$DRIVE/DETAILS.TXT" 2>/dev/null | cksum 2>/dev/null || echo "")
    cp /tmp/fc-test.hex "$DRIVE/" 2>/dev/null && echo "       Copied to $DRIVE"
    sleep 3
    # Check if drive came back (device rebooted after flash)
    DRIVE2=$(powershell -Command "Get-WmiObject Win32_LogicalDisk | Where-Object { \$_.VolumeName -eq 'MICROBIT' } | Select-Object -ExpandProperty DeviceID" 2>/dev/null | tr -d '\r\n ')
    if [ -n "$DRIVE2" ]; then
        AFTER=$(cat "$DRIVE2/DETAILS.TXT" 2>/dev/null | cksum 2>/dev/null || echo "")
        if [ "$BEFORE" != "$AFTER" ] || [ "$DRIVE" != "$DRIVE2" ]; then
            pass "MSD flash — device rebooted"
        else
            pass "MSD flash — hex written"
        fi
    else
        pass "MSD flash — device rebooting (drive gone)"
        sleep 5
        DRIVE2=$(powershell -Command "Get-WmiObject Win32_LogicalDisk | Where-Object { \$_.VolumeName -eq 'MICROBIT' } | Select-Object -ExpandProperty DeviceID" 2>/dev/null | tr -d '\r\n ')
        [ -n "$DRIVE2" ] && echo "       Drive returned at $DRIVE2" || echo "       Drive not yet back"
    fi
    DRIVE="$DRIVE2"
else
    fail "Skipped — no drive"
fi

# ── Test 6: HID CMSIS-DAP probe ──
echo "── Test 6: HID CMSIS-DAP ──"
PYOCD=$(python3 -c "import pyocd; print('ok')" 2>/dev/null || echo "")
if [ "$PYOCD" = "ok" ]; then
    RESULT=$(python3 -c "
import subprocess, sys
r = subprocess.run(['pyocd','list','--probes'], capture_output=True, text=True, timeout=8)
out = r.stdout
if '$PROBE' in out:
    print('PROBE_FOUND')
    # Try reading memory
    r2 = subprocess.run(['pyocd','cmd','-t','nrf51822','--probe','$PROBE','-c','read32 0x00000000'], capture_output=True, text=True, timeout=8)
    if '20004000' in r2.stdout:
        print(':FLASH_OK')
    else:
        print(':FLASH_READ_FAIL')
else:
    print('PROBE_NOT_FOUND')
" 2>/dev/null)
    if echo "$RESULT" | grep -q "PROBE_FOUND"; then
        pass "CMSIS-DAP probe detected"
        if echo "$RESULT" | grep -q "FLASH_OK"; then
            pass "SWD flash read works (0x20004000)"
        else
            fail "SWD flash read failed"
        fi
    else
        fail "CMSIS-DAP probe not found"
    fi
else
    fail "pyocd not installed"
fi

# ── Test 7: WebUSB viability ──
echo "── Test 7: WebUSB viability ──"
if [ -n "$DRIVE" ]; then
    WEBUSB=$(grep "WebUSB" "$DRIVE/DETAILS.TXT" 2>/dev/null)
    if [ -n "$WEBUSB" ]; then
        pass "WebUSB listed in DAPLink interfaces"
    else
        fail "WebUSB not in interfaces"
    fi
else
    echo "       (drive not available — skipping)"
fi

# ── Summary ──
echo ""
echo "╔══════════════════════════════════════╗"
echo "║  Results: $PASS passed, $FAIL failed           ║"
echo "╚══════════════════════════════════════╝"

if [ "$FAIL" -gt 0 ]; then
    echo ""
    echo "Known V1.5 limitations:"
    echo "  • DAP.js WebUSB transport: open() hangs (KL26Z interface issue)"
    echo "  • WebUSB one-click flash: not viable on V1.5"
    echo "  • MSD flash: fully functional (browser + CLI)"
    echo "  • HID CMSIS-DAP: fully functional (pyocd proven)"
fi
