// Write webusb-flash.js and patch app.jsx — timeout-wrapped tripwires
const fs = require('fs');
const path = require('path');

// ---- webusb-flash.js ----
const webusb = `// WebUSB flash via DAP.js + nrf-intel-hex. Timeout-wrapped tripwires.
import pkg from "nrf-intel-hex"; var MemoryMap = pkg.default || pkg;

function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise(function(_, r) { setTimeout(function() { r(new Error(label + " timeout after " + (ms/1000) + "s")); }, ms); })
  ]);
}

export async function flashViaWebUSB(hexBlob) {
  var tree = { label: "WebUSB flash", status: "in-progress", children: [] };
  function add(status, label) { tree.children.push({ label: label, status: status }); }

  if (typeof navigator === "undefined" || !navigator.usb) {
    tree.status = "failed"; add("failed", "WebUSB not available"); return tree;
  }
  var d = null;
  try {
    // Device
    var ds = await withTimeout(navigator.usb.getDevices(), 3000, "getDevices");
    d = ds.find(function(x) { return x.vendorId === 0x0D28; });
    if (!d) d = await navigator.usb.requestDevice({ filters: [{ vendorId: 0x0D28 }] });
    await withTimeout(d.open(), 5000, "device.open");
    add("done", "Device found");

    // Hex parse
    var t = await hexBlob.text();
    t = t.split(/[\r\n]+/).filter(function(l) { return l.length < 9 || parseInt(l.slice(7,9),16) <= 5; }).join('\n');
    var memMap = MemoryMap.fromHex(t);
    var joined = memMap.join();
    var largestEntry = null, largestSize = 0;
    joined.forEach(function(data, addr) { if (data.length > largestSize) { largestSize = data.length; largestEntry = data; } });
    if (!largestEntry || largestEntry.length === 0) { add("failed", "Empty binary"); tree.status = "failed"; await d.close(); return tree; }
    add("done", "Parsed — " + Math.round(largestEntry.length / 1024) + " KB");

    // DAP.js
    if (!window.DAPjs) {
      await withTimeout(new Promise(function(ok, fail) {
        var s = document.createElement("script");
        s.src = "https://cdn.jsdelivr.net/npm/dapjs@2.3.0/dist/dap.umd.min.js";
        s.onload = ok; s.onerror = function() { fail(new Error("DAP.js load failed")); };
        document.head.appendChild(s);
      }), 10000, "DAP.js CDN");
    }
    add("done", "DAP.js loaded");

    // Connect
    var transport = new window.DAPjs.WebUSB(d);
    var daplink = new window.DAPjs.DAPLink(transport);
    try {
      await withTimeout(daplink.connect(), 8000, "connect");
      add("done", "CMSIS-DAP connected");
    } catch (ce) {
      add("failed", "connect() — " + (ce.message || "DAPLink v0257"));
      tree.status = "failed"; try { d.close(); } catch(e3) {} return tree;
    }

    // Flash
    await withTimeout(daplink.flash(largestEntry.buffer), 30000, "flash");
    add("done", "Flash complete");
    await daplink.disconnect();
    await d.close();
    tree.status = "done";
    return tree;
  } catch (e) {
    if (e.name === "AbortError" || e.name === "NotFoundError") { add("failed", "Cancelled"); tree.status = "failed"; return tree; }
    add("failed", (e.message || String(e)));
    tree.status = "failed";
    try { if (d) d.close(); } catch(e3) {}
    return tree;
  }
}`;
fs.writeFileSync(path.join(__dirname, 'src', 'webusb-flash.js'), webusb);
console.log('webusb-flash.js written');

// ---- app.jsx: rewrite saveHexToMicrobit ----
let a = fs.readFileSync(path.join(__dirname, 'src', 'app.jsx'), 'utf8');
const sfStart = 'async function saveHexToMicrobit(hexUrl, suggestedName = "relay.hex", onProgress = null) {';
const sfEnd = 'async function downloadHex(programId, programName) {';
const sfIdx = a.indexOf(sfStart);
const sfEndIdx = a.indexOf(sfEnd);

