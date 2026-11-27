// PNG squeezer: lossless 1280x720 screenshot recompression.
// Strategy: per-image colour-type reduction (palette / grey / grey+alpha / RGB / RGBA,
// tRNS key when a single transparent value exists), per-row adaptive filter choice
// (fixed filters, min-sum, fewest-pairs, and brute force scored by real zlib cost),
// screened by zlib level 6, final encode at zlib level 9 trying several strategies.
// Deterministic: pure function of the input bytes; no clock, no randomness.
import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------- CRC-32 (PNG) ----------
const CRC_TABLE: Int32Array = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function pngOf(chunks: Array<[string, Uint8Array]>): Uint8Array {
  let size = 8;
  for (const [, d] of chunks) size += 12 + d.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let at = 8;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}
function ihdrOf(width: number, height: number, colourType: number): Uint8Array {
  const d = new Uint8Array(13);
  new DataView(d.buffer).setUint32(0, width);
  new DataView(d.buffer).setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

// ---------- PNG decode (to RGBA) ----------
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
function decodePng(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  if (bytes.length < 8) throw new Error('short file');
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) throw new Error('bad signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header: { width: number; height: number; colourType: number } | null = null;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) throw new Error('bad CRC ' + type);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), colourType: data[9] };
      if (data[8] !== 8 || data[12] !== 0) throw new Error('bad IHDR');
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') ended = true;
    else throw new Error('chunk ' + type);
  }
  if (!header || !ended || idat.length === 0) throw new Error('incomplete PNG');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  if (bpp === undefined) throw new Error('colour type ' + colourType);
  const stride = width * bpp;
  const expected = height * (stride + 1);
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  if (raw.length !== expected) throw new Error('inflate length ' + raw.length);
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++)
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    } else if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    } else throw new Error('filter ' + ft);
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    if (palette === null) throw new Error('palette missing');
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3]; lut[e * 4 + 1] = palette[e * 3 + 1]; lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) throw new Error('palette index');
      rgba[d] = lut[e * 4]; rgba[d + 1] = lut[e * 4 + 1]; rgba[d + 2] = lut[e * 4 + 2]; rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { width, height, rgba };
}

