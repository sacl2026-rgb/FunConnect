import sys

path = r'C:\Projects\FunConnect\Beauty\src\app.jsx'
with open(path, 'r', encoding='utf-8') as f:
    c = f.read()

changes = 0

# A6: Fix serial no-response/timeout for CyberPi
old_noresp = '''            <button className="btn" onClick={() => saveHexToMicrobit()}>
              ↓ Download Firmware
            </button>
          </div>
        )}

        {serialState === "timeout" && (
          <div>
            <div style={{ fontSize: 48, marginBottom: 8, color: "var(--bad)" }}>✕</div>
            <div className="pulsebar" style={{ borderColor: "rgba(255,107,107,.35)", background: "rgba(255,107,107,.07)" }}>
              <span className="pulsedot" style={{ background: "var(--bad)", boxShadow: "0 0 12px var(--bad)" }} />
              Device not responding.
            </div>
            <p className="muted" style={{ fontSize: 14, marginBottom: 16 }}>
              No response from {deviceId} after 30 seconds.
            </p>
            <div className="row" style={{ gap: 10, justifyContent: "center" }}>
              <button className="btn" onClick={() => saveHexToMicrobit()}>↓ Download Firmware</button>
              <button className="btn ghost" onClick={tryAgain}>Try Again</button>
            </div>'''

new_noresp = '''            {isMicrobit ? (
              <button className="btn" onClick={() => saveHexToMicrobit()}>
                ↓ Download Firmware
              </button>
            ) : (
              <button className="btn" onClick={() => {
                setSerialErr(null); setTransportState("wifi");
                const tCfg = profile?.transports?.find(x => x.id === "wifi");
                if (tCfg?.deviceId) setDeviceIdState(tCfg.deviceId);
                setSub(10);
              }}>Switch to WiFi →</button>
            )}
          </div>
        )}

        {serialState === "timeout" && (
          <div>
            <div style={{ fontSize: 48, marginBottom: 8, color: "var(--bad)" }}>✕</div>
            <div className="pulsebar" style={{ borderColor: "rgba(255,107,107,.35)", background: "rgba(255,107,107,.07)" }}>
              <span className="pulsedot" style={{ background: "var(--bad)", boxShadow: "0 0 12px var(--bad)" }} />
              Device not responding.
            </div>
            <p className="muted" style={{ fontSize: 14, marginBottom: 16 }}>
              No response from {deviceId} after 30 seconds.
            </p>
            <div className="row" style={{ gap: 10, justifyContent: "center" }}>
              {isMicrobit ? (
                <>
                  <button className="btn" onClick={() => saveHexToMicrobit()}>↓ Download Firmware</button>
                  <button className="btn ghost" onClick={tryAgain}>Try Again</button>
                </>
              ) : (
                <>
                  <button className="btn" onClick={() => {
                    setSerialErr(null); setTransportState("wifi");
                    const tCfg = profile?.transports?.find(x => x.id === "wifi");
                    if (tCfg?.deviceId) setDeviceIdState(tCfg.deviceId);
                    setSub(10);
                  }}>Switch to WiFi →</button>
                  <button className="btn ghost" onClick={tryAgain}>Try Again</button>
                </>
              )}
            </div>'''

if old_noresp in c:
    c = c.replace(old_noresp, new_noresp)
    changes += 1
    print('A6: Serial error screens fixed')
else:
    print('A6 ERROR: pattern not found')

# A7: Note about Deploy tab
old_wifi = '''  // --- Steps 10-12: WiFi / mBlock path (CyberPi) ---
  if (profile && profile.id === "cyberpi" && (sub >= 10 && sub <= 12)) {
    const wifiStep = sub - 9; // 1, 2, 3
    return (
      <div className="card">
        <div className="between" style={{ marginBottom: 18 }}>
          <div>
            <div className="eyebrow">Setting up {profile.name} · WiFi</div>
            <h2 style={{ margin: 0, fontSize: 20 }}>Get Your Device Online</h2>
          </div>
          <button className="btn ghost sm" onClick={() => { setSub(1); setTransportState(null); }}>← Back</button>
        </div>'''

