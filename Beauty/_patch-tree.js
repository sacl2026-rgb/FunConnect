// Tree-structured cascade tripwires
const fs = require('fs');
const path = require('path');

// 1. Rewrite webusb-flash.js to return { ok, tree } with nested children
let f = fs.readFileSync(path.join(__dirname, 'src', 'webusb-flash.js'), 'utf8');

// Wrap the existing function to return structured result
const oldExport = `export async function flashViaWebUSB(hexBlob, onProgress) {`;
const newExport = `function flashWebUSBInternal(hexBlob) {`;
f = f.replace(oldExport, newExport);

// At the end of the file, add the tree-building wrapper
const oldFooter = `    try { if (d) d.close(); } catch (e2) {}\n    return false;\n  }\n}`;
// Remove onProgress calls from internal
f = f.replace(/if\(onProgress\)onProgress\([^)]+\);?/g, '');
// Replace end with wrapper
const wrapper = `}
export async function flashViaWebUSB(hexBlob) {
  var tree = { label: "WebUSB flash", ok: null, children: [] };
  function add(ok, label) { tree.children.push({ label: label, ok: ok, children: [] }); }
  try {
    var deviceFound = false, hexParsed = false, dapjsLoaded = false, transportOk = false, connected = false;
    var d = null;
    var ds = await navigator.usb.getDevices();
    d = ds.find(function(x) { return x.vendorId === 0x0D28; });
    if (!d) d = await navigator.usb.requestDevice({ filters: [{ vendorId: 0x0D28 }] });
    await d.open();
    deviceFound = true; add(true, "Device found");
    var t = await hexBlob.text();
    var bin = parseIntelHex(t);
    hexParsed = true; add(true, "Hex parsed — " + (bin.length / 1024).toFixed(0) + " KB");
    if (bin.length === 0) { tree.ok = false; add(false, "Empty binary"); await d.close(); return { ok: false, tree: tree }; }
    if (!window.dapjs) {
      await new Promise(function(ok, fail) {
        var s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/dapjs@2.3.0/dist/dap.umd.min.js';
        s.onload = ok; s.onerror = function() { fail(new Error('DAP.js load failed')); };
        document.head.appendChild(s);
      });
    }
    dapjsLoaded = true; add(true, "DAP.js loaded");
    await d.close(); await new Promise(function(r){setTimeout(r,200)}); await d.open();
    var transport = new window.DAPjs.WebUSB(d);
    transportOk = true; add(true, "Transport created");
    var dl = new window.DAPjs.DAPLink(transport);
    await Promise.race([dl.connect().then(function(){connected=true}), new Promise(function(_,r){setTimeout(function(){r(new Error("connect timeout"))},8000)})]);
    if (connected) {
      add(true, "CMSIS-DAP connected");
      await dl.flash(bin.buffer);
      add(true, "Flash complete!");
      await dl.disconnect();
      await d.close();
      tree.ok = true;
      return { ok: true, tree: tree };
    } else {
      add(false, "connect() timeout — DAPLink v0257 buffer desync");
      if (d) try { d.close(); } catch(e3) {}
      tree.ok = false;
      return { ok: false, tree: tree };
    }
  } catch (e) {
    tree.ok = false;
    if (e.name !== "AbortError" && e.name !== "NotFoundError") add(false, (e.message || String(e)));
    try { if (d) d.close(); } catch(e3) {}
    return { ok: false, tree: tree };
  }
}`;
f = f.replace(oldFooter, wrapper);
fs.writeFileSync(path.join(__dirname, 'src', 'webusb-flash.js'), f);
console.log('webusb-flash.js: tree-structured');

// 2. Rewrite saveHexToMicrobit to build tree
let a = fs.readFileSync(path.join(__dirname, 'src', 'app.jsx'), 'utf8');
const sfStart = 'async function saveHexToMicrobit(hexUrl, suggestedName = "relay.hex", onProgress = null) {';
const sfEnd = 'async function downloadHex(programId, programName) {';
const sfIdx = a.indexOf(sfStart);
const sfEndIdx = a.indexOf(sfEnd);

