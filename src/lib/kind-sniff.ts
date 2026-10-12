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

/** 采样上限：只看文件头部这么多字节，避免把大文件读进内存 */
export const SNIFF_SAMPLE_BYTES = 2 * 1024 * 1024;

function countAll(hay: string, re: RegExp): number {
  return (hay.match(re) ?? []).length;
}

/**
 * 从 PDF 的字节片段判断形态。
 *
 * 输入是**原始字节按 latin1 解码**的字符串（PDF 的对象字典是 ASCII，
 * 用 latin1 解码可以保持字节与字符一一对应，避免 UTF-8 解码把二进制弄坏）。
 */
export function sniffPdfLayout(sample: string): 'comic' | 'text' | null {
  if (!sample || sample.length < 64) return null;

  // PDF 允许 `/Type /Page` 与 `/Type/Page` 两种写法，正则里都容忍。
  // 注意排除 `/Type/Pages`（页树节点，不是页）。
  const pages = countAll(sample, /\/Type\s*\/Page(?![s])/g);
  const images = countAll(sample, /\/Subtype\s*\/Image/g);
  const fonts = countAll(sample, /\/Type\s*\/Font/g);
  // 扫描件常见的整页图像压缩方式：JPEG / JPEG2000
  const jpeg = countAll(sample, /\/DCTDecode/g) + countAll(sample, /\/JPXDecode/g);

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

/**
 * 把字节片段解成「字节 ↔ 字符一一对应」的字符串。
 * 用 latin1 而不是 UTF-8：PDF 里混着二进制图片数据，UTF-8 解码会丢字节、
 * 甚至把标记字符吃掉。
 */
export function bytesToLatin1(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  // 分块拼接，避免 apply 的参数数量上限
  const CHUNK = 0x8000;
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
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

  const layout = sniffPdfLayout(bytesToLatin1(head));
  if (layout === 'comic') return 'comic';
  if (layout === 'text') return 'ebook';
  return null;
}
