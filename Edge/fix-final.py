path = r'C:\Projects\FunConnect\Beauty\src\app.jsx'
with open(path, 'r', encoding='utf-8') as f:
    c = f.read()

changes = 0

# ── Fix 1: Split deviceType from selType ──────────────────────────────
old_seltype = '''  // deviceType flows from AdminShell as the single source of truth.
  // If set by ConnectWizard (non-default), it is authoritative.
  // If still default "cyberpi" and the selected group has deviceType from
  // the API, prefer the API value. Otherwise trust the prop.
  const selType = (deviceType !== "cyberpi")
    ? deviceType
    : (selGroup?.deviceType || deviceType);'''

new_seltype = '''  // selType comes from the selected device's actual type reported by the
  // API. deviceType from ConnectWizard/AdminDeploy is only a fallback when
  // no device is selected. The dashboard panel must reflect the device
  // the user clicked, not whatever was last connected in the wizard.
  const selType = selGroup?.deviceType || deviceType;'''

if old_seltype in c:
    c = c.replace(old_seltype, new_seltype)
    changes += 1
    print('Fix 1: selType now reads from selected device, not ConnectWizard')
else:
    print('Fix 1 ERROR: selType code not found')

# ── Fix 2: Two distinct offline states ─────────────────────────────────
old_offline = '''        <div className="card" style={{
          textAlign: "center", padding: 32,
          background: "var(--panel-2)", border: "1.5px dashed var(--line)",
        }}>
          <div style={{ fontSize: 40, marginBottom: 12, opacity: .5 }}>\u23f3</div>
          <h3 style={{ marginBottom: 8 }}>Waiting for {profile.name}\u2026</h3>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            {effectiveType === "microbit"
              ? "Your program is running on the micro:bit. Live telemetry requires a V2 micro:bit with USB relay."
              : "Power on your CyberPi and ensure it's connected to WiFi."}
          </p>
          <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
            The dashboard will update automatically when the device comes online.
          </p>
        </div>'''

new_offline = '''        {effectiveType === "microbit" ? (
          <div className="card" style={{
            textAlign: "center", padding: 32,
            background: "var(--panel-2)", border: "1.5px solid var(--line)",
          }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>\u2713</div>
            <h3 style={{ marginBottom: 8 }}>Program Running</h3>
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>
              Your program is on the micro:bit. Look at the LEDs.
            </p>
            <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
              Live dashboard requires a V2 micro:bit with USB relay.
            </p>
          </div>
        ) : (
          <div className="card" style={{
            textAlign: "center", padding: 32,
            background: "var(--panel-2)", border: "1.5px dashed var(--line)",
          }}>
            <div style={{ fontSize: 40, marginBottom: 12, opacity: .5 }}>\u23f3</div>
            <h3 style={{ marginBottom: 8 }}>Waiting for {profile.name}\u2026</h3>
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>
              Power on your CyberPi and ensure it's connected to WiFi.
            </p>
            <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
              The dashboard will update automatically when the device comes online.
            </p>
          </div>
        )}'''

if old_offline in c:
    c = c.replace(old_offline, new_offline)
    changes += 1
    print('Fix 2: Two distinct offline cards — micro:bit vs CyberPi')
else:
    print('Fix 2 ERROR: offline overlay not found')

# ── Fix 3: Guard CyberPi serial relay ──────────────────────────────────
# 3a: Remove serial transport from CyberPi profile
old_cyberpi_transports = '''    transports: [
      { id: "serial", label: "USB (WebSerial)", description: "Direct USB connection \u2014 no WiFi setup, no mBlock. Requires relay.py flashed to the board.", deviceId: "cyberpi" },
      { id: "wifi", label: "WiFi (mBlock)", description: "Flash via mBlock \u2014 requires WiFi + mLink2. Works with any CyberPi program.", deviceId: "cyberpi" },
    ],'''

new_cyberpi_transports = '''    transports: [
      { id: "wifi", label: "WiFi (mBlock)", description: "Flash via mBlock \u2014 requires WiFi + mLink2. Works with any CyberPi program.", deviceId: "cyberpi" },
    ],'''

if old_cyberpi_transports in c:
    c = c.replace(old_cyberpi_transports, new_cyberpi_transports)
    changes += 1
    print('Fix 3: CyberPi serial transport removed from profile')
else:
    print('Fix 3 ERROR: CyberPi transports not found')

with open(path, 'w', encoding='utf-8') as f:
    f.write(c)
print(f'Total: {changes} changes')