const newSF = `async function saveHexToMicrobit(hexUrl, suggestedName, onProgress) {
  suggestedName = suggestedName || "relay.hex";
  var tree = { label: "Flash with FunConnect", ok: null, children: [] };
  var url = hexUrl || API_BASE + "/api/microbit/relay.hex";
  var hexBlob;

  // Fetch
  var fetchNode = { label: "Fetch firmware", ok: null, children: [] };
  try {
    var resp = await fetch(url);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    hexBlob = await resp.blob();
    fetchNode.ok = true; fetchNode.children.push({ label: "Downloaded — " + (hexBlob.size / 1024).toFixed(0) + " KB", ok: true });
  } catch (e) {
    fetchNode.ok = false; fetchNode.children.push({ label: "Failed — " + (e.message || e), ok: false });
    tree.children.push(fetchNode);
    if (onProgress) onProgress(tree);
    return;
  }
  tree.children.push(fetchNode);

  // MSD
  var msdNode = { label: "MSD flash (file save)", ok: null, children: [] };
  try {
    msdNode.children.push({ label: "Opening file save dialog...", ok: null });
    var handle = await window.showSaveFilePicker({ suggestedName: suggestedName, startIn: "documents", types: [{ description: "Firmware", accept: { "application/octet-stream": [".hex"] } }] });
    msdNode.children.push({ label: "Dialog opened", ok: true });
    var writable = await handle.createWritable();
    msdNode.children.push({ label: "Writable created", ok: true });
    await writable.write(hexBlob);
    msdNode.children.push({ label: "Write complete", ok: true });
    await writable.close();
    msdNode.ok = true;
    tree.children.push(msdNode);
    tree.ok = true;
    if (onProgress) onProgress(tree);
    return;
  } catch (e) {
    if (e.name === "AbortError") {
      msdNode.children.push({ label: "Cancelled by user", ok: false });
    } else {
      msdNode.children.push({ label: "Unavailable — " + (e.message || e), ok: false });
    }
    msdNode.ok = false;
    tree.children.push(msdNode);
  }

  // WebUSB
  var wResult = await flashViaWebUSB(hexBlob);
  tree.children.push(wResult.tree);
  if (wResult.ok) { tree.ok = true; if (onProgress) onProgress(tree); return; }

  // Download fallback
  var dlNode = { label: "Download fallback", ok: null, children: [] };
  var objectUrl = URL.createObjectURL(hexBlob);
  var a2 = document.createElement("a"); a2.href = objectUrl; a2.download = suggestedName; a2.click();
  setTimeout(function() { URL.revokeObjectURL(objectUrl); }, 1000);
  dlNode.ok = true; dlNode.children.push({ label: "Firmware file downloaded", ok: true });
  tree.children.push(dlNode);
  tree.ok = true;
  if (onProgress) onProgress(tree);
}

`;

a = a.slice(0, sfIdx) + newSF + a.slice(sfEndIdx);
fs.writeFileSync(path.join(__dirname, 'src', 'app.jsx'), a);
console.log('app.jsx: tree-structured saveHexToMicrobit');

// 3. Update Catalog render to show tree recursively
// Find the flashProgress render and replace with tree render
const treeRenderOld = `{flashProgress && flashProgress.length > 0 && (
              <div style={{ marginTop: 10, background: "var(--panel-2)", border: "1px solid var(--line)", borderRadius: 10, padding: "10px 14px", fontSize: 13 }}>
                {flashProgress.map(function(p, i) { return (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", color: p.ok === false ? "var(--bad)" : p.ok === true ? "var(--brand)" : "var(--muted)" }}>
                    <span>{p.ok === true ? "✓" : p.ok === false ? "✕" : "·"}</span>
                    <span>{p.label}</span>
                  </div>
                ); })}
              </div>
            )}`;

const treeRenderNew = `{flashProgress && flashProgress.children && flashProgress.children.length > 0 && (
              <div style={{ marginTop: 10, background: "var(--panel-2)", border: "1px solid var(--line)", borderRadius: 10, padding: "10px 14px", fontSize: 13, fontFamily: "ui-monospace, Menlo, monospace", maxHeight: 400, overflow: "auto" }}>
                {function renderNode(n, depth) {
                  depth = depth || 0;
                  var pad = "  ".repeat(depth);
                  return [
                    React.createElement("div", { key: n.label, style: { display: "flex", alignItems: "center", gap: 6, padding: "2px 0", color: n.ok === false ? "var(--bad)" : n.ok === true ? "var(--brand)" : "var(--muted)", paddingLeft: depth * 12 } },
                      React.createElement("span", null, n.ok === true ? "✓" : n.ok === false ? "✕" : "·"),
                      React.createElement("span", null, n.label)
                    )
                  ].concat((n.children || []).map(function(c) { return renderNode(c, depth + 1); }));
                }(flashProgress)}
              </div>
            )}`;

a = a.replace(treeRenderOld, treeRenderNew);

// Also update the onClick to set a single tree object, not an array
a = a.replace(
  'onClick={() => { setFlashProgress([]); selected && saveHexToMicrobit(`${API_BASE}/api/catalog/${encodeURIComponent(selected.id)}`, `${selected.name}.hex`, function(p) { setFlashProgress(function(prev) { return (prev || []).concat([p]); }); }); }}',
  'onClick={() => { setFlashProgress(null); selected && saveHexToMicrobit(`${API_BASE}/api/catalog/${encodeURIComponent(selected.id)}`, `${selected.name}.hex`, function(tree) { setFlashProgress(tree); }); }}'
);

fs.writeFileSync(path.join(__dirname, 'src', 'app.jsx'), a);
console.log('Catalog: tree render');
