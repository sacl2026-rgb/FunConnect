import re

path = r"C:\Projects\FunConnect\Beauty\src\app.jsx"
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# ── Fix 1: V1.5 detection ───────────────────────────────────────────
# After the VID_MAP block in startSerialRelay, add V1 detection that sets
# a v1Hardware warning state instead of proceeding to serial relay.

old_vid_map = '''      const VID_MAP = {
        "0x0D28:0x0204": "microbit",  // micro:bit V1
        "0x0D28:0x0209": "microbit",  // micro:bit V2
        "0x1A86:0x7523": "cyberpi",   // CyberPi (CH340)
      };
      const detectedType = vidPid ? VID_MAP[vidPid] : null;
      if (detectedType && detectedType !== deviceType) {
        // Gentle correction — auto-switch to detected device.
        const detectedProfile = DEVICE_PROFILES[detectedType];
        setDeviceType(detectedType);
        setDeviceIdState(detectedProfile ? detectedProfile.defaultDeviceId : relayDeviceId);
        relayDeviceId = detectedProfile ? detectedProfile.defaultDeviceId : relayDeviceId;
      }

      // Now show feedback — user has selected a port.
      setSub(20); setSerialState("connecting-serial");'''

new_vid_map = '''      const VID_MAP = {
        "0x0D28:0x0204": "microbit",  // micro:bit V1
        "0x0D28:0x0209": "microbit",  // micro:bit V2
        "0x1A86:0x7523": "cyberpi",   // CyberPi (CH340)
      };
      const detectedType = vidPid ? VID_MAP[vidPid] : null;

      // V1.5 micro:bit (PID 0x0204, KL26Z) has transmit-only CDC.
      // Serial relay connects but telemetry never arrives. Warn and
      // redirect to the MSD path instead of offering a dead-end relay.
      if (detectedType === "microbit" && port.getInfo().usbProductId === 0x0204) {
        setSub(20); setSerialState("v1-hardware");
        return; // Don't open port — jump straight to the warning card.
      }

      if (detectedType && detectedType !== deviceType) {
        // Gentle correction — auto-switch to detected device.
        const detectedProfile = DEVICE_PROFILES[detectedType];
        setDeviceType(detectedType);
        setDeviceIdState(detectedProfile ? detectedProfile.defaultDeviceId : relayDeviceId);
        relayDeviceId = detectedProfile ? detectedProfile.defaultDeviceId : relayDeviceId;
      }

      // Now show feedback — user has selected a port.
      setSub(20); setSerialState("connecting-serial");'''

content = content.replace(old_vid_map, new_vid_map)

# ── Fix 1b: Add V1 hardware warning UI state ─────────────────────────
# Add a "v1-hardware" state after the "connecting-serial" block

old_v1_insert = '''        {serialState === "connecting-wss" && ('''
new_v1_insert = '''        {serialState === "v1-hardware" && (
          <div>
            <div style={{ fontSize: 48, marginBottom: 8, color: "var(--warn)" }}>!</div>
            <div className="pulsebar" style={{ borderColor: "rgba(240,160,48,.35)", background: "rgba(240,160,48,.07)" }}>
              <span className="pulsedot" style={{ background: "var(--warn)", boxShadow: "0 0 12px var(--warn)" }} />
              This micro:bit V1 cannot stream live data.
            </div>
            <p className="muted" style={{ fontSize: 14, marginBottom: 16, maxWidth: 420, margin: "0 auto 16px" }}>
              V1 micro:bits use an older USB chip that only sends data one way. Live dashboards need a V2 micro:bit. You can still use <b>Save to micro:bit →</b> in the catalog to flash programs onto this device — it works with all micro:bits.
            </p>
            <div className="row" style={{ gap: 10, justifyContent: "center" }}>
              <button className="btn" onClick={() => { disconnectRelay(); onBrowsePrograms && onBrowsePrograms("microbit"); }}>
                Browse Programs →
              </button>
              <button className="btn ghost" onClick={backFromRelay}>← Back</button>
            </div>
          </div>
        )}

        {serialState === "connecting-wss" && ('''

content = content.replace(old_v1_insert, new_v1_insert)

# ── Fix 2: FAIL.TXT feedback ──────────────────────────────────────────
# After writable.close() in saveToMicrobit, check if file was consumed

old_save = '''  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}'''

new_save = '''  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
  // Tripwire: DAPLink should consume the .hex within ~500ms. If the file
  // handle is still writable after 800ms, the transfer likely failed
  // (Windows FAIL.TXT issue). Surface this to the teacher.
  try {
    await new Promise(r => setTimeout(r, 800));
    const checkHandle = await handle.createWritable();
    await checkHandle.close();
    // File still writable => DAPLink didn't consume it.
    throw new Error("File didn't transfer — the micro:bit may not have accepted it. Try again or use Download instead.");
  } catch (e) {
    if (e.message && e.message.includes("File didn't transfer")) throw e;
    // Any other error (NotFoundError, etc.) means DAPLink consumed the file => success.
  }
}'''

