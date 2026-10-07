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

async function inflate(raw: Uint8Array): Promise<ArrayBuffer> {
  const decompressed = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return await new Response(decompressed).arrayBuffer();
}

/**
 * 提取单个条目。找不到返回 null（EPUB 条目名大小写/前缀有差异时调用方要容错）。
 * @param buf  整个 zip 的字节
 * @param entries readZipDirectory 的结果
 * @param name  条目名（绝对路径，含前导目录）
 */
export async function readZipEntry(
  buf: ArrayBuffer,
  entries: Map<string, ZipEntry>,
  name: string,
): Promise<ArrayBuffer | null> {
  const entry = entries.get(name);
  if (!entry) return null;

  // 本地文件头里再读一次 name/extra 长度（可能与中央目录略有出入），定位数据起点
  const view = new DataView(buf);
  const lh = entry.localHeaderOffset;
  if (lh + 30 > buf.byteLength) return null;
  if (view.getUint32(lh, true) !== LOCAL_SIG) return null;
  const lhNameLen = view.getUint16(lh + 26, true);
  const lhExtraLen = view.getUint16(lh + 28, true);
  const dataStart = lh + 30 + lhNameLen + lhExtraLen;
  const data = new Uint8Array(buf, dataStart, entry.compressedSize);

  if (entry.method === 0) {
    // stored：直接拷贝（不共享底层视图，避免调用方持有整个大 buf）
    return data.slice().buffer;
  }
  if (entry.method === 8) {
    return await inflate(data);
  }
  throw new ZipReadError(`unsupported compression method ${entry.method} for ${name}`);
}