// ---------- analysis ----------
type Colour = { r: number; g: number; b: number; a: number; count: number; key: number };
function analyse(rgba: Uint8Array): { opaque: boolean; grey: boolean; colours: Colour[] | null } {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map<number, number>();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const k = ((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) >>> 0;
      const c = counts.get(k);
      if (c === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(k, 1);
      } else counts.set(k, c + 1);
    }
  }
  if (many) return { opaque, grey, colours: null };
  const colours: Colour[] = [];
  for (const [k, count] of counts) {
    colours.push({ r: (k >>> 24) & 0xff, g: (k >>> 16) & 0xff, b: (k >>> 8) & 0xff, a: k & 0xff, count, key: k });
  }
  return { opaque, grey, colours };
}
function transparentKey(rgba: Uint8Array, grey: boolean): number | null {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}
function samplesOf(rgba: Uint8Array, ct: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}
type Form = { colourType: number; bpp: number; samples: Uint8Array; plte: Uint8Array | null; trns: Uint8Array | null; filters: Array<number | string> };
function paletteForm(rgba: Uint8Array, colours: Colour[], order: string): Form {
  const lum = (c: Colour): number => 299 * c.r + 587 * c.g + 114 * c.b;
  const entries = [...colours].sort((x, y) => {
    const ta = x.a === 255 ? 1 : 0;
    const tb = y.a === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lum(x) - lum(y) || x.key - y.key;
    return y.count - x.count || x.key - y.key;
  });
  const index = new Map<number, number>(entries.map((c, i) => [c.key, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r; plte[i * 3 + 1] = c.g; plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const k = ((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) >>> 0;
    indices[i] = index.get(k) as number;
  }
  return { colourType: 3, bpp: 1, samples: indices, plte, trns, filters: ['count', 'luminance'].includes(order) ? [0, 'minsum', 'brute'] : [0] };
}
function formsOf(rgba: Uint8Array): Form[] {
  const { opaque, grey, colours } = analyse(rgba);
  const forms: Form[] = [];
  if (colours !== null) {
    forms.push(paletteForm(rgba, colours, 'count'));
    forms.push(paletteForm(rgba, colours, 'luminance'));
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct: number;
  let trns: Uint8Array | null = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct] as number;
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: [0, 1, 2, 3, 4, 'minsum', 'pairs', 'brute'] });
  return forms;
}

// ---------- filtering ----------
function filterRow(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}
function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}
const BRUTE_CONTEXT = 32768;
function filtered(samples: Uint8Array, width: number, height: number, bpp: number, choice: number | string): Uint8Array {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial: Uint8Array[] = [];
  for (let t = 0; t < 5; t++) trial.push(new Uint8Array(stride));
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t]);
      let cost: number;
      if (choice === 'minsum') cost = signedSum(trial[t]);
      else if (choice === 'pairs') {
        let n = 0;
        stamp++;
        for (let i = 1; i < trial[t].length; i++) {
          const pair = (trial[t][i - 1] << 8) | trial[t][i];
          if (seen[pair] !== stamp) { seen[pair] = stamp; n++; }
        }
        cost = n;
      } else {
        const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
        const row = new Uint8Array(stride + 1);
        row[0] = t;
        row.set(trial[t], 1);
        cost = deflateSync(row, before.length === 0 ? { level: 6, memLevel: 9 } : { level: 6, memLevel: 9, dictionary: before }).length;
      }
      if (cost < best) { best = cost; type = t; }
    }
    raw[at] = type;
    raw.set(trial[type], at + 1);
  }
  return raw;
}
const chunkBytes = (form: Form): number =>
  (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

// ---------- encode one image ----------
function encodeImage(rgba: Uint8Array, width: number, height: number): Uint8Array {
  // Screen all forms/filter choices at zlib level 6, remembering the winning
  // (form, choice) and its already-filtered bytes (re-filtering the winner
  // would repeat the most expensive filter pass, e.g. brute); then encode
  // the winning bytes at level 9, best strategy.
  let win: { form: Form; choice: number | string; bytes: number } | null = null;
  let winData: Uint8Array | null = null;
  for (const form of formsOf(rgba)) {
    const chunks = chunkBytes(form);
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice);
      const zlib = deflateSync(data, { level: 6, memLevel: 8 });
      const bytes = zlib.length + chunks;
      if (win === null || bytes < win.bytes) { win = { form, choice, bytes }; winData = data; }
    }
  }
  if (win === null || winData === null) throw new Error('no form');
  const data = winData;
  // Final: my optimal-parsing deflate, with zlib level 9 as a safety net (take smaller).
  let bestZ = deflateOptimal(data);
  const z9 = deflateSync(data, { level: 9, memLevel: 9 });
  if (z9.length < bestZ.length) bestZ = new Uint8Array(z9.buffer, z9.byteOffset, z9.length);
  const chunks: Array<[string, Uint8Array]> = [['IHDR', ihdrOf(width, height, win.form.colourType)]];
  if (win.form.plte !== null) chunks.push(['PLTE', win.form.plte]);
  if (win.form.trns !== null) chunks.push(['tRNS', win.form.trns]);
  chunks.push(['IDAT', bestZ as Uint8Array]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// ---------- optimal-parsing DEFLATE (zopfli-style, written from the DEFLATE spec) ----------
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const LEN_SYM_OF: Int32Array = (() => {
  const t = new Int32Array(259);
  for (let L = 3; L <= 258; L++) {
    let lo = 0, hi = 28;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (LEN_BASE[mid] <= L) lo = mid; else hi = mid - 1; }
    t[L] = lo;
  }
  return t;
})();
const DIST_SYM_OF: Int32Array = (() => {
  const t = new Int32Array(32769);
  for (let D = 1; D <= 32768; D++) {
    let lo = 0, hi = 29;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (DIST_BASE[mid] <= D) lo = mid; else hi = mid - 1; }
    t[D] = lo;
  }
  return t;
})();
const FIXED_LITLEN: Uint8Array = (() => {
  const t = new Uint8Array(288);
  for (let i = 0; i < 288; i++) t[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
  return t;
})();
const FIXED_DISTLEN: Uint8Array = new Uint8Array(30).fill(5);
const MAX_CHAIN = 256;
const DEFLATE_BLOCK = 262144;

function adler32(bytes: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// Huffman code lengths from symbol frequencies, limited to maxLen bits
// (binary-heap tree + zlib's gen_bitlen overflow fix).
function huffmanLengths(freq: Int32Array, maxLen: number): Uint8Array {
  const n = freq.length;
  const lengths = new Uint8Array(n);
  const syms: number[] = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) syms.push(i);
  if (syms.length === 0) return lengths;
  if (syms.length === 1) { lengths[syms[0]] = 1; return lengths; }
  // Heap of tree nodes: node k holds freq[k], sym[k] (-1 internal), left/right child.
  const nf: number[] = [];
  const ns: number[] = [];
  const nl: number[] = [];
  const nr: number[] = [];
  const heap: number[] = [];
  const push = (node: number): void => {
    heap.push(node);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (nf[heap[p]] < nf[heap[i]] || (nf[heap[p]] === nf[heap[i]] && heap[p] < heap[i])) break;
      const t = heap[p]; heap[p] = heap[i]; heap[i] = t; i = p;
    }
  };
  const pop = (): number => {
    const top = heap[0];
    const last = heap.pop() as number;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heap.length && (nf[heap[l]] < nf[heap[m]] || (nf[heap[l]] === nf[heap[m]] && heap[l] < heap[m]))) m = l;
        if (r < heap.length && (nf[heap[r]] < nf[heap[m]] || (nf[heap[r]] === nf[heap[m]] && heap[r] < heap[m]))) m = r;
        if (m === i) break;
        const t = heap[m]; heap[m] = heap[i]; heap[i] = t; i = m;
      }
    }
    return top;
  };
  for (const s of syms) { nf.push(freq[s]); ns.push(s); nl.push(-1); nr.push(-1); push(nf.length - 1); }
  while (heap.length > 1) {
    const a = pop(), b = pop();
    nf.push(nf[a] + nf[b]); ns.push(-1); nl.push(a); nr.push(b); push(nf.length - 1);
  }
  const root = heap[0];
  const stack: Array<[number, number]> = [[root, 0]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop() as [number, number];
    if (ns[node] >= 0) lengths[ns[node]] = depth;
    else { stack.push([nl[node], depth + 1]); stack.push([nr[node], depth + 1]); }
  }
  const blCount = new Int32Array(maxLen + 1);
  for (const s of syms) {
    const l = lengths[s];
    if (l > maxLen) blCount[maxLen]++;
    else blCount[l]++;
  }
  // Clamping lengths to maxLen over-subscribes the code (Kraft sum > 1). Each
  // move (one code from length m to two at m+1, one code removed at maxLen)
  // lowers the Kraft sum by exactly 2^-maxLen, so the number of moves needed
  // is (Kraft - 1) * 2^maxLen, an integer.
  let total = 0;
  for (let l = 1; l <= maxLen; l++) total += blCount[l] * (2 ** (maxLen - l));
  let moves = total - (2 ** maxLen);
  while (moves > 0) {
    let m = maxLen - 1;
    while (m > 0 && blCount[m] === 0) m--;
    if (m === 0) break;
    blCount[m]--;
    blCount[m + 1] += 2;
    blCount[maxLen]--;
    moves--;
  }
  syms.sort((a, b) => freq[b] - freq[a] || a - b);
  let idx = 0;
  for (let len = 1; len <= maxLen; len++) {
    for (let k = 0; k < blCount[len]; k++) lengths[syms[idx++]] = len;
  }
  return lengths;
}
function canonicalCodes(lengths: Uint8Array): Int32Array {
  const codes = new Int32Array(lengths.length).fill(-1);
  let maxLen = 0;
  const blCount = new Int32Array(16);
  for (let i = 0; i < lengths.length; i++) {
    if (lengths[i] > maxLen) maxLen = lengths[i];
    if (lengths[i] > 0) blCount[lengths[i]]++;
  }
  const nextCode = new Int32Array(16);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) { code = (code + blCount[bits - 1]) << 1; nextCode[bits] = code; }
  for (let i = 0; i < lengths.length; i++) {
    const l = lengths[i];
    if (l > 0) codes[i] = nextCode[l]++;
  }
  return codes;
}
class BitWriter {
  buf: Uint8Array;
  pos = 0;
  acc = 0;
  nbits = 0;
  constructor(cap: number) { this.buf = new Uint8Array(cap); }
  ensure(n: number): void {
    if (this.pos + n + 16 > this.buf.length) {
      const nb = new Uint8Array(this.buf.length * 2 + 1024);
      nb.set(this.buf.subarray(0, this.pos));
      this.buf = nb;
    }
  }
  write(code: number, len: number): void {
    this.acc += code * (2 ** this.nbits);
    this.nbits += len;
    while (this.nbits >= 8) {
      this.ensure(1);
      this.buf[this.pos++] = this.acc % 256;
      this.acc = Math.floor(this.acc / 256);
      this.nbits -= 8;
    }
  }
  // Huffman codes are packed most-significant bit first (RFC 1951), unlike
  // data elements (extra bits, headers) which go least-significant bit first.
  writeCode(code: number, len: number): void {
    let rev = 0;
    for (let i = 0; i < len; i++) rev = (rev << 1) | ((code >> i) & 1);
    this.write(rev, len);
  }
  writeByte(b: number): void {
    this.ensure(1);
    this.buf[this.pos++] = b;
  }
  flush(): void {
    if (this.nbits > 0) { this.ensure(1); this.buf[this.pos++] = this.acc % 256; this.acc = 0; this.nbits = 0; }
  }
}

