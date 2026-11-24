/**
 * make-icon.js — génère `build/icon.png` (256×256) pour electron-builder.
 *
 * Aucune dépendance image : PNG écrit à la main (IHDR + IDAT zlib +
 * CRC32 maison). Dessin : fond bleu nuit #1f3864, calendrier blanc
 * (anneaux, bandeau, grille 4×3, jour marqué), initiales « MT ».
 *
 * Usage : `node scripts/make-icon.js`
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const W = 256;
const H = 256;

const NAVY = [31, 56, 100]; // #1f3864
const WHITE = [255, 255, 255];

// --- Canevas RGBA ------------------------------------------------------------
const px = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) {
  px[i * 4] = NAVY[0];
  px[i * 4 + 1] = NAVY[1];
  px[i * 4 + 2] = NAVY[2];
  px[i * 4 + 3] = 255;
}

function set(x, y, c) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  px[i] = c[0];
  px[i + 1] = c[1];
  px[i + 2] = c[2];
  px[i + 3] = 255;
}

/** Test d'appartenance à un rectangle à coins arrondis (rayon r). */
function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
  const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function fillRect(x0, y0, x1, y1, c) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, c);
}

// --- Dessin du calendrier ----------------------------------------------------
const CX0 = 36;
const CY0 = 56;
const CX1 = 220;
const CY1 = 224;
const R = 14;
const T = 5; // épaisseur du contour
const BAND_BOTTOM = 100;

// Anneaux de reliure (dépassent au-dessus du corps).
fillRect(78, 44, 86, 64, WHITE);
fillRect(170, 44, 178, 64, WHITE);

for (let y = CY0 - 10; y <= CY1; y++) {
  for (let x = CX0 - 2; x <= CX1 + 2; x++) {
    const outer = inRoundedRect(x, y, CX0, CY0, CX1, CY1, R);
    if (!outer) continue;
    const inner = inRoundedRect(
      x,
      y,
      CX0 + T,
      CY0 + T,
      CX1 - T,
      CY1 - T,
      Math.max(R - T, 2),
    );
    if (y <= BAND_BOTTOM || !inner) set(x, y, WHITE);
  }
}

// Grille sous le bandeau : 4 colonnes × 3 lignes (trait 3 px).
const GX0 = CX0 + T; // 41
const GX1 = CX1 - T; // 215
const GY0 = BAND_BOTTOM + 5; // 105
const GY1 = CY1 - T; // 219
for (const cx of [84, 128, 172]) fillRect(cx - 1, GY0, cx + 1, GY1, WHITE);
for (const cy of [143, 181]) fillRect(GX0, cy - 1, GX1, cy + 1, WHITE);

// Jour marqué : cellule pleine (2e colonne, 2e ligne).
fillRect(88, 147, 124, 177, WHITE);

// --- Initiales « MT » (fonte bitmap 5×7, échelle 5) dans le bandeau ----------
const FONT = {
  M: [
    'X...X',
    'XX.XX',
    'X.X.X',
    'X.X.X',
    'X...X',
    'X...X',
    'X...X',
  ],
  T: [
    'XXXXX',
    '..X..',
    '..X..',
    '..X..',
    '..X..',
    '..X..',
    '..X..',
  ],
};
const SCALE = 5;
const GAP = 8;
const textW = 2 * 5 * SCALE + GAP; // 58
let gx = Math.round(128 - textW / 2);
const gy = Math.round(CY0 + (BAND_BOTTOM - CY0 - 7 * SCALE) / 2);
for (const ch of ['M', 'T']) {
  const glyph = FONT[ch];
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 5; col++) {
      if (glyph[row][col] !== 'X') continue;
      fillRect(
        gx + col * SCALE,
        gy + row * SCALE,
        gx + col * SCALE + SCALE - 1,
        gy + row * SCALE + SCALE - 1,
        NAVY,
      );
    }
  }
  gx += 5 * SCALE + GAP;
}

// --- Encodage PNG (CRC32 + chunks écrits à la main) ---------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // profondeur 8 bits
ihdr[9] = 6; // couleur RGBA
// [10..12] compression/filtre/entrelacement = 0

const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0; // filtre « None »
  px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'icon.png');
fs.writeFileSync(outFile, png);
console.log(`Icone ecrite : ${outFile} (${png.length} octets, ${W}x${H})`);
