path = r'C:\Projects\FunConnect\Beauty\src\app.jsx'
with open(path, 'r', encoding='utf-8') as f:
    c = f.read()

changes = 0

# ── Step 1: Remove effectiveType/discoveredType, compute panel inline ──
# Replace the derived state block (lines 1292-1300)
old_derived = '''  // Effective device: newest discovered when auto-following, else the manual id.
  // discovered is [{device_id, device_type}] — extract the id for WS/polling, type for panels.
  const discoveredEntry = (auto && discovered && discovered[0]) ? discovered[0] : null;
  const dev = discoveredEntry ? discoveredEntry.device_id : deviceId;
  const discoveredType = discoveredEntry ? discoveredEntry.device_type : null;
  // Prefer API-provided device_type, fall back to prop, then default.
  const effectiveType = discoveredType || deviceType;
  const profile = DEVICE_PROFILES[effectiveType] || DEVICE_PROFILES.cyberpi;
  const panel = profile.telemetry.dashboardPanel;'''

new_derived = '''  // Device to connect to: auto-follow picks the discovered device, else manual.
  const discoveredEntry = (auto && discovered && discovered[0]) ? discovered[0] : null;
  const dev = discoveredEntry ? discoveredEntry.device_id : deviceId;
  // Panel is derived INLINE from deviceType prop — single source of truth.
  // Auto-follow updates the PARENT via onAutoFind, never overrides the prop locally.
  const profile = DEVICE_PROFILES[deviceType] || DEVICE_PROFILES.cyberpi;
  const panel = profile.telemetry.dashboardPanel;'''

if old_derived in c:
    c = c.replace(old_derived, new_derived)
    changes += 1
    print('Step 1: effectiveType/discoveredType removed, panel computed inline from deviceType prop')
else:
    print('Step 1 ERROR: derived state block not found')

# ── Step 1b: Replace all effectiveType references with deviceType ──
c = c.replace('{!online && (effectiveType === "microbit" ? (', '{!online && (deviceType === "microbit" ? (')

# ── Step 5: Add onAutoFind callback prop to Dashboard ──
old_dash_sig = 'function Dashboard({ deviceId, setDeviceId, follow = true, showDeviceControls = true, deviceType = "cyberpi" }) {'
new_dash_sig = 'function Dashboard({ deviceId, setDeviceId, follow = true, showDeviceControls = true, deviceType = "cyberpi", onAutoFind }) {'
if old_dash_sig in c:
    c = c.replace(old_dash_sig, new_dash_sig)
    changes += 1
    print('Step 5: Dashboard accepts onAutoFind prop')
else:
    print('Step 5 ERROR: Dashboard signature not found')

# ── Step 5b: Auto-follow calls onAutoFind instead of storing discoveredType ──
# Find the setDiscovered call in the auto-discovery useEffect and wire it
old_set_discovered = '''    const tick = async () => {
      const live = await discoverLiveDevice(deviceId);
      if (alive && live) setDiscovered([live]);  // {device_id, device_type}
    };'''

new_set_discovered = '''    const tick = async () => {
      const live = await discoverLiveDevice(deviceId);
      if (alive && live) {
        setDiscovered([live]);  // {device_id, device_type} — for the auto-follow pill display
        if (onAutoFind) onAutoFind(live);  // Tell parent: found {device_id, device_type}
      }
    };'''

if old_set_discovered in c:
    c = c.replace(old_set_discovered, new_set_discovered)
    changes += 1
    print('Step 5b: auto-follow calls onAutoFind to update parent')
else:
    print('Step 5b ERROR: setDiscovered block not found')

# ── Step 3: AdminShell — selectedDevice + deployTarget ──────────────────
# Find AdminShell and refactor
old_admin_state = '''  const [tab, setTab] = useState("connect");
  const [deviceType, setDeviceType] = useState("cyberpi");
  const [deviceId, setDeviceIdRaw] = useState(() => {
    try { return localStorage.getItem("fc_device_id") || DEFAULT_DEVICE_ID; } catch { return DEFAULT_DEVICE_ID; }
  });
  const [toastMsg, setToastMsg] = useState(null);
  const [deviceReady, setDeviceReady] = useState(false);'''

new_admin_state = '''  const [tab, setTab] = useState("connect");
  // selectedDevice = { id, type } — single source of truth for the dashboard panel.
  // deployTarget is separate: what device are we flashing in the Deploy tab.
  const [selectedDevice, setSelectedDevice] = useState({ id: null, type: null });
  const [deployTarget, setDeployTarget] = useState("cyberpi");
  const [deviceId, setDeviceIdRaw] = useState(() => {
    try { return localStorage.getItem("fc_device_id") || DEFAULT_DEVICE_ID; } catch { return DEFAULT_DEVICE_ID; }
  });
  const [toastMsg, setToastMsg] = useState(null);
  const [deviceReady, setDeviceReady] = useState(false);'''