type Matches = { mLen: Uint16Array; mDist: Int32Array; mLen2: Uint16Array; mDist2: Int32Array };
function findMatches(data: Uint8Array): Matches {
  const N = data.length;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const matchLen = (a: number, b: number, maxLen: number): number => {
    let len = 0;
    while (len + 4 <= maxLen) {
      if (dv.getUint32(a + len, true) !== dv.getUint32(b + len, true)) break;
      len += 4;
    }
    while (len < maxLen && data[a + len] === data[b + len]) len++;
    return len;
  };
  const head = new Int32Array(65536).fill(-1);
  const prev = new Int32Array(N);
  const mLen = new Uint16Array(N);
  const mDist = new Int32Array(N);
  const mLen2 = new Uint16Array(N);
  const mDist2 = new Int32Array(N);
  const hashAt = (i: number): number =>
    (Math.imul(((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]), 2654435761) >>> 16) & 0xffff;
  for (let i = 0; i + 2 < N; i++) {
    const h = hashAt(i);
    let cur = head[h];
    const maxLen = Math.min(258, N - i);
    let bestLen = 0, bestDist = 0, nearLen = 0, nearDist = 0;
    let chain = 0;
    // Deep chain walk, but once a good match (>= 32) is found, cap the
    // remaining walk (zlib's good_length rule).
    while (cur !== -1 && chain < (bestLen >= 32 ? 256 : MAX_CHAIN)) {
      const dist = i - cur;
      if (dist > 32768) break;
      chain++;
      if (bestLen < maxLen && (bestLen === 0 || data[cur + bestLen] === data[i + bestLen])) {
        const len = matchLen(cur, i, maxLen);
        if (len > bestLen) { bestLen = len; bestDist = dist; }
        if (dist <= 1024 && len > nearLen) { nearLen = len; nearDist = dist; }
      } else if (dist <= 1024 && nearLen < maxLen && (nearLen === 0 || data[cur + nearLen] === data[i + nearLen])) {
        const len = matchLen(cur, i, maxLen);
        if (len > nearLen) { nearLen = len; nearDist = dist; }
      }
      // Exact early exit: bestLen is maxed (no candidate can beat it), and
      // nearLen is final too — remaining candidates are farther than this
      // one, so if this one was within 1024 nearLen is already maxed, and if
      // it was beyond 1024 no later candidate can be a near candidate.
      if (bestLen >= maxLen) break;
      cur = prev[cur];
    }
    mLen[i] = bestLen; mDist[i] = bestDist; mLen2[i] = nearLen; mDist2[i] = nearDist;
    prev[i] = head[h];
    head[h] = i;
  }
  return { mLen, mDist, mLen2, mDist2 };
}
// The better of the two candidates at position i, clamped to the block end.
function bestAt(M: Matches, i: number, be: number): [number, number] {
  const maxL = be - i;
  let len = M.mLen[i];
  let dist = M.mDist[i];
  if (len > maxL) len = maxL;
  let len2 = M.mLen2[i];
  let dist2 = M.mDist2[i];
  if (len2 > maxL) len2 = maxL;
  if (len2 > len || (len2 === len && len2 > 0 && dist2 < dist)) { len = len2; dist = dist2; }
  return [len, dist];
}
type Op = { lit: number } | { len: number; dist: number };
function isMatch(op: Op): op is { len: number; dist: number } {
  return (op as { len: number }).len !== undefined;
}
function freqOfOps(ops: Op[]): { lit: Int32Array; dist: Int32Array } {
  const lit = new Int32Array(288);
  const dist = new Int32Array(32);
  for (const op of ops) {
    if (isMatch(op)) {
      lit[257 + LEN_SYM_OF[op.len]]++;
      dist[DIST_SYM_OF[op.dist]]++;
    } else lit[op.lit]++;
  }
  lit[256]++;
  return { lit, dist };
}
function lazyFreq(data: Uint8Array, bs: number, be: number, M: Matches): { lit: Int32Array; dist: Int32Array } {
  const lit = new Int32Array(288);
  const dist = new Int32Array(32);
  let i = bs;
  while (i < be) {
    const [len, dd] = bestAt(M, i, be);
    if (len >= 3) {
      const [len1] = i + 1 < be ? bestAt(M, i + 1, be) : [0, 0];
      if (len1 > len) { lit[data[i]]++; i++; continue; }
      lit[257 + LEN_SYM_OF[len]]++;
      dist[DIST_SYM_OF[dd]]++;
      i += len;
    } else { lit[data[i]]++; i++; }
  }
  lit[256]++;
  return { lit, dist };
}
function dpParse(data: Uint8Array, bs: number, be: number, litLen: Uint8Array, distLen: Uint8Array, M: Matches): Op[] {
  const blen = be - bs;
  const litCost = new Int32Array(256);
  for (let b = 0; b < 256; b++) litCost[b] = litLen[b];
  const lenCost = new Int32Array(259);
  for (let L = 3; L <= 258; L++) lenCost[L] = litLen[257 + LEN_SYM_OF[L]] + LEN_EXTRA[LEN_SYM_OF[L]];
  const distCost = new Int32Array(32769);
  for (let D = 1; D <= 32768; D++) distCost[D] = distLen[DIST_SYM_OF[D]] + DIST_EXTRA[DIST_SYM_OF[D]];
  const INF = 1 << 30;
  const dp = new Int32Array(blen + 1).fill(INF);
  const chLen = new Int16Array(blen + 1);
  const chDist = new Int32Array(blen + 1);
  dp[0] = 0;
  for (let i = 0; i < blen; i++) {
    const base = dp[i];
    if (base === INF) continue;
    const pos = bs + i;
    const lc = base + litCost[data[pos]];
    if (lc < dp[i + 1]) { dp[i + 1] = lc; chLen[i + 1] = 0; }
    const rem = blen - i;
    let L = M.mLen[pos];
    if (L > rem) L = rem;
    if (L >= 3) {
      const c = base + lenCost[L] + distCost[M.mDist[pos]];
      if (c < dp[i + L]) { dp[i + L] = c; chLen[i + L] = L; chDist[i + L] = M.mDist[pos]; }
    }
    let L2 = M.mLen2[pos];
    if (L2 > rem) L2 = rem;
    if (L2 >= 3) {
      const c = base + lenCost[L2] + distCost[M.mDist2[pos]];
      if (c < dp[i + L2]) { dp[i + L2] = c; chLen[i + L2] = L2; chDist[i + L2] = M.mDist2[pos]; }
    }
  }
  const rev: Op[] = [];
  let i = blen;
  while (i > 0) {
    const L = chLen[i];
    if (L === 0) { rev.push({ lit: data[bs + i - 1] }); i -= 1; }
    else { rev.push({ len: L, dist: chDist[i] }); i -= L; }
  }
  rev.reverse();
  return rev;
}
function fixDistLen(distLen: Uint8Array): void {
  for (let i = 0; i < 30; i++) if (distLen[i] > 0) return;
  distLen[0] = 1;
}
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
function emitBlock(bw: BitWriter, ops: Op[], litLen: Uint8Array, distLen: Uint8Array, final: boolean): void {
  // Data bits under dynamic lengths and under fixed lengths.
  let dynBits = 0;
  let fixBits = 0;
  for (const op of ops) {
    if (isMatch(op)) {
      const li = LEN_SYM_OF[op.len];
      const di = DIST_SYM_OF[op.dist];
      dynBits += litLen[257 + li] + LEN_EXTRA[li] + distLen[di] + DIST_EXTRA[di];
      fixBits += FIXED_LITLEN[257 + li] + LEN_EXTRA[li] + 5 + DIST_EXTRA[di];
    } else {
      dynBits += litLen[op.lit];
      fixBits += FIXED_LITLEN[op.lit];
    }
  }
  dynBits += litLen[256];
  fixBits += FIXED_LITLEN[256];
  // Dynamic header cost.
  let hlit = 257;
  for (let i = 287; i >= 257; i--) if (litLen[i] > 0) { hlit = i + 1; break; }
  let hdist = 1;
  for (let i = 29; i >= 0; i--) if (distLen[i] > 0) { hdist = i + 1; break; }
  const seqLen = hlit + hdist;
  const seq = new Uint8Array(seqLen);
  seq.set(litLen.subarray(0, hlit), 0);
  seq.set(distLen.subarray(0, hdist), hlit);
  type Item = { sym: number; extra: number };
  const items: Item[] = [];
  let i = 0;
  while (i < seqLen) {
    if (seq[i] === 0) {
      let j = i;
      while (j < seqLen && seq[j] === 0) j++;
      let count = j - i;
      while (count >= 11) { const k = Math.min(count, 138); items.push({ sym: 18, extra: k - 11 }); count -= k; }
      while (count >= 3) { const k = Math.min(count, 10); items.push({ sym: 17, extra: k - 3 }); count -= k; }
      while (count > 0) { items.push({ sym: 0, extra: 0 }); count--; }
      i = j;
    } else {
      const v = seq[i];
      let j = i + 1;
      while (j < seqLen && seq[j] === v) j++;
      items.push({ sym: v, extra: 0 });
      let count = j - i - 1;
      while (count >= 3) { const k = Math.min(count, 6); items.push({ sym: 16, extra: k - 3 }); count -= k; }
      while (count > 0) { items.push({ sym: v, extra: 0 }); count--; }
      i = j;
    }
  }
  const clFreq = new Int32Array(19);
  for (const it of items) clFreq[it.sym]++;
  const clLen = huffmanLengths(clFreq, 7);
  let hclen = 4;
  for (let k = 18; k >= 4; k--) if (clLen[CL_ORDER[k]] > 0) { hclen = k + 1; break; }
  const CL_EXTRA: Record<number, number> = { 16: 2, 17: 3, 18: 7 };
  let headerBits = 5 + 5 + 4 + 3 * hclen;
  for (const it of items) headerBits += clLen[it.sym] + (CL_EXTRA[it.sym] ?? 0);
  const dynTotal = 3 + headerBits + dynBits;
  const fixTotal = 3 + fixBits;
  if (fixTotal <= dynTotal) {
    bw.write((1 << 1) | (final ? 1 : 0), 3);
    const litCode = canonicalCodes(FIXED_LITLEN);
    for (const op of ops) {
      if (isMatch(op)) {
        const li = LEN_SYM_OF[op.len];
        const di = DIST_SYM_OF[op.dist];
        bw.writeCode(litCode[257 + li], FIXED_LITLEN[257 + li]);
        if (LEN_EXTRA[li] > 0) bw.write(op.len - LEN_BASE[li], LEN_EXTRA[li]);
        bw.writeCode(di, 5);
        if (DIST_EXTRA[di] > 0) bw.write(op.dist - DIST_BASE[di], DIST_EXTRA[di]);
      } else {
        bw.writeCode(litCode[op.lit], FIXED_LITLEN[op.lit]);
      }
    }
    bw.writeCode(litCode[256], FIXED_LITLEN[256]);
    return;
  }
  bw.write((2 << 1) | (final ? 1 : 0), 3);
  bw.write(hlit - 257, 5);
  bw.write(hdist - 1, 5);
  bw.write(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) bw.write(clLen[CL_ORDER[k]], 3);
  const clCode = canonicalCodes(clLen);
  for (const it of items) {
    bw.writeCode(clCode[it.sym], clLen[it.sym]);
    if (CL_EXTRA[it.sym] !== undefined) bw.write(it.extra, CL_EXTRA[it.sym]);
  }
  const litCode = canonicalCodes(litLen);
  const distCode = canonicalCodes(distLen);
  for (const op of ops) {
    if (isMatch(op)) {
      const li = LEN_SYM_OF[op.len];
      const di = DIST_SYM_OF[op.dist];
      bw.writeCode(litCode[257 + li], litLen[257 + li]);
      if (LEN_EXTRA[li] > 0) bw.write(op.len - LEN_BASE[li], LEN_EXTRA[li]);
      bw.writeCode(distCode[di], distLen[di]);
      if (DIST_EXTRA[di] > 0) bw.write(op.dist - DIST_BASE[di], DIST_EXTRA[di]);
    } else {
      bw.writeCode(litCode[op.lit], litLen[op.lit]);
    }
  }
  bw.writeCode(litCode[256], litLen[256]);
}
function deflateOptimal(data: Uint8Array): Uint8Array {
  const N = data.length;
  const M = findMatches(data);
  const bw = new BitWriter(N + 65536);
  bw.writeByte(0x78);
  bw.writeByte(0xda);
  let bs = 0;
  while (bs < N) {
    const be = Math.min(N, bs + DEFLATE_BLOCK);
    const final = be === N;
    const f0 = lazyFreq(data, bs, be, M);
    let litLen = huffmanLengths(f0.lit, 15);
    let distLen = huffmanLengths(f0.dist, 15);
    fixDistLen(distLen);
    let ops = dpParse(data, bs, be, litLen, distLen, M);
    const f1 = freqOfOps(ops);
    litLen = huffmanLengths(f1.lit, 15);
    distLen = huffmanLengths(f1.dist, 15);
    fixDistLen(distLen);
    ops = dpParse(data, bs, be, litLen, distLen, M);
    const f2 = freqOfOps(ops);
    const litLenE = huffmanLengths(f2.lit, 15);
    const distLenE = huffmanLengths(f2.dist, 15);
    fixDistLen(distLenE);
    emitBlock(bw, ops, litLenE, distLenE, final);
    bs = be;
  }
  bw.flush();
  const adler = adler32(data);
  bw.writeByte((adler >>> 24) & 0xff);
  bw.writeByte((adler >>> 16) & 0xff);
  bw.writeByte((adler >>> 8) & 0xff);
  bw.writeByte(adler & 0xff);
  return bw.buf.subarray(0, bw.pos);
}

// ---------- main ----------
for (const ent of readdirSync(INPUT_DIR, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
  if (!ent.isDirectory()) continue;
  const id = ent.name;
  const image = decodePng(new Uint8Array(readFileSync(join(INPUT_DIR, id, 'image.png'))));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), encodeImage(image.rgba, image.width, image.height));
}
