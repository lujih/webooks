/**
 * 测试 EPUB 解析器（ZIP 读取 + OPF 解析 + 封面提取）。
 *
 * 造一个真实的（stored 条目）EPUB 字节，不依赖网络/真实文件。
 * 覆盖：正常解析、无封面、大小写容错、损坏 zip、非 EPUB 字节。
 */

import { describe, expect, it } from 'vitest';
import { parseEpub, PARSE_SIZE_CAP } from '../src/lib/epub';
import { readZipDirectory, readZipEntry } from '../src/lib/zip';

// ── 造一个最小 EPUB（全部 stored 条目，method=0）─────────────────────
function buildZip(entries: Array<[name: string, content: string | Uint8Array]>): ArrayBuffer {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const crc = crc32(data);

    const localHeader = new ArrayBuffer(30 + nameBytes.byteLength + data.byteLength);
    const lv = new DataView(localHeader);
    const lu = new Uint8Array(localHeader);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 0, true); // method = stored
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.byteLength, true); // compressed
    lv.setUint32(22, data.byteLength, true); // uncompressed
    lv.setUint16(26, nameBytes.byteLength, true);
    lv.setUint16(28, 0, true); // extra len
    lu.set(nameBytes, 30);
    lu.set(data, 30 + nameBytes.byteLength);
    local.push(new Uint8Array(localHeader));

    const cHeader = new ArrayBuffer(46 + nameBytes.byteLength);
    const cv = new DataView(cHeader);
    const cu = new Uint8Array(cHeader);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true); // stored
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.byteLength, true);
    cv.setUint32(24, data.byteLength, true);
    cv.setUint16(28, nameBytes.byteLength, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint32(42, offset, true);
    cu.set(nameBytes, 46);
    central.push(new Uint8Array(cHeader));

    offset += localHeader.byteLength;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) cdSize += c.byteLength;

  const eocd = new ArrayBuffer(22);
  const ev = new DataView(eocd);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(10, entries.length, true); // 总条目数
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);

  const total = cdStart + cdSize + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const l of local) { out.set(l, p); p += l.byteLength; }
  for (const c of central) { out.set(c, p); p += c.byteLength; }
  out.set(new Uint8Array(eocd), p);
  return out.buffer as ArrayBuffer;
}