const newSF = `async function saveHexToMicrobit(hexUrl, suggestedName, onProgress) {
  suggestedName = suggestedName || "relay.hex";
  var tree = { label: "Flash with FunConnect", status: "in-progress", children: [] };
  if (onProgress) onProgress(tree);
  var url = hexUrl || API_BASE + "/api/microbit/relay.hex";
  var hexBlob;

  // Fetch
  var fetchNode = { label: "Fetch firmware", status: "in-progress", children: [] };
  tree.children.push(fetchNode); if (onProgress) onProgress(tree);
  try {
    var resp = await Promise.race([fetch(url), new Promise(function(_,r){setTimeout(function(){r(new Error("fetch timeout"))},10000)}]);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    hexBlob = await resp.blob();
    fetchNode.status = "done"; fetchNode.children.push({ label: "Downloaded — " + Math.round(hexBlob.size / 1024) + " KB", status: "done" });
  } catch (e) {
    fetchNode.status = "failed"; fetchNode.children.push({ label: "Failed — " + (e.message||e), status: "failed" });
    tree.status = "failed"; if (onProgress) onProgress(tree); return;
  }

  // WebUSB
  var wTree = await flashViaWebUSB(hexBlob);
  tree.children.push(wTree);
  if (wTree.status === "done") { tree.status = "done"; if (onProgress) onProgress(tree); return; }

  // MSD fallback
  var msdNode = { label: "MSD fallback", status: "in-progress", children: [] };
  tree.children.push(msdNode); if (onProgress) onProgress(tree);
  try {
    var handle = await window.showSaveFilePicker({ suggestedName: suggestedName, startIn: "documents", types: [{ description: "Firmware", accept: { "application/octet-stream": [".hex"] } }] });
    msdNode.children.push({ label: "Dialog opened", status: "done" });
    var writable = await handle.createWritable();
    msdNode.children.push({ label: "Writable created", status: "done" });
    await writable.write(hexBlob);
    msdNode.children.push({ label: "Write complete", status: "done" });
    await writable.close();
    msdNode.status = "done"; tree.status = "done"; if (onProgress) onProgress(tree); return;
  } catch (e) {
    msdNode.children.push({ label: (e.name==="AbortError"?"Cancelled":"Unavailable — "+(e.message||e)), status: "failed" });
    msdNode.status = "failed";
  }

  // Download fallback
  var dlNode = { label: "Download fallback", status: "in-progress", children: [] };
  tree.children.push(dlNode); if (onProgress) onProgress(tree);
  var objectUrl = URL.createObjectURL(hexBlob);
  var a2 = document.createElement("a"); a2.href = objectUrl; a2.download = suggestedName; a2.click();
  setTimeout(function() { URL.revokeObjectURL(objectUrl); }, 1000);
  dlNode.children.push({ label: "File saved", status: "done" });
  dlNode.status = "done"; tree.status = "done"; if (onProgress) onProgress(tree);
}`;

a = a.slice(0, sfIdx) + newSF + a.slice(sfEndIdx);

// Update Catalog onClick — immediate root tripwire
a = a.replace(
  "onClick={() => { setFlashProgress(null); selected && saveHexToMicrobit(",
  "onClick={() => { setFlashProgress({ label: \"Flash with FunConnect\", status: \"in-progress\", children: [{ label: \"Fetch firmware\", status: \"in-progress\", children: [] }]}); selected && saveHexToMicrobit("
);

// Update render to use "status" instead of "ok"
a = a.replace(
  /n\.ok === false \? "var\(--bad\)" : n\.ok === true \? "var\(--brand\)" : "var\(--muted\)"/g,
  'n.status === "failed" ? "var(--bad)" : n.status === "done" ? "var(--brand)" : "var(--muted)"'
);
a = a.replace(
  /n\.ok === true \? "✓" : n\.ok === false \? "✕" : "·"/g,
  'n.status === "done" ? "✓" : n.status === "failed" ? "✕" : "·"'
);

fs.writeFileSync(path.join(__dirname, 'src', 'app.jsx'), a);
console.log('app.jsx patched');