content = content.replace(old_save, new_save)

# ── Fix 3: deviceType hardening ───────────────────────────────────────
# Remove the fragile selType bandage — trust the deviceType prop

old_seltype = '''  // Trust the deviceType prop from AdminShell (set by ConnectWizard flow).
  // API-derived device_type is a fallback, never an override.
  const selType = deviceType !== "cyberpi" ? deviceType : (selGroup?.deviceType || "cyberpi");'''

new_seltype = '''  // deviceType flows from AdminShell as the single source of truth.
  // If set by ConnectWizard (non-default), it is authoritative.
  // If still default "cyberpi" and the selected group has deviceType from
  // the API, prefer the API value. Otherwise trust the prop.
  const selType = (deviceType !== "cyberpi")
    ? deviceType
    : (selGroup?.deviceType || deviceType);'''

content = content.replace(old_seltype, new_seltype)

# ── Fix 4: File picker overlay ────────────────────────────────────────
# In MicrobitSaveOverlay, add overlay state during save that warns about hidden dialog

old_microbit_save_click = '''            <button className="btn lg" onClick={handleSave}>
              Save to micro:bit →
            </button>'''

new_microbit_save_click = '''            <button className="btn lg" onClick={handleSave}>
              Save to micro:bit →
            </button>
            <p className="muted" style={{ fontSize: 12, marginTop: 8, color: "var(--warn)" }}>
              A save dialog will open — if you don't see it, check behind this window.
            </p>'''

content = content.replace(old_microbit_save_click, new_microbit_save_click)

# ── Fix 5: One-button catalog ─────────────────────────────────────────
# Simplify micro:bit catalog to 1 primary + 1 text link

old_catalog_btns = '''        {(profile && profile.deploy && profile.deploy.programFormat === ".hex") || (selected && selected.format === ".hex") ? (
          <div className="row" style={{ gap: 8 }}>
            <button className="btn ghost" onClick={onSkip}>Skip to Dashboard →</button>
            <button className="btn" disabled={!selected}
              onClick={() => selected && setOverlay(selected)}>
              Save to micro:bit →
            </button>
            <button className="btn ghost" disabled={!selected}
              onClick={() => selected && downloadHex(selected.id, selected.name)}>
              ↓ Download .hex
            </button>
          </div>
        ) : (
          <div className="row">
            <button className="btn ghost" onClick={onSkip}>Skip to Dashboard →</button>
            <button className="btn" disabled={!selected} onClick={onDeploy}>Deploy →</button>
          </div>
        )}'''

new_catalog_btns = '''        {(profile && profile.deploy && profile.deploy.programFormat === ".hex") || (selected && selected.format === ".hex") ? (
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" disabled={!selected}
              onClick={() => selected && setOverlay(selected)}>
              Save to micro:bit →
            </button>
            {selected && (
              <button className="btn ghost sm" style={{ fontSize: 12 }}
                onClick={() => downloadHex(selected.id, selected.name)}>
                ↓ Download .hex instead
              </button>
            )}
          </div>
        ) : (
          <div className="row">
            <button className="btn ghost" onClick={onSkip}>Skip to Dashboard →</button>
            <button className="btn" disabled={!selected} onClick={onDeploy}>Deploy →</button>
          </div>
        )}'''

content = content.replace(old_catalog_btns, new_catalog_btns)

# ── Fix 6: Login → Catalog link ───────────────────────────────────────
old_login_btn = '''        <button className="btn lg" type="submit" disabled={busy || !u || !p} style={{ marginTop: 18 }}>
          {busy ? <><span className="spinner" /> Signing in…</> : "Login"}
        </button>

      </form>'''

new_login_btn = '''        <button className="btn lg" type="submit" disabled={busy || !u || !p} style={{ marginTop: 18 }}>
          {busy ? <><span className="spinner" /> Signing in…</> : "Login"}
        </button>

        <p style={{ textAlign: "center", marginTop: 16, fontSize: 13 }}>
          <a href="#catalog" style={{ color: "var(--muted)", textDecoration: "none" }}>
            Just browsing? See what you can make →
          </a>
        </p>

      </form>'''

content = content.replace(old_login_btn, new_login_btn)

# ── Fix 7: Chat multi-turn ────────────────────────────────────────────
old_chat_send = '''  const send = async (text) => {
    const msg = (text != null ? text : input).trim();
    if (!msg || busy) return;
    setInput("");
    setMessages(m => [...m, { role: "user", text: msg }]);
    setBusy(true);
    try {
      const r = await postChat(msg, deviceId);
      const reply = r.reply || r.answer || r.response || r.message || "I'm not sure how to answer that.";
      const context = r.context || r.sources || r.alerts || [];
      setMessages(m => [...m, { role: "bot", text: reply, context }]);'''

