// Remove duplicate function blocks from app.jsx
const fs = require('fs');
const path = require('path');
let a = fs.readFileSync(path.join(__dirname, 'src', 'app.jsx'), 'utf8');

// 1. Find the OLD saveHexToMicrobit (line 199, has default params in its signature)
const oldSF = '\n// the File System Access API to write directly to the micro:bit USB drive.\n// Falls back to a normal download link if showSaveFilePicker is unavailable.\nasync function saveHexToMicrobit(hexUrl, suggestedName, onProgress) {';
const oldSFend = 'async function downloadHex(programId, programName) {';

const sfStartIdx = a.indexOf(oldSF);
const sfEndIdx = a.indexOf(oldSFend, sfStartIdx);

if (sfStartIdx !== -1 && sfEndIdx !== -1) {
  // Remove from oldSF to just before downloadHex
  a = a.slice(0, sfStartIdx + 1) + a.slice(sfEndIdx);
  console.log('Removed old saveHexToMicrobit block');
} else {
  console.log('Old saveHexToMicrobit not found at expected position');
}

// 2. Find the DUPLICATE new block (inserted by patch script, ~line 2285)
const dupMarker = 'async function saveHexToMicrobit(hexUrl, suggestedName = "relay.hex", onProgress = null) {';
const dupIdx = a.indexOf(dupMarker);
if (dupIdx !== -1) {
  // Find matching closing of this new saveHexToMicrobit
  // Then find where the duplicate downloadHex starts
  const dupDl = a.indexOf('async function downloadHex(programId, programName) {', dupIdx);
  if (dupDl !== -1) {
    // Remove from dup saveHexToMicrobit to just before the REAL downloadHex
    const realDl = a.indexOf('async function downloadHex(programId, programName) {', dupDl + 10);
    if (realDl !== -1) {
      a = a.slice(0, dupIdx) + a.slice(realDl);
      console.log('Removed duplicate new block');
    }
  }
}

fs.writeFileSync(path.join(__dirname, 'src', 'app.jsx'), a);
console.log('Cleanup complete, length:', a.length);
