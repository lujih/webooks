#!/usr/bin/env node
/**
 * 生成站点图标（public/favicon.ico）。
 *
 * 为什么需要它（这是一个**请求预算**问题，不是装饰问题）：
 *   HTML 页面里没有 <link rel="icon"> 时，浏览器会替我们去请求 /favicon.ico。
 *   之前这个路径不存在，于是**每打开一个页面都多花一次 Worker 请求**换回 404。
 *   把图标放进 public/ 之后，这条请求由静态资源层直接应答 —— 官方明确
 *   「Requests to static assets are free and unlimited」，即不再计入
 *   那 100,000 次/天。
 *
 * 为什么用「开发期生成、产物提交进仓库」：
 *   与 scripts/gen-pinyin-table.mjs 同一套理由 —— 运行时零依赖。
 *   图标只有几百字节，没必要为它引入任何构建期图像库；
 *   这里只用 Node 内置的 zlib 手写 PNG 与 ICO 容器。
 *
 * 图标的形状：墨黑圆角底 + 三本琥珀色书脊 + 一道深琥珀书架。
 *   刻意做得极简 —— 浏览器标签页常按 16×16 显示，
 *   细节在那个尺寸上只会糊成一团，粗大的竖条才认得出。
 *
 * 用法：node scripts/gen-favicon.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public/favicon.ico');

const W = 32;
const H = 32;

// 与 src/lib/theme.ts 的色板一致（改主题色时这里也要跟着改，否则图标会脱节）
const INK = [14, 12, 10]; // --ink
const GLOW = [255, 180, 77]; // --glow
const DEEP = [217, 122, 26]; // --glow-deep

const px = new Uint8Array(W * H * 4); // RGBA

function set(x, y, [r, g, b], a = 255) {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 4;
  px[i] = r;
  px[i + 1] = g;
  px[i + 2] = b;
  px[i + 3] = a;
}

function rect(x0, y0, x1, y1, color) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, color);
}

/** 圆角矩形的内部判定（角上按圆的距离裁掉） */
function inRounded(x, y, r) {
  const R = r - 0.5;
  const nx = x < r ? r - 0.5 - x : x >= W - r ? x - (W - r - 0.5) : 0;
  const ny = y < r ? r - 0.5 - y : y >= H - r ? y - (H - r - 0.5) : 0;
  return nx * nx + ny * ny <= R * R + 0.5;
}

// ── 画图 ────────────────────────────────────────────────────────────────
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (inRounded(x, y, 7)) set(x, y, INK); // 圆角之外保持透明
  }
}

// 三本高低错落的书脊（宽 5，间隔 2，底部齐平在 y=24）
rect(7, 10, 11, 24, GLOW);
rect(13, 6, 17, 24, GLOW);
rect(19, 8, 23, 24, GLOW);

// 书架：一条深琥珀横线，把书「放住」
rect(6, 25, 25, 26, DEEP);

// ── PNG 编码（只用 zlib，不引第三方）───────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型 6 = RGBA
  // 10..12 保持 0：deflate / 自适应过滤 / 非隔行

  // 每条扫描线前面要加一个过滤字节（0 = None）
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    const off = y * (1 + W * 4);
    raw[off] = 0;
    Buffer.from(px.buffer, y * W * 4, W * 4).copy(raw, off + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── ICO 容器 ────────────────────────────────────────────────────────────
// ICO 允许直接内嵌 PNG（Windows Vista 起支持），比 BMP 版本小得多。
function encodeIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(1, 4); // 图像数量

  const entry = Buffer.alloc(16);
  entry[0] = W === 256 ? 0 : W; // 宽（256 记作 0）
  entry[1] = H === 256 ? 0 : H; // 高
  entry[2] = 0; // 调色板数（真彩为 0）
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // 颜色平面
  entry.writeUInt16LE(32, 6); // 位深
  entry.writeUInt32BE(0, 8);
  entry.writeUInt32LE(png.length, 8); // 数据长度
  entry.writeUInt32LE(header.length + entry.length, 12); // 数据偏移

  return Buffer.concat([header, entry, png]);
}

const png = encodePng();
const ico = encodeIco(png);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, ico);

// 终端里用色块回显一遍，方便肉眼确认图形没画错
const BLOCKS = { '14,12,10': '·', '255,180,77': '#', '217,122,26': '=' };
console.log(`已写入 ${OUT}（PNG ${png.length}B → ICO ${ico.length}B）\n`);
for (let y = 0; y < H; y += 2) {
  let line = '';
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const key = `${px[i]},${px[i + 1]},${px[i + 2]}`;
    line += px[i + 3] === 0 ? ' ' : (BLOCKS[key] ?? '?');
  }
  console.log(line);
}