new_wifi = '''  // --- Steps 10-12: WiFi / mBlock path (CyberPi) ---
  if (profile && profile.id === "cyberpi" && (sub >= 10 && sub <= 12)) {
    const wifiStep = sub - 9; // 1, 2, 3
    return (
      <div className="card">
        <div className="between" style={{ marginBottom: 18 }}>
          <div>
            <div className="eyebrow">Setting up {profile.name} · WiFi</div>
            <h2 style={{ margin: 0, fontSize: 20 }}>Get Your Device Online</h2>
          </div>
          <button className="btn ghost sm" onClick={() => { setSub(1); setTransportState(null); }}>← Back</button>
        </div>
        <p className="muted" style={{ fontSize: 12, marginBottom: 16, marginTop: -8 }}>
          For flashing programs, use the <b>Deploy</b> tab. This wizard is for quick connection setup.
        </p>'''

if old_wifi in c:
    c = c.replace(old_wifi, new_wifi)
    changes += 1
    print('A7: Deploy tab note added')
else:
    print('A7 ERROR: pattern not found')

# B: deviceReady handoff
old_toast = '  const [toastMsg, setToastMsg] = useState(null);'
new_toast = '  const [toastMsg, setToastMsg] = useState(null);\n  const [deviceReady, setDeviceReady] = useState(false);'
if old_toast in c:
    c = c.replace(old_toast, new_toast)
    changes += 1
    print('B1: deviceReady state added')
else:
    print('B1 ERROR: not found')

old_cw_call = 'onBrowsePrograms={(type) => { setDeviceType(type); setTab("deploy"); }}'
new_cw_call = 'onBrowsePrograms={(type) => { setDeviceType(type); setDeviceReady(true); setTab("deploy"); }}'
if old_cw_call in c:
    c = c.replace(old_cw_call, new_cw_call)
    changes += 1
    print('B2: ConnectWizard sets deviceReady')
else:
    print('B2 ERROR: not found')

old_ad_sig = 'function AdminDeploy({ deviceId, setDeviceId, toast, onDone, deviceType = "cyberpi" }) {'
new_ad_sig = 'function AdminDeploy({ deviceId, setDeviceId, toast, onDone, deviceType = "cyberpi", deviceReady = false }) {'
if old_ad_sig in c:
    c = c.replace(old_ad_sig, new_ad_sig)
    changes += 1
    print('B3: AdminDeploy accepts deviceReady')
else:
    print('B3 ERROR: not found')

old_deploy_call = '          <AdminDeploy deviceId={deviceId} setDeviceId={setDeviceId} toast={toast} deviceType={deviceType} onDone={() => setTab("devices")} />'
new_deploy_call = '          <AdminDeploy deviceId={deviceId} setDeviceId={setDeviceId} toast={toast} deviceType={deviceType} deviceReady={deviceReady} onDone={() => { setDeviceReady(false); setTab("devices"); }} />'
if old_deploy_call in c:
    c = c.replace(old_deploy_call, new_deploy_call)
    changes += 1
    print('B4: deviceReady passed to AdminDeploy')
else:
    print('B4 ERROR: not found')

# B5: Skip connect step when deviceReady - change sub useState init
old_sub_init = '  const [sub, setSub] = useState(0);            // 0 connect · 1 open mBlock · 2 upload'
new_sub_init = '  const [sub, setSub] = useState(deviceReady ? 1 : 0);            // 0 connect · 1 open mBlock · 2 upload'

# Find AdminDeploy's useState for sub
ad_start = c.find(new_ad_sig)
if ad_start >= 0:
    sub_pos = c.find(old_sub_init, ad_start)
    if sub_pos >= 0:
        c = c[:sub_pos] + new_sub_init + c[sub_pos + len(old_sub_init):]
        changes += 1
        print('B5: AdminDeploy starts at catalog when deviceReady')
    else:
        # Try alternate pattern
        alt_sub = '  const [sub, setSub] = useState(0);'
        sub_pos2 = c.find(alt_sub, ad_start)
        if sub_pos2 >= 0:
            c = c[:sub_pos2] + '  const [sub, setSub] = useState(deviceReady ? 1 : 0);' + c[sub_pos2 + len(alt_sub):]
            changes += 1
            print('B5: AdminDeploy sub init fixed (alt pattern)')
        else:
            print('B5 ERROR: sub init not found in AdminDeploy')
else:
    print('B5: AdminDeploy not found, skipping')

with open(path, 'w', encoding='utf-8') as f:
    f.write(c)
print(f'Total changes: {changes}')
