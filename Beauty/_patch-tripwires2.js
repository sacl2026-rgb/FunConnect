// Add tripwires between DAPjs constructor calls + rebuild Edge to pick up new SPA
const fs = require('fs');
const path = require('path');

// 1. Add tripwires in webusb-flash.js
const src = path.join(__dirname, 'src', 'webusb-flash.js');
let f = fs.readFileSync(src, 'utf8');

f = f.replace(
  'var dl;\\n    try {\\n      var transport = new window.DAPjs.WebUSB(d);\\n      dl = new window.DAPjs.DAPLink(transport);\\n    } catch(e2) {\\n      // WebUSB constructor may not exist — try direct device pass-through\\n      dl = new window.DAPjs.DAPLink(d);\\n    }',
  'if (onProgress) onProgress({ step: "ctor", label: "Creating DAPjs transport...", ok: null });\\n    var dl;\\n    try {\\n      var transport = new window.DAPjs.WebUSB(d);\\n      if (onProgress) onProgress({ step: "ctor", label: "Transport created", ok: true });\\n      dl = new window.DAPjs.DAPLink(transport);\\n    } catch(e2) {\\n      if (onProgress) onProgress({ step: "ctor", label: "WebUSB ctor failed, trying direct — " + (e2.message||e2), ok: null });\\n      dl = new window.DAPjs.DAPLink(d);\\n    }'
);

f = f.replace(
  '    await dl.connect();\\n    if (onProgress) onProgress({ step: "connect", label: "CMSIS-DAP connected", ok: true });',
  '    if (onProgress) onProgress({ step: "connecting", label: "Opening CMSIS-DAP link...", ok: null });\\n    await dl.connect();\\n    if (onProgress) onProgress({ step: "connect", label: "CMSIS-DAP connected", ok: true });'
);

fs.writeFileSync(src, f);
console.log('Tripwires added to webusb-flash.js');

// 2. Rebuild Beauty
const { execFileSync } = require('child_process');
execFileSync('node', [path.join(__dirname, 'build.js')], { stdio: 'inherit', cwd: __dirname });
