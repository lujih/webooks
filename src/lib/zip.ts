/**
 * 最小 ZIP 读取器 —— 只实现 EPUB 解析真正需要的部分：
 *   · 从 End of Central Directory 反查中央目录
 *   · 按条目名提取单个文件的解压后内容
 *
 * 为什么不引入 jszip / fflate：
 *   它们都是「整个 zip 解压到内存」的通用库，体积大，且我们要的是「只读几个
 *   小条目」（container.xml / OPF / 封面图），不需要全解压。手写 ~120 行，
 *   零依赖，且能精确控制 CPU。
 *
 * 解压用 Web 标准的 DecompressionStream('deflate-raw')（workerd 与浏览器都支持），
 * 不需要自己实现 inflate。
 *
 * 安全边界：调用方负责把读进来的字节控制在合理范围内（epub.ts 里做 50MB 上限）。
 */

export interface ZipEntry {
  name: string;
  method: number; // 0=stored, 8=deflate
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export class ZipReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipReadError';
  }
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** 定位 EOCD 起始偏移（从文件末尾往前扫，最多扫 22+65535 字节） */
function eocdOffset(buf: ArrayBuffer, byteLength: number): number {
  const view = new DataView(buf);
  const minStart = Math.max(0, byteLength - 22 - 65535);
  for (let i = byteLength - 22; i >= minStart; i--) {
    // 防 i+4 越界：仅当 i+4 <= byteLength 时才读
    if (i + 4 > byteLength) continue;
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  throw new ZipReadError('EOCD not found — not a valid ZIP');
}

/**
 * 解析中央目录，返回 文件名 -> 条目 的映射（忽略目录与空名）。
 * 这是唯一的「扫全文件」步骤，且只读末尾的中央目录，不碰实际数据。
 */
export function readZipDirectory(buf: ArrayBuffer): Map<string, ZipEntry> {
  const total = buf.byteLength;
  if (total < 22) throw new ZipReadError('file too small to be a ZIP');

  const eocd = eocdOffset(buf, total);
  const view = new DataView(buf);
  // EOCD 布局（小端）：
  //   +0  u32 signature (0x06054b50)
  //   +4  u16 disk number
  //   +6  u16 disk with CD
  //   +8  u16 entries on this disk
  //   +10 u16 total entries
  //   +12 u32 CD size
  //   +16 u32 CD offset
  //   +20 u16 comment length
  const entryCount = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  const cdSize = view.getUint32(eocd + 12, true);
  // 用 eocd 位置兜底：central dir 必然紧贴在 EOCD 之前
  const cdEnd = cdSize > 0 ? cdOffset + cdSize : eocd;

  const entries = new Map<string, ZipEntry>();
  let p = cdOffset;
  for (let n = 0; n < entryCount; n++) {
    if (p + 46 > total || p + 46 > cdEnd + 1) {
      // 防御：中央目录越界（可能 zip64 或损坏）——停止而不是崩溃
      break;
    }
    if (view.getUint32(p, true) !== CENTRAL_SIG) break;
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const uncompressedSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localHeaderOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nameLen));
    if (name && !name.endsWith('/')) {
      entries.set(name, { name, method, compressedSize, uncompressedSize, localHeaderOffset });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * 单个条目解压后的体积上限。
 *
 * Workers isolate 的内存是 **128MB**，而 EPUB 解析里还同时持有
 * 原始 buf（PARSE_SIZE_CAP 允许到 50MB）、封面缓冲等。没有上限时，
 * 一个 408KB 的 EPUB 就能解压出 400MB —— 膨胀比 1029×，
 * 直接把 isolate 打爆（Error 1102）。实测这个构造：
 *
 *   zip 体积      = 407,999 字节   （远低于 50MB 的 PARSE_SIZE_CAP）
 *   c.opf 解压后  = 419,430,400 字节
 *
 * 注意 PARSE_SIZE_CAP 约束的是**压缩前**的文件大小，管不到解压后 ——
 * 两者之间差着膨胀比，这就是绕过它的原因。
 *
 * 8MB 足够任何 OPF / container.xml（真实文件都在几百 KB 量级），
 * 同时给封面留出余量（COVER_CAP 也是 8MB）。
 */
export const ENTRY_INFLATE_CAP = 8 * 1024 * 1024;

/**
 * 膨胀比上限：解压后 / 压缩后。
 *
 * 正常 EPUB 里图片（JPEG）本来就压缩比很高，但 **文本**（XML/HTML）
 * 通常在 2–20 倍。取 200 足以覆盖所有真实文件，同时能挡住
 * 「声明 1MB 实际 200MB」这种畸形条目 —— 那种 ratio 必然远超 200。
 */
const MAX_INFLATION_RATIO = 200;

/**
 * 解压，同时限制输出体积。
 *
 * 关键在于**流式限量消费**：逐块读取，一旦超过上限就 `cancel()` 掉，
 * 而不是让 DecompressionStream 全部物化进内存（原来的写法正是后者）。
 * 提前 cancel 是这里唯一有意义的防护 —— 数据已经读进来了才检查就晚了。
 */
async function inflate(raw: Uint8Array, cap: number): Promise<ArrayBuffer> {
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      // 立刻停止读取：这是唯一能在内存被撑爆之前拦住它的位置
      await reader.cancel().catch(() => {});
      throw new ZipReadError(
        `inflated entry exceeds ${cap} bytes (zip bomb or malformed archive)`,
      );
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out.buffer;
}

/**
 * 提取单个条目。找不到返回 null（EPUB 条目名大小写/前缀有差异时调用方要容错）。
 * @param buf  整个 zip 的字节
 * @param entries readZipDirectory 的结果
 * @param name  条目名（绝对路径，含前导目录）
 * @param cap   该条目允许的最大体积（默认 ENTRY_INFLATE_CAP）
 */
export async function readZipEntry(
  buf: ArrayBuffer,
  entries: Map<string, ZipEntry>,
  name: string,
  cap: number = ENTRY_INFLATE_CAP,
): Promise<ArrayBuffer | null> {
  const entry = entries.get(name);
  if (!entry) return null;

  // ── 声明值预检：在**分配任何内存之前**就能挡掉大部分畸形条目 ──
  // 中央目录里的 uncompressedSize 是解析器读出来的（zip.ts 里
  // readZipDirectory 已经解析），此前从未被使用过。它可以撒谎
  // （比真实值小），所以只能当快速筛子，最终仍以流式上限为准。
  if (entry.uncompressedSize > cap) {
    throw new ZipReadError(
      `entry ${name} declares ${entry.uncompressedSize} bytes, over cap ${cap}`,
    );
  }
  // 膨胀比预检：声明值可疑时直接拒（ratio > 200 的文本条目必然是 bomb）
  if (
    entry.compressedSize > 0 &&
    entry.uncompressedSize / entry.compressedSize > MAX_INFLATION_RATIO
  ) {
    throw new ZipReadError(
      `entry ${name} declares suspicious inflation ratio `
      + `(${entry.uncompressedSize}/${entry.compressedSize})`,
    );
  }

  // 本地文件头里再读一次 name/extra 长度（可能与中央目录略有出入），定位数据起点
  const view = new DataView(buf);
  const lh = entry.localHeaderOffset;
  if (lh + 30 > buf.byteLength) return null;
  if (view.getUint32(lh, true) !== LOCAL_SIG) return null;
  const lhNameLen = view.getUint16(lh + 26, true);
  const lhExtraLen = view.getUint16(lh + 28, true);
  const dataStart = lh + 30 + lhNameLen + lhExtraLen;

  // 越界检查：中央目录里的 compressedSize 可以伪造，直接 new Uint8Array
  // 会抛 RangeError（不致命，但会走异常路径）。显式挡掉更干净。
  if (dataStart + entry.compressedSize > buf.byteLength) {
    throw new ZipReadError(`entry ${name} data range exceeds archive bounds`);
  }
  const data = new Uint8Array(buf, dataStart, entry.compressedSize);

  if (entry.method === 0) {
    // stored：直接拷贝（不共享底层视图，避免调用方持有整个大 buf）
    if (data.byteLength > cap) {
      throw new ZipReadError(`stored entry ${name} exceeds cap ${cap}`);
    }
    return data.slice().buffer;
  }
  if (entry.method === 8) {
    return await inflate(data, cap);
  }
  throw new ZipReadError(`unsupported compression method ${entry.method} for ${name}`);
}