if old_admin_state in c:
    c = c.replace(old_admin_state, new_admin_state)
    changes += 1
    print('Step 3: AdminShell refactored — selectedDevice + deployTarget')
else:
    print('Step 3 ERROR: AdminShell state not found')

# ── Step 3b: Update setDeviceId to also store in selectedDevice ──
old_set_id = '''  const setDeviceId = useCallback((v) => {
    const id = (v || "").trim() || DEFAULT_DEVICE_ID;
    setDeviceIdRaw(id);
    try { localStorage.setItem("fc_device_id", id); } catch {}
  }, []);'''

new_set_id = '''  const setDeviceId = useCallback((v) => {
    const id = (v || "").trim() || DEFAULT_DEVICE_ID;
    setDeviceIdRaw(id);
    try { localStorage.setItem("fc_device_id", id); } catch {}
  }, []);
  const handleAutoFind = useCallback((device) => {
    // Auto-follow found a device — update the selected device if auto mode is on.
    if (device && device.device_id) {
      setSelectedDevice({ id: device.device_id, type: device.device_type || "cyberpi" });
    }
  }, []);
  const handleSelectDevice = useCallback((device) => {
    // User clicked a device in the list.
    if (device) setSelectedDevice(device);
  }, []);'''

if old_set_id in c:
    c = c.replace(old_set_id, new_set_id)
    changes += 1
    print('Step 3b: handleAutoFind + handleSelectDevice callbacks added')
else:
    print('Step 3b ERROR: setDeviceId not found')

# ── Step 4: AdminDevices — wire onSelectDevice ─────────────────────────
# Find AdminDevices signature and add prop
old_ad_sig = 'function AdminDevices({ token, onLogout, deviceType, onDeviceReady }) {'
new_ad_sig = 'function AdminDevices({ token, onLogout, deviceType, onSelectDevice }) {'
# But wait — need to also keep deviceType as fallback for no-selection state

# Actually AdminDevices currently has deviceType prop. Let me find it and change.
# First find the actual signature
ad_sig_pos = c.find('function AdminDevices({')
if ad_sig_pos >= 0:
    # Read the actual line
    import re
    match = re.search(r'function AdminDevices\(\{[^}]+\}\)', c[ad_sig_pos:ad_sig_pos+200])
    if match:
        actual_sig = match.group()
        # Replace deviceType with onSelectDevice addition
        new_actual = actual_sig.replace('deviceType', 'deviceType, onSelectDevice')
        if 'onSelectDevice' not in actual_sig:
            c = c.replace(actual_sig, new_actual)
            changes += 1
            print('Step 4: AdminDevices accepts onSelectDevice')
        else:
            print('Step 4: already has onSelectDevice')
    else:
        print('Step 4 ERROR: AdminDevices regex failed')
else:
    print('Step 4 ERROR: AdminDevices not found')

# ── Step 4b: Wire onSelectDevice call when user clicks a device ────────
# Find setSel call in AdminDevices
old_set_sel = '''                  onClick={() => setSel(g.target)} style={{ marginBottom: 6 }}>'''
new_set_sel = '''                  onClick={() => { setSel(g.target); if (onSelectDevice) onSelectDevice({ id: g.target, type: g.deviceType || deviceType }); }} style={{ marginBottom: 6 }}>'''
if old_set_sel in c:
    c = c.replace(old_set_sel, new_set_sel)
    changes += 1
    print('Step 4b: onSelectDevice called on device click')
else:
    print('Step 4b ERROR: setSel click not found')

# ── Step 4c: Remove selType, pass deviceType from group directly ────────
old_seltype_block = '''  // selType comes from the selected device's actual type reported by the
  // API. deviceType from ConnectWizard/AdminDeploy is only a fallback when
  // no device is selected. The dashboard panel must reflect the device
  // the user clicked, not whatever was last connected in the wizard.
  const selType = selGroup?.deviceType || deviceType;'''
new_seltype_block = '''  // Panel type comes from the selected group's device_type from the API.
  // Falls back to the prop only when nothing is selected.
  const selType = selGroup?.deviceType || deviceType || "cyberpi";'''
if old_seltype_block in c:
    c = c.replace(old_seltype_block, new_seltype_block)
    changes += 1
    print('Step 4c: selType simplified')
