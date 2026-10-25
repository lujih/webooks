/**
 * 最小 ZIP 写入器 —— 只写 EPUB 需要的部分，零运行时依赖。
 *
 * 为什么不用 `zip` 命令 / jszip / fflate：
 *   · `zip` 命令行不是每台机器都有（CI、Windows、精简容器常常没有）；
 *   · jszip/fflate 会往仓库里塞一个依赖，而本项目的硬约束是「运行时零依赖」；
 *   · EPUB 要的只是 store + deflate 两种条目，手写不到 150 行，行为完全可控。
 *
 * 与 src/lib/zip.ts（读取侧）的约定：
 *   · 中央目录里的 uncompressedSize / compressedSize 必须写**真实值**，
 *     读取侧会先用它们做体积与膨胀比预检，撒谎会被当成 zip bomb 拒掉；
 *   · 条目名用绝对路径（`OEBPS/content.opf`），读取侧按名字精确查找；
 *   · 只写单盘、无 zip64、无注释 —— 上限 65535 个条目 / 4GB，EPUB 远够。
 *
 * 用法：
 *   import { createZip, crc32 } from './zip-write.mjs';
 *   const buf = createZip([{ name: 'mimetype', data: 'application/epub+zip', store: true }]);
 */

import { deflateRawSync } from 'node:zlib';

// ── CRC32（IEEE 802.3，ZIP 规范要求的那个多项式） ──────────────────────
// 查表法：256 项表在模块加载时算一次，之后每条目 O(n)。
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

/** 计算一段字节的 CRC32，返回无符号 32 位整数 */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ── DOS 时间戳（ZIP 头里的 time/date 是 16 位「DOS 时间」） ─────────────
function dosDateTime(d) {
  const year = Math.max(1980, Math.min(2107, d.getFullYear()));
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time =
    (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return { date, time };
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const VERSION_NEEDED = 20; // 2.0：支持 deflate 即可
const VERSION_MADE_BY = (3 << 8) | 20; // 3 = Unix，2.0；配合下面的 0644 权限位
const UNIX_FILE_MODE = 0o100644;

/**
 * 生成一个 ZIP 文件。
 *
 * @param {{name: string, data: string|Uint8Array|Buffer, store?: boolean}[]} entries
 *   条目按数组顺序写入。EPUB 要求 `mimetype` 是**第一个**条目且不压缩：
 *   写 EPUB 时把它放第一个并传 `store: true`。
 * @param {{mtime?: Date}} [opts]
 * @returns {Buffer}
 */
export function createZip(entries, opts = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('createZip: entries must be a non-empty array');
  }
  if (entries.length > 0xffff) {
    throw new Error(`createZip: too many entries (${entries.length} > 65535)`);
  }

  const { date, time } = dosDateTime(opts.mtime ?? new Date());
  const localParts = [];
  const centralParts = [];
  const seen = new Set();
  let offset = 0;

  for (const entry of entries) {
    const name = String(entry?.name ?? '');
    // 防御：绝对路径 / 反斜杠 / .. 在 ZIP 里都是「解压到目录外」的经典手法，
    // 虽然这里是我们自己生成的，写死校验能挡住以后被误用。
    if (!name || name.startsWith('/') || name.includes('\\') || /(^|\/)\.\.(\/|$)/.test(name)) {
      throw new Error(`createZip: invalid entry name: ${JSON.stringify(name)}`);
    }
    if (seen.has(name)) throw new Error(`createZip: duplicate entry: ${name}`);
    seen.add(name);

    const raw =
      typeof entry.data === 'string'
        ? Buffer.from(entry.data, 'utf8')
        : Buffer.from(entry.data);
    const crc = crc32(raw);

    // mimetype 必须 store（EPUB 规范）；其余尝试 deflate，压不小就退回 store，
    // 免得「压缩后反而更大」的条目白占空间。
    let method = 0;
    let payload = raw;
    if (!entry.store) {
      const deflated = deflateRawSync(raw, { level: 9 });
      if (deflated.length < raw.length) {
        method = 8;
        payload = deflated;
      }
    }

    const nameBuf = Buffer.from(name, 'utf8');
    // 条目名含非 ASCII 时置 UTF-8 标志位（0x0800）。EPUB 的条目名目前都是 ASCII，
    // 但以后加封面/多语言文件名时不必再改这里。
    const utf8Flag = /[^\x20-\x7e]/.test(name) ? 0x0800 : 0;

    // 本地文件头：30 字节定长 + 文件名 + 数据（不用 data descriptor，尺寸事先已知）
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(utf8Flag, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field 长度

    localParts.push(local, nameBuf, payload);

    // 中央目录项：46 字节定长 + 文件名
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(CENTRAL_SIG, 0);
    cd.writeUInt16LE(VERSION_MADE_BY, 4);
    cd.writeUInt16LE(VERSION_NEEDED, 6);
    cd.writeUInt16LE(utf8Flag, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk number start
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE((UNIX_FILE_MODE << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    centralParts.push(cd, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
    if (offset > 0xffffffff) throw new Error('createZip: archive exceeds 4GB (zip64 unsupported)');
  }

  const centralSize = centralParts.reduce((n, b) => n + b.length, 0);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // 注释长度

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}