// 极简 CRC32（只为造 fixture；真实 EPUB 用 deflate，CRC 不影响读取）
let crcTable: Uint32Array | null = null;
function ensureCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}
function crc32(bytes: Uint8Array): number {
  const table = ensureCrcTable();
  let c = 0xffffffff;
  for (const b of bytes) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:test</dc:identifier>
    <dc:title>三国 卷一</dc:title>
    <dc:creator role="http://purl.org/dc/dcmityp/text#creator">罗贯中</dc:creator>
    <dc:language>zh</dc:language>
    <meta property="ebooks:cover">cover</meta>
  </metadata>
  <manifest>
    <item id="cover" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
</package>`;

// 1x1 JPEG（最小合法 JPEG，约 125 字节）
function tinyJpeg(): Uint8Array {
  return new Uint8Array([
    0xff,0xd8,0xff,0xdb,0x00,0x43,0x00, 0x08,0x06,0x06,0x07,0x06,0x05, 0x08,0x07,0x07,0x09,
    0x06,0x06,0x07,0x09,0x09,0x09,0x08,0x08,0x07,0x07,0x07,0x0a,0x0c, 0x0e,0x0d,0x0d,0x0c,
    0x0a,0x0b,0x0e,0x0a,0x0b,0x0c,0x0c,0x13,0x0e,0x0a,0x0a,0x0f,0x0e, 0x16,0x0c,0x0b,0x0c,
    0x13,0x19,0x0d,0x0e,0x19,0x14,0x0b,0x10,0x0d,0x0b,0x0b,0x0f,0x12, 0x12,0x16,0x14,0x12,
    0x12,0x12,0x12,0x12,0x12,0x12,0x12,0x12,0x12,0x12,0x12,0x12,0x12, 0xff,0xc0,0x00,0x0b,
    0x08,0x00,0x01,0x00,0x01,0x01,0x01,0x01,0x01,0xff,0xc4,0x00, 0x1f,0x00,0x01,0x00,0x00,
    0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x01, 0x02,0x04,0x04,0x04,
    0x03,0x06,0x04,0x02,0x02,0x01,0x00,0x00,0xff,0xda,0x00,0x08, 0x01,0x01,0x00,0x00,0x3f,
    0x00,0x7f,0x00,0x3f,0x00,0x7f,0x00,0x3f,0x00,0x7f,0x00,0x3f,0x00, 0x7f,0x00,0x3f,0x00,
    0xff,0xd9,
  ]);
}

describe('zip 读取器', () => {
  const zip = buildZip([
    ['META-INF/container.xml', CONTAINER],
    ['OEBPS/content.opf', OPF],
    ['OEBPS/images/cover.jpg', tinyJpeg()],
  ]);

  it('能列出所有非目录条目', () => {
    const dir = readZipDirectory(zip);
    expect(dir.has('META-INF/container.xml')).toBe(true);
    expect(dir.has('OEBPS/content.opf')).toBe(true);
    expect(dir.has('OEBPS/images/cover.jpg')).toBe(true);
  });

  it('能读取 stored 条目内容', async () => {
    const dir = readZipDirectory(zip);
    const c = await readZipEntry(zip, dir, 'META-INF/container.xml');
    expect(new TextDecoder().decode(new Uint8Array(c!))).toContain('content.opf');
  });
});

describe('parseEpub', () => {
  it('提取标题/作者/语言/封面', async () => {
    const zip = buildZip([
      ['META-INF/container.xml', CONTAINER],
      ['OEBPS/content.opf', OPF],
      ['OEBPS/images/cover.jpg', tinyJpeg()],
    ]);
    const meta = await parseEpub(zip);
    expect(meta).not.toBeNull();
    expect(meta!.title).toBe('三国 卷一');
    expect(meta!.author).toBe('罗贯中');
    expect(meta!.language).toBe('zh');
    expect(meta!.cover).not.toBeNull();
    expect(meta!.cover!.contentType).toBe('image/jpeg');
    expect(meta!.cover!.bytes.byteLength).toBe(tinyJpeg().byteLength);
  });

  it('没有封面图时 cover 为 null，但元数据仍可解析', async () => {
    const opfNoCover = OPF.replace(
      '<item id="cover" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>',
      '',
    ).replace('<meta property="ebooks:cover">cover</meta>', '');
    const zip = buildZip([
      ['META-INF/container.xml', CONTAINER],
      ['OEBPS/content.opf', opfNoCover],
    ]);
    const meta = await parseEpub(zip);
    expect(meta!.title).toBe('三国 卷一');
    expect(meta!.cover).toBeNull();
  });

  it('损坏的 zip（非 zip 字节）返回 null', async () => {
    const junk = new TextEncoder().encode('this is not a zip at all, just random bytes here padding padding padding padding').buffer as ArrayBuffer;
    const meta = await parseEpub(junk);
    expect(meta).toBeNull();
  });

  it('超过大小上限的解析由调用方控制（PARSE_SIZE_CAP 导出正确值）', () => {
    expect(PARSE_SIZE_CAP).toBe(50 * 1024 * 1024);
  });

  it('大小写容错：META-INF 变体也能找到', async () => {
    const zip = buildZip([
      ['meta-inf/container.xml', CONTAINER],
      ['OEBPS/content.opf', OPF],
      ['OEBPS/images/cover.jpg', tinyJpeg()],
    ]);
    const meta = await parseEpub(zip);
    expect(meta!.title).toBe('三国 卷一');
  });
});