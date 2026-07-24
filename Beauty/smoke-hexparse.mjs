export function parseIntelHex(text) {
  const bytes = [];
  let extendedAddr = 0;
  for (const line of text.trim().split(/\r?\n/)) {
    if (!line.startsWith(':')) continue;
    const len = parseInt(line.slice(1, 3), 16);
    const addr = parseInt(line.slice(3, 7), 16);
    const type = parseInt(line.slice(7, 9), 16);
    if (type === 0x00) {
      const fullAddr = extendedAddr + addr;
      while (bytes.length < fullAddr + len) bytes.push(0xFF);
      for (let i = 0; i < len; i++)
        bytes[fullAddr + i] = parseInt(line.slice(9 + i * 2, 11 + i * 2), 16);
    } else if (type === 0x04) {
      extendedAddr = parseInt(line.slice(9, 13), 16) << 16;
    } else if (type === 0x01) {
      break; // EOF
    }
  }
  return new Uint8Array(bytes);
}

// Flash a .hex blob to micro:bit via HF2 over WebUSB.
// Returns true on success, false if unavailable or failed.
import { readFileSync } from 'node:fs'; import { dirname, resolve } from 'node:path'; import { fileURLToPath } from 'node:url'; const here = dirname(fileURLToPath(import.meta.url)); let pass=0,fail=0; function ok(n,c,d){if(c){pass++;console.log('  PASS '+n)}else{fail++;console.log('  FAIL '+n+(d?' -- '+d:''))}} const r=parseIntelHex(':100000000102030405060708090A0B0C0D0E0F10E4\n:00000001FF\n'); ok('16-byte data record',r.length===16); ok('first byte 0x01',r[0]===1); ok('last byte 0x10',r[15]===16); const e=parseIntelHex(':020000040001F9\n:10000000AA000000000000000000000000000000AA\n:00000001FF\n'); ok('extended addr length',e.length===65552); ok('byte at 0x10000',e[65536]===170); ok('empty input',parseIntelHex('').length===0); ok('non-hex ignored',parseIntelHex('; junk\n:10000000FF00000000000000000000000000000000\n:00000001FF\n').length===16); try{const hex=readFileSync(resolve(here,'../Edge/firmware-microbit-universal.hex'),'utf8');const bin=parseIntelHex(hex);ok('real universal hex',bin.length>100000,Math.round(bin.length/1024)+' KB')}catch(x){console.log('  SKIP real hex — '+x.message)} console.log((fail===0?'ALL GREEN':'FAILURES')+' — '+pass+' passed, '+fail+' failed');process.exit(fail===0?0:1)