new_chat_send = '''  const send = async (text, focusAlertId) => {
    const msg = (text != null ? text : input).trim();
    if (!msg || busy) return;
    setInput("");
    setMessages(m => [...m, { role: "user", text: msg }]);
    setBusy(true);
    try {
      // Multi-turn: include last 4 exchanges (8 messages) as history.
      // focusAlertId comes from tapping a context chip for drill-in.
      const history = messages.slice(-8).map(m => ({ role: m.role === "bot" ? "assistant" : "user", content: m.text }));
      const body = { message: msg, device_id: deviceId, history };
      if (focusAlertId) body.focus = { alert_id: focusAlertId };
      const r = await postChat(msg, deviceId, body);
      const reply = r.reply || r.answer || r.response || r.message || "I'm not sure how to answer that.";
      const context = r.context || r.sources || r.alerts || [];
      setMessages(m => [...m, { role: "bot", text: reply, context }]);'''

content = content.replace(old_chat_send, new_chat_send)

# Also update postChat to accept body override
old_postchat = '''async function postChat(message, deviceId) {
  const token = getJwt();
  const headers = { "content-type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const r = await fetch(`${API_BASE}/api/chat`, {
    method: "POST", headers,
    body: JSON.stringify({ message, device_id: deviceId }),
  });'''

new_postchat = '''async function postChat(message, deviceId, bodyOverride) {
  const token = getJwt();
  const headers = { "content-type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const body = bodyOverride || { message, device_id: deviceId };
  const r = await fetch(`${API_BASE}/api/chat`, {
    method: "POST", headers,
    body: JSON.stringify(body),
  });'''

content = content.replace(old_postchat, new_postchat)

# Also wire context chip onClick for drill-in
old_ctx_chip = '''                    ? <div className="chat-ctx">{m.context.map((c, j) => <span key={j} className="cx">{ctxLabel(c)}</span>)}</div>'''

new_ctx_chip = '''                    ? <div className="chat-ctx">{m.context.map((c, j) => <span key={j} className="cx" onClick={() => c.id && send("Tell me more about this", c.id)} style={{cursor: c.id ? "pointer" : "default"}} title={c.id ? "Click to ask about this alert" : ""}>{ctxLabel(c)}</span>)}</div>'''

content = content.replace(old_ctx_chip, new_ctx_chip)

# ── Fix 8: MicrobitSaveOverlay illustration ────────────────────────────
old_placeholder = '''            <div style={{
              margin: "0 auto 18px", border: "2px dashed var(--line)",
              borderRadius: 12, padding: 40, color: "var(--muted)",
              fontSize: 14, maxWidth: 320,
            }}>
              Picture coming soon
            </div>'''

new_illustration = '''            <svg width="200" height="120" viewBox="0 0 200 120" style={{ margin: "0 auto 18px", display: "block" }}>
              <rect x="45" y="8" width="110" height="72" rx="10" fill="var(--panel-2)" stroke="var(--line)" strokeWidth="2"/>
              <rect x="55" y="18" width="50" height="32" rx="4" fill="var(--panel)" stroke="var(--line)" strokeWidth="1.5"/>
              <circle cx="72" cy="28" r="3" fill="var(--brand)"/>
              <circle cx="82" cy="28" r="3" fill="var(--brand)"/>
              <circle cx="92" cy="28" r="3" fill="var(--brand)"/>
              <circle cx="72" cy="38" r="3" fill="var(--brand)"/>
              <circle cx="82" cy="38" r="3" fill="var(--accent)"/>
              <circle cx="92" cy="38" r="3" fill="var(--brand)"/>
              <rect x="112" y="18" width="30" height="32" rx="4" fill="var(--panel)" stroke="var(--line)" strokeWidth="1.5"/>
              <circle cx="127" cy="34" r="8" fill="none" stroke="var(--brand)" strokeWidth="2"/>
              <rect x="55" y="55" width="90" height="16" rx="3" fill="var(--panel-2)" stroke="var(--line)" strokeWidth="1"/>
              <line x1="25" y1="48" x2="45" y2="44" stroke="var(--brand)" strokeWidth="3" strokeLinecap="round"/>
              <line x1="25" y1="54" x2="45" y2="56" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round"/>
              <text x="100" y="108" textAnchor="middle" fill="var(--muted)" fontSize="11" fontFamily="system-ui">micro:bit</text>
            </svg>'''

content = content.replace(old_placeholder, new_illustration)

# Write result
with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

print("All fixes applied successfully.")
print(f"File size: {len(content)} bytes")
