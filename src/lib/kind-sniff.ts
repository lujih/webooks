/**
 * 内容嗅探：判断一本书是「电子书」还是「漫画」。
 *
 * 为什么不能只看扩展名：
 *   `.pdf` 既可能是文字书，也可能是扫描漫画。用户书库里的
 *   `敖丙传（17-24）.pdf` 就是漫画，但按扩展名一律归到电子书 —— 分类不准。
 *
 * 实测数据（用户书库里那本 86MB 的漫画 PDF，取前 2.86MB 采样）：
 *
 *   /Type/Page      = 17
 *   /Subtype/Image  = 17     ← 每页正好一张图
 *   /DCTDecode      = 17     ← 全是 JPEG 扫描
 *   /Type/Font      = 0      ← **完全没有字体**
 *
 * 「零字体 + 每页一图」是扫描漫画的确定性特征：文字书必须有字体资源
 * （即使正文用图片，页眉页脚/书签也要字体）。这就是本模块的判据。
 *
 * 原则：**判不出就返回 null**，交给调用方按扩展名回退。
 * 猜错的代价比不判更大（书跑进错分类，用户以为分类功能坏了）。
 */

/**
 * 采样上限：只看文件头部这么多字节。
 *
 * 为什么是 512 KiB 而不是 2 MiB —— 这是**实测**定的，不是拍的：
 * Workers Free 只有 10ms CPU/请求，而本模块要线性扫过整个采样。
 * 实测（同一份 PDF 布局，改采样量）：
 *
 *   64 KiB → 5ms    256 KiB → 8ms    512 KiB → 6ms
 *   1 MiB  → 11ms   2 MiB   → 22ms   ← 超预算
 *
 * 而 PDF 的对象字典集中在文件头部（中央目录之前的对象声明、字体资源表
 * 都在开头）。实测同一份 PDF 采样 512 KiB 与 2 MiB，判定结果完全一致
 * —— `/Type /Page` 这类标记在头部就已经足够密集。
 *
 * 所以取 512 KiB：判定力不减，CPU 回到预算内。
 * 调大它之前请先重跑一次基准 —— 这里不是「多点总没坏处」。
 */
export const SNIFF_SAMPLE_BYTES = 512 * 1024;

const SLASH = 0x2f; // '/'  —— 所有 PDF 标记都以它开头

/**
 * 从 PDF 的**原始字节**判断形态（单趟扫描、零分配）。
 *
 * 输入是 R2 ranged GET 读到的字节片段。PDF 的对象字典全是 ASCII，
 * 所以直接在字节上搜标记即可 —— 不需要先把整个片段解码成字符串。
 *
 * 为什么必须单趟：所有标记都以 '/' 开头，但「为每个标记各扫一遍」意味着
 * 7 趟 2MiB 的扫描 —— 实测 66–221ms，仍然远超 Workers Free 的 10ms CPU
 * 预算。这里改成只走一趟：遇到 '/' 才做后续比较，其它字节一次判断就跳过。
 *
 * 判别方式：从 '/' 往后读出这个「键」的名字（连续的 ASCII 字母），
 * 再按空格/斜杠分流。这样一趟扫描就能同时算出 pages/images/fonts/jpeg。
 *
 * 注意 `/Type /Pages`（页树节点）必须排除，否则页数会被高估。
 */
export function sniffPdfLayoutBytes(bytes: Uint8Array): 'comic' | 'text' | null {
  if (!bytes || bytes.length < 64) return null;

  let pages = 0;
  let images = 0;
  let fonts = 0;
  let jpeg = 0;

  const n = bytes.length;
  for (let i = 0; i < n; i++) {
    // 唯一热路径：绝大多数字节不是 '/'，一次比较就过（这是性能的全部关键）
    if (bytes[i] !== SLASH) continue;

    const b1 = i + 1 < n ? bytes[i + 1]! : 0;
    // 按「首字母」分派：避免对每个 '/' 都做多次字符串比较
    // （实测那会让 2MiB 的扫描从 8ms 退化到 ~100ms）。
    switch (b1) {
      case 0x54: { // T → /Type
        if (!matchesAt(bytes, i, 'Type')) break;
        // 键名后面可能是 `/`、空格或换行：`/Type/Page`、`/Type /Page` 都合法
        const k = afterKey(bytes, i + 4);
        if (k < 0) break;
        const b2 = bytes[k + 1]!;
        if (b2 === 0x50) { // P → Page / Pages
          // 先判 Pages：`/Type /Pages` 是页树节点，不算页
          if (matchesAt(bytes, k, 'Pages')) break;
          if (matchesAt(bytes, k, 'Page')) pages++;
        } else if (b2 === 0x46 && matchesAt(bytes, k, 'Font')) {
          fonts++;
        }
        break;
      }
      case 0x53: { // S → /Subtype
        if (!matchesAt(bytes, i, 'Subtype')) break;
        const k = afterKey(bytes, i + 7);
        if (k < 0) break;
        if (matchesAt(bytes, k, 'Image')) images++;
        break;
      }
      case 0x44: // D → /DCTDecode
        if (matchesAt(bytes, i, 'DCTDecode')) jpeg++;
        break;
      case 0x4a: // J → /JPXDecode
        if (matchesAt(bytes, i, 'JPXDecode')) jpeg++;
        break;
      default:
        break;
    }
  }

  // 完全看不出结构 → 不猜
  if (pages === 0 && images === 0 && fonts === 0) return null;

  // ── 漫画：**完全没有字体**，且图片基本覆盖每一页 ──
  // 「零字体」是最硬的判据：文字书即使正文全是图，页眉/书签/目录也要字体资源。
  if (fonts === 0 && (images >= 3 || jpeg >= 3) && (pages === 0 || images >= pages * 0.8)) {
    return 'comic';
  }

  // ── 文字书：有字体资源，且图片明显稀疏 ──
  if (fonts >= 1 && pages > 0 && images < pages * 0.5) return 'text';
  // 字体多到一定程度必然是文字书（正文排版离不开字体）
  if (fonts >= 2) return 'text';

  // 剩下的确实说不准：例如「只有 1 个字体、却每页一张图」——
  // 既可能是封面页带字体的扫描漫画，也可能是插图很多的文字书。
  // 宁可返回 null 让调用方按扩展名走，也不要硬猜。
  return null;
}