else:
    print('Step 4c ERROR: selType block not found')

# ── Step 2: Add key to Dashboard ───────────────────────────────────────
old_dash_render = '          ? <Dashboard deviceId={sel} setDeviceId={setSel} follow={false} showDeviceControls={false} deviceType={selType} />'
new_dash_render = '          ? <Dashboard key={sel} deviceId={sel} setDeviceId={setSel} follow={false} showDeviceControls={false} deviceType={selType} onAutoFind={onAutoFind} />'
if old_dash_render in c:
    c = c.replace(old_dash_render, new_dash_render)
    changes += 1
    print('Step 2: Dashboard key={sel} added for full reset on device switch')
else:
    print('Step 2 ERROR: Dashboard render not found')

# ── Step 6: Wire AdminShell callbacks to child components ───────────────
# Update ConnectWizard to use deployTarget
old_cw_call = '          <ConnectWizard onDeviceReady={(type, id) => { setDeviceType(type); setDeviceId(id); setTab("devices"); }} onBrowsePrograms={(type) => { setDeviceType(type); setDeviceReady(true); setTab("deploy"); }} />'
new_cw_call = '          <ConnectWizard onDeviceReady={(type, id) => { setDeployTarget(type); setDeviceId(id); setTab("devices"); }} onBrowsePrograms={(type) => { setDeployTarget(type); setDeviceReady(true); setTab("deploy"); }} />'
if old_cw_call in c:
    c = c.replace(old_cw_call, new_cw_call)
    changes += 1
    print('Step 6a: ConnectWizard uses deployTarget')
else:
    print('Step 6a ERROR: ConnectWizard call not found')

# Update AdminDevices call
old_ad_call = '          <AdminDevices token={token} onLogout={onLogout} deviceType={deviceType} />'
new_ad_call = '          <AdminDevices token={token} onLogout={onLogout} deviceType={selectedDevice.type || "cyberpi"} onSelectDevice={handleSelectDevice} onAutoFind={handleAutoFind} />'
if old_ad_call in c:
    c = c.replace(old_ad_call, new_ad_call)
    changes += 1
    print('Step 6b: AdminDevices wired with callbacks')
else:
    print('Step 6b ERROR: AdminDevices call not found')

# Update AdminDeploy call
old_deploy_ad = '          <AdminDeploy deviceId={deviceId} setDeviceId={setDeviceId} toast={toast} deviceType={deviceType} deviceReady={deviceReady} onDone={() => { setDeviceReady(false); setTab("devices"); }} />'
new_deploy_ad = '          <AdminDeploy deviceId={deviceId} setDeviceId={setDeviceId} toast={toast} deviceType={deployTarget} deviceReady={deviceReady} onDone={() => { setDeviceReady(false); setTab("devices"); }} />'
if old_deploy_ad in c:
    c = c.replace(old_deploy_ad, new_deploy_ad)
    changes += 1
    print('Step 6c: AdminDeploy uses deployTarget')
else:
    print('Step 6c ERROR: AdminDeploy call not found')

# ── Step 7: PublicFlow Dashboard call also needs key ────────────────────
# Find the post-deploy dashboard render in PublicFlow
old_pf_dash = '          ? <Dashboard deviceId={deviceId} setDeviceId={setDeviceId} deviceType={deviceType} follow={false} showDeviceControls={false} />'
new_pf_dash = '          ? <Dashboard key={deviceId} deviceId={deviceId} setDeviceId={setDeviceId} deviceType={deviceType} follow={false} showDeviceControls={false} />'
if old_pf_dash in c:
    c = c.replace(old_pf_dash, new_pf_dash)
    changes += 1
    print('Step 7: PublicFlow Dashboard gets key={deviceId}')
else:
    print('Step 7: PublicFlow dashboard not found (may be OK)')

# Also update the PublicFlow "dashboard" step render
old_pf_step = '{step === "dashboard" && <Dashboard deviceId={deviceId} setDeviceId={setDeviceId} deviceType={deviceType} />}'
new_pf_step = '{step === "dashboard" && <Dashboard key={deviceId} deviceId={deviceId} setDeviceId={setDeviceId} deviceType={deviceType} />}'
if old_pf_step in c:
    c = c.replace(old_pf_step, new_pf_step)
    changes += 1
    print('Step 7b: PublicFlow dashboard step key added')
else:
    print('Step 7b: not found (non-critical)')

with open(path, 'w', encoding='utf-8') as f:
    f.write(c)
print(f'Total: {changes} changes')
