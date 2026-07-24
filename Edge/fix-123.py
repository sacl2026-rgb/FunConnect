path = r'C:\Projects\FunConnect\Beauty\src\app.jsx'
with open(path, 'r', encoding='utf-8') as f:
    c = f.read()

changes = 0

# ── Fix 1: Stepper accepts optional steps prop ───────────────────────
old_stepper = '''function Stepper({ current }) {
  const idx = STEPS.findIndex(s => s.key === current);
  return (
    <div className="steps">
      {STEPS.map((s, i) => (
        <div key={s.key} className={"step " + (i === idx ? "active" : i < idx ? "done" : "")}>
          <span className="dot">{i < idx ? "\u2713" : i + 1}</span>
          {s.label}
        </div>
      ))}
    </div>
  );
}'''

new_stepper = '''function Stepper({ current, steps }) {
  const s = steps || STEPS;
  const idx = s.findIndex(x => x.key === current);
  return (
    <div className="steps">
      {s.map((st, i) => (
        <div key={st.key} className={"step " + (i === idx ? "active" : i < idx ? "done" : "")}>
          <span className="dot">{i < idx ? "\u2713" : i + 1}</span>
          {st.label}
        </div>
      ))}
    </div>
  );
}'''

if old_stepper in c:
    c = c.replace(old_stepper, new_stepper)
    changes += 1
    print('Fix 1a: Stepper accepts optional steps prop')
else:
    print('Fix 1a ERROR: Stepper not found')

# ── Fix 1b: AdminDeploy passes filtered steps when deviceReady ────────
old_stepper_call = '<Stepper current={sub} />'
new_stepper_call = '<Stepper current={sub} steps={deviceReady ? STEPS.slice(1) : null} />'
# Only replace in AdminDeploy context
ad_sig = 'function AdminDeploy({ deviceId, setDeviceId, toast, onDone, deviceType = "cyberpi", deviceReady = false }) {'
ad_start = c.find(ad_sig)
if ad_start >= 0:
    call_pos = c.find(old_stepper_call, ad_start)
    if call_pos >= 0:
        c = c[:call_pos] + new_stepper_call + c[call_pos + len(old_stepper_call):]
        changes += 1
        print('Fix 1b: AdminDeploy uses filtered steps when deviceReady')
    else:
        print('Fix 1b ERROR: Stepper call not found in AdminDeploy')
else:
    print('Fix 1b ERROR: AdminDeploy not found')

# ── Fix 2: onDashboard callback in MicrobitSaveOverlay ─────────────────
old_overlay_sig = 'function MicrobitSaveOverlay({ program, onClose, onDone }) {'
new_overlay_sig = 'function MicrobitSaveOverlay({ program, onClose, onDone, onDashboard }) {'
if old_overlay_sig in c:
    c = c.replace(old_overlay_sig, new_overlay_sig)
    changes += 1
    print('Fix 2a: MicrobitSaveOverlay accepts onDashboard')
else:
    print('Fix 2a ERROR: not found')

# Fix 2b: Replace raw hash change with onDashboard callback
old_hash_nav = '''              <button className="btn" onClick={() => { window.location.hash = "dashboard"; onDone(); }}>
                View Dashboard \u2192
              </button>'''
new_hash_nav = '''              <button className="btn" onClick={() => { if (onDashboard) { onDashboard(); } else { window.location.hash = "dashboard"; } onDone(); }}>
                View Dashboard \u2192
              </button>'''
if old_hash_nav in c:
    c = c.replace(old_hash_nav, new_hash_nav)
    changes += 1
    print('Fix 2b: View Dashboard uses onDashboard callback')
else:
    print('Fix 2b ERROR: not found')

# Fix 2c: Wire onDashboard through Catalog
old_catalog_sig = 'function Catalog({ deviceType, selected, onSelect, onDeploy, onSkip }) {'
new_catalog_sig = 'function Catalog({ deviceType, selected, onSelect, onDeploy, onSkip, onDashboard }) {'
if old_catalog_sig in c:
    c = c.replace(old_catalog_sig, new_catalog_sig)
    changes += 1
    print('Fix 2c: Catalog accepts onDashboard')
else:
    print('Fix 2c ERROR: not found')

# Fix 2d: Pass onDashboard from Catalog to MicrobitSaveOverlay
old_overlay_call = '{overlay && <MicrobitSaveOverlay program={overlay} onClose={() => setOverlay(null)} onDone={() => { setOverlay(null); onSelect(null); }} />}'
new_overlay_call = '{overlay && <MicrobitSaveOverlay program={overlay} onClose={() => setOverlay(null)} onDone={() => { setOverlay(null); onSelect(null); }} onDashboard={onDashboard} />}'
if old_overlay_call in c:
    c = c.replace(old_overlay_call, new_overlay_call)
    changes += 1
    print('Fix 2d: onDashboard passed to MicrobitSaveOverlay')
else:
    print('Fix 2d ERROR: not found')

# Fix 2e: PublicFlow passes onDashboard to Catalog (stores deviceType, navigates)
old_pf_catalog = '{step === "catalog"   && <Catalog deviceType={deviceType} selected={program} onSelect={setProgram} onDeploy={() => program && setStep("deploy")} onSkip={() => setStep("dashboard")} />}'
new_pf_catalog = '{step === "catalog"   && <Catalog deviceType={deviceType} selected={program} onSelect={setProgram} onDeploy={() => program && setStep("deploy")} onSkip={() => setStep("dashboard")} onDashboard={() => { try { localStorage.setItem("fc_device_type", "microbit"); } catch {}; window.location.hash = "dashboard"; }} />}'
if old_pf_catalog in c:
    c = c.replace(old_pf_catalog, new_pf_catalog)
    changes += 1
    print('Fix 2e: PublicFlow onDashboard stores deviceType + navigates')
else:
    print('Fix 2e ERROR: not found')

# Fix 2f: AdminDeploy passes onDashboard to Catalog
old_ad_catalog = '{sub === "catalog" && <Catalog deviceType={deviceType} selected={program} onSelect={setProgram}'
new_ad_catalog = '{sub === "catalog" && <Catalog deviceType={deviceType} selected={program} onSelect={setProgram} onDashboard={() => { onDone(); }}'
if old_ad_catalog in c:
    c = c.replace(old_ad_catalog, new_ad_catalog)
    changes += 1
    print('Fix 2f: AdminDeploy onDashboard calls onDone')
else:
    print('Fix 2f ERROR: not found')

# ── Fix 3: Honest offline overlay message ──────────────────────────────
old_offline_msg = '''            {effectiveType === \"microbit\"
              ? \"Plug in your micro:bit and flash a program from the catalog.\"
              : \"Power on your CyberPi and ensure it's connected to WiFi.\"}'''

new_offline_msg = '''            {effectiveType === \"microbit\"
              ? \"Your program is running on the micro:bit. Live telemetry requires a V2 micro:bit with USB relay.\"
              : \"Power on your CyberPi and ensure it's connected to WiFi.\"}'''

if old_offline_msg in c:
    c = c.replace(old_offline_msg, new_offline_msg)
    changes += 1
    print('Fix 3: Honest offline message for micro:bit')
else:
    print('Fix 3 ERROR: offline message not found')

with open(path, 'w', encoding='utf-8') as f:
    f.write(c)
print(f'Total: {changes} changes')