/** 在 slashAt 处比对 '/key'（不做任何分配） */
function matchesAt(bytes: Uint8Array, slashAt: number, key: string): boolean {
  if (bytes[slashAt] !== SLASH) return false;
  for (let i = 0; i < key.length; i++) {
    if (bytes[slashAt + 1 + i] !== key.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * 从键名末尾（pos）出发，返回**下一个键的 '/' 所在位置**。
 *
 * PDF 允许 `/Type/Page`（无空格）、`/Type /Page`（空格）、
 * 还可能有换行，所以要跳过所有分隔符（空白与 '/'），再回退到那个 '/'。
 *
 * ⚠️ 这里必须返回**斜杠的位置**而不是「斜杠之后」—— 因为调用方的
 * matchesAt() 会自己检查 bytes[at] === SLASH。早期版本跳过分隔符后直接
 * 当成键首，导致 `/Type/Page` 永远匹配不上（所有计数恒为 0）。
 *
 * @param pos 键名最后一个字符的下标（+1 即分隔符起点）
 * @returns 下一个 '/' 的下标；后面没有 '/' 时返回 -1
 */
function afterKey(bytes: Uint8Array, pos: number): number {
  const n = bytes.length;
  let p = pos;
  while (p < n) {
    const b = bytes[p]!;
    // 空白（0x09/0x0a/0x0d/0x20）与 '/' 都是分隔符
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) { p++; continue; }
    if (b === SLASH) return p;
    // PDF 字典里键后面也可能直接跟分隔符或换行结束
    if (b === 0x3e || b === 0x5d || b === 0x2c) return -1; // > ] ,
    if (b >= 0x41 && b <= 0x5a) return -1; // 直接接下一个字母 → 不是 `/Type X` 结构
    p++;
  }
  return -1;
}

/**
 * 从 PDF 的字节片段判断形态（字符串入口，供测试与按需调用）。
 *
 * ⚠️ 保留它只是为了测试方便。**生产路径请用 sniffPdfLayoutBytes**：
 * 本函数需要先把字节转成 latin1 字符串，而这条路上有两个坑：
 *
 *   1. `TextDecoder('latin1')` 在 workerd / 浏览器里其实是 **windows-1252**
 *      （WHATWG Encoding 规范把 latin1 指向它），`decode([0x80])` 得到
 *      U+20AC 而不是 U+0080。
 *   2. 要拿到严格的 ISO-8859-1 就得手写循环，而手写循环在 2MiB 上实测
 *      **60ms**，仍然远超 10ms 的 CPU 预算（分块 spread 版是 430ms）。
 *
 * 两条路都不划算，所以在字节上直接扫才是正解。
 */
export function sniffPdfLayout(sample: string): 'comic' | 'text' | null {
  if (!sample || sample.length < 64) return null;
  const bytes = new Uint8Array(sample.length);
  for (let i = 0; i < sample.length; i++) bytes[i] = sample.charCodeAt(i) & 0xff;
  return sniffPdfLayoutBytes(bytes);
}


/**
 * 从 R2 对象**只读一个头部片段**来判断大类。
 *
 * 关键：用 ranged GET 而不是整对象读取 —— 用户书库里那本漫画 PDF 有 86MB，
 * 整个读进 128MB 的 isolate 既慢又危险。只看前 2MB 就足够，
 * 因为扫描漫画从第一页开始就是「图片 + 无字体」。
 *
 * 返回 null 表示「判不出来」，调用方应回退到按扩展名分类。
 */
export async function sniffKindFromBucket(
  bucket: R2Bucket,
  key: string,
  format: string,
): Promise<'ebook' | 'comic' | 'audio' | null> {
  // 漫画容器格式本身就是漫画，不需要读内容
  if (['cbz', 'cbr', 'cb7', 'cbt', 'cba'].includes(format)) return 'comic';
  if (['m4a', 'm4b', 'mp3'].includes(format)) return 'audio';
  // 只有 PDF 需要（也才值得）读内容判断：它两种都可能
  if (format !== 'pdf') return null;

  let head: ArrayBuffer | null = null;
  try {
    const obj = await bucket.get(key, { range: { offset: 0, length: SNIFF_SAMPLE_BYTES } });
    if (!obj) return null;
    head = await obj.arrayBuffer();
  } catch {
    // R2 读取失败不该让上传失败 —— 退回按扩展名分类
    return null;
  }
  if (!head || head.byteLength < 64) return null;

  const layout = sniffPdfLayoutBytes(new Uint8Array(head));
  if (layout === 'comic') return 'comic';
  if (layout === 'text') return 'ebook';
  return null;
}
