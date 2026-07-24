path = r'C:\Projects\FunConnect\Beauty\src\app.jsx'
with open(path, 'r', encoding='utf-8') as f:
    c = f.read()

changes = 0

# ── Add import for flashViaWebHID ──────────────────────────────────────
old_import = 'import { startRelay, disconnectRelay, getActiveRelay, sendToDevice } from "./relay.js";'
new_import = 'import { startRelay, disconnectRelay, getActiveRelay, sendToDevice } from "./relay.js";\nimport { flashViaWebHID } from "./webhid-flash.js";'
if old_import in c:
    c = c.replace(old_import, new_import)
    changes += 1
    print('Import: flashViaWebHID added')
else:
    print('ERROR: import not found')

# ── Add WebhidFlashOverlay component (before MicrobitSaveOverlay) ──────
# Insert after the downloadHex function
old_dh_end = '    console.error("downloadHex:", e);\n  }\n}'
new_dh_end = '''    console.error("downloadHex:", e);
  }
}

// ---- WebHID Flash Overlay (micro:bit zero-click) --------------------
function WebhidFlashOverlay({ program, onClose, onDone, onDashboard }) {
  const [phase, setPhase] = useState("pair"); // pair | flashing | done | error
  const [errMsg, setErrMsg] = useState(null);
  const [progress, setProgress] = useState({ current: 0, total: 1 });
  const [hexBlob, setHexBlob] = useState(null);
  const hasHID = typeof navigator !== "undefined" && !!navigator.hid;

  // Fetch the .hex blob when the overlay opens
  useEffect(() => {
    let alive = true;
    fetch(API_BASE + "/api/catalog/" + encodeURIComponent(program.id))
      .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.blob(); })
      .then(blob => alive && setHexBlob(blob))
      .catch(e => alive && (setErrMsg("Failed to load program: " + e.message), setPhase("error")));
    return () => { alive = false; };
  }, [program.id]);

  // When hexBlob loads and device already paired, go straight to flashing
  useEffect(() => {
    if (!hexBlob || !hasHID) return;
    navigator.hid.getDevices().then(devices => {
      if (devices.some(d => d.vendorId === 0x0D28)) {
        startFlash(hexBlob);
      }
    });
  }, [hexBlob, hasHID]);

  const startFlash = async (blob) => {
    setPhase("flashing");
    setProgress({ current: 0, total: 1 });
    try {
      await flashViaWebHID(blob, (p) => setProgress(p));
      setPhase("done");
    } catch (e) {
      if (e.message && e.message.includes("timed out"))
        setErrMsg("Flash timed out — the micro:bit may have disconnected. Try again or use Save to micro:bit instead.");
      else
        setErrMsg(e.message || "Flash failed");
      setPhase("error");
    }
  };

  const handlePair = async () => {
    try {
      const devices = await navigator.hid.requestDevice({ filters: [{ vendorId: 0x0D28 }] });
      if (devices[0] && hexBlob) startFlash(hexBlob);
    } catch (e) {
      if (e.name !== "NotFoundError")
        setErrMsg(e.message || "Could not pair");
    }
  };

  if (!hasHID) return null; // Never render on unsupported browsers

  return (
    <div className="overlay-full">
      <div className="modal" style={{ maxWidth: 480 }}>
        <div className="modal-head">
          <div>
            <div className="eyebrow">Flash with FunConnect</div>
            <h2 style={{ margin: 0, fontSize: 20 }}>{program.name}</h2>
          </div>
          <button className="x" onClick={onClose} aria-label="Close">\u2715</button>
        </div>

        {phase === "pair" && (
          <div style={{ textAlign: "center" }}>
            <svg width="200" height="120" viewBox="0 0 200 120" style={{ margin: "0 auto 18px", display: "block" }}>
              <rect x="45" y="8" width="110" height="72" rx="10" fill="var(--panel-2)" stroke="var(--line)" strokeWidth="2"/>
              <rect x="55" y="18" width="50" height="32" rx="4" fill="var(--panel)" stroke="var(--line)" strokeWidth="1.5"/>
              <circle cx="72" cy="28" r="3" fill="var(--brand)"/>
              <circle cx="82" cy="28" r="3" fill="var(--brand)"/>
              <circle cx="92" cy="28" r="3" fill="var(--brand)"/>
              <circle cx="72" cy="38" r="3" fill="var(--brand)"/>
              <circle cx="82" cy="38" r="3" fill="var(--accent)"/>
              <circle cx="92" cy="38" r="3" fill="var(--brand)"/>
              <rect x="55" y="55" width="90" height="16" rx="3" fill="var(--panel-2)" stroke="var(--line)" strokeWidth="1"/>
              <text x="100" y="108" textAnchor="middle" fill="var(--muted)" fontSize="11" fontFamily="system-ui">micro:bit</text>
            </svg>
            <p style={{ fontSize: 15, lineHeight: 1.5, margin: "0 0 18px", color: "var(--muted)" }}>
              Click below to pair your micro:bit. This only happens once — after that, flashing is one click.
            </p>
            <button className="btn lg" onClick={handlePair}>Pair Device \u2192</button>
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              Works in Chrome or Edge. Use Save to micro:bit for other browsers.
            </p>
          </div>
        )}

        {phase === "flashing" && (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <div className="pulsebar">
              <span className="pulsedot" /> Flashing {program.name}…
            </div>
            <div style={{
              height: 8, borderRadius: 4, background: "var(--panel-2)",
              border: "1.5px solid var(--line)", overflow: "hidden", marginBottom: 12,
            }}>
              <div style={{
                height: "100%", borderRadius: 4,
                background: "linear-gradient(90deg, var(--brand), var(--brand-2))",
                width: Math.max(2, Math.round((progress.current / Math.max(progress.total, 1)) * 100)) + "%",
                transition: "width .15s ease",
              }} />
            </div>
            <p className="muted" style={{ fontSize: 13 }}>
              {Math.round(progress.current / 1024)} / {Math.round(progress.total / 1024)} KB
            </p>
          </div>
        )}

        {phase === "done" && (
          <div className="success-burst" style={{ textAlign: "center" }}>
            <div className="ring">\u2713</div>
            <p style={{ fontSize: 15, margin: "12px 0" }}>
              <b>{program.name}</b> is on your micro:bit!<br />
              Look at the LEDs.
            </p>
            <div className="row" style={{ gap: 10, justifyContent: "center" }}>
              <button className="btn" onClick={() => { if (onDashboard) onDashboard(); onDone(); }}>
                View Dashboard \u2192
              </button>
              <button className="btn ghost" onClick={onDone}>Flash Another \u2192</button>
            </div>
          </div>
        )}

        {phase === "error" && (
          <div style={{ textAlign: "center" }}>
            <p className="err" style={{ fontSize: 15, marginBottom: 18 }}>
              {errMsg}
            </p>
            <div className="row" style={{ gap: 10, justifyContent: "center" }}>
              <button className="btn" onClick={() => hexBlob && startFlash(hexBlob)}>Try Again \u2192</button>
              <button className="btn ghost"
                onClick={() => downloadHex(program.id, program.name)}>
                \u2193 Download .hex instead
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}'''

if old_dh_end in c:
    c = c.replace(old_dh_end, new_dh_end)
    changes += 1
    print('WebhidFlashOverlay: component added')
else:
    print('ERROR: downloadHex end not found')

# ── Modify Catalog .hex buttons ────────────────────────────────────────
old_hex_btns = '''        {(profile && profile.deploy && profile.deploy.programFormat === ".hex") || (selected && selected.format === ".hex") ? (
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
        ) : ('''

new_hex_btns = '''        {(profile && profile.deploy && profile.deploy.programFormat === ".hex") || (selected && selected.format === ".hex") ? (
          <div className="row" style={{ gap: 8 }}>
            {navigator.hid ? (
              <button className="btn" disabled={!selected}
                onClick={() => selected && setOverlay(selected)}>
                Flash with FunConnect →
              </button>
            ) : null}
            <button className="btn ghost" disabled={!selected}
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
        ) : ('''

if old_hex_btns in c:
    c = c.replace(old_hex_btns, new_hex_btns)
    changes += 1
    print('Catalog: WebHID + MSD buttons added')
else:
    print('ERROR: catalog hex buttons not found')

with open(path, 'w', encoding='utf-8') as f:
    f.write(c)
print(f'Total: {changes} changes')
