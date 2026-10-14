/**
 * ZIP bomb 防御（回归测试）。
 *
 * 修复前的 inflate() 直接把整个解压流物化成 ArrayBuffer，没有任何上限。
 * 而 PARSE_SIZE_CAP（50MB）约束的是**压缩前**的文件大小 —— 两者之间
 * 差着膨胀比，所以它完全管不到解压后的体积。实测可构造：
 *
 *   zip 体积 408 KB  →  单条目解压 400 MB   （膨胀比 1029×）
 *
 * 打进 128MB 的 isolate 就是 Error 1102，而 WebDAV PUT 是匿名的。
 *
 * 现在有两道互补的防线，各自的必要性都被下面的测试单独证明：
 *   ① 声明值预检（readZipEntry 开头）—— 中央目录里的 uncompressedSize
 *      此前从未被使用过，现在拿来做快速筛子
 *   ② 流式限量（inflate 逐块读、越界即 cancel）—— 声明值可以撒谎，
 *      只有真正读流才知道实际膨胀了多少
 */

import { describe, expect, it } from 'vitest';
import { parseEpub } from '../src/lib/epub';
import { ENTRY_INFLATE_CAP, readZipDirectory, readZipEntry } from '../src/lib/zip';

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
function crc32(buf: Uint8Array): number {
  let c = 0, crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]!) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
/** 构造 zip：entries = [{name, raw, uncompressedSize?}] */
function makeZip(entries: { name: string; comp: Uint8Array; method: number; uncomp: number }[]): ArrayBuffer {
  const locals: Uint8Array[] = [], centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = new TextEncoder().encode(e.name);
    const crc = crc32(e.comp);
    const lh = new Uint8Array(30); const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(8, e.method, true);
    dv.setUint32(14, crc, true); dv.setUint32(18, e.comp.length, true);
    dv.setUint32(22, e.uncomp, true); dv.setUint16(26, name.length, true);
    locals.push(lh, name, e.comp);
    const ch = new Uint8Array(46); const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(10, e.method, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, e.comp.length, true);
    cv.setUint32(24, e.uncomp, true); cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    centrals.push(ch, name);
    offset += lh.length + name.length + e.comp.length;
  }
  const lb = new Uint8Array(locals.reduce((a, b) => a + b.length, 0));
  let o = 0; for (const x of locals) { lb.set(x, o); o += x.length; }
  const cb = new Uint8Array(centrals.reduce((a, b) => a + b.length, 0));
  o = 0; for (const x of centrals) { cb.set(x, o); o += x.length; }
  const eocd = new Uint8Array(22); const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cb.length, true); ev.setUint32(16, lb.length, true);
  const out = new Uint8Array(lb.length + cb.length + eocd.length);
  out.set(lb, 0); out.set(cb, lb.length); out.set(eocd, lb.length + cb.length);
  return out.buffer;
}

describe('ZIP bomb', () => {
  it('声明 400MB 的条目被拒，正常条目不受影响', async () => {
    const container = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/c.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
    // 真实数据只造 8MB（够产生高膨胀比），但**声明** 400MB ——
    // 预检必须只信声明就拦下它，不需要真的分配 400MB。
    const RAW = 8 * 1024 * 1024;
    const DECLARED = 400 * 1024 * 1024;
    const bigComp = await deflateRaw(new Uint8Array(RAW).fill(0x41));
    const contComp = await deflateRaw(new TextEncoder().encode(container));

    const buf = makeZip([
      { name: 'mimetype', comp: new TextEncoder().encode('application/epub+zip'), method: 0, uncomp: 20 },
      { name: 'META-INF/container.xml', comp: contComp, method: 8, uncomp: container.length },
      { name: 'OEBPS/c.opf', comp: bigComp, method: 8, uncomp: DECLARED },
    ]);
    console.log(`  zip 体积: ${buf.byteLength} 字节, 声明解压: ${(DECLARED/1048576).toFixed(0)}MB, 膨胀比 ${(DECLARED/bigComp.length).toFixed(0)}x`);

    const entries = readZipDirectory(buf);
    const ok = await readZipEntry(buf, entries, 'mimetype');
    console.log('  正常条目 mimetype →', ok ? new TextDecoder().decode(ok) : null);
    expect(new TextDecoder().decode(ok!)).toBe('application/epub+zip');
    const cont = await readZipEntry(buf, entries, 'META-INF/container.xml');
    console.log('  正常条目 container.xml →', cont?.byteLength, '字节');
    expect(cont).toBeTruthy();

    const t0 = Date.now();
    let msg = '';
    try { await readZipEntry(buf, entries, 'OEBPS/c.opf'); } catch (e) { msg = (e as Error).message; }
    console.log(`  bomb 条目 → ${msg || '❌ 未被拒'}  (${Date.now()-t0}ms)`);
    expect(msg).toMatch(/cap|exceeds/);

    const t1 = Date.now();
    const r = await parseEpub(buf);
    console.log(`  parseEpub → ${JSON.stringify(r)}  (${Date.now()-t1}ms)`);
    expect(r).toBeNull();
  });

  it('声明值撒谎（uncompressedSize 很小）时流式上限仍生效', async () => {
    const BIG = 60 * 1024 * 1024;
    const bigRaw = new Uint8Array(BIG).fill(0x42);
    const bigComp = await deflateRaw(bigRaw);
    // 声明只有 1KB（撒谎），实际解压 60MB
    const buf = makeZip([{ name: 'liar.opf', comp: bigComp, method: 8, uncomp: 1024 }]);
    const entries = readZipDirectory(buf);
    console.log(`  撒谎条目: zip ${buf.byteLength}B, 声明 1KB, 实际 ${(BIG/1048576).toFixed(0)}MB`);
    let msg = '';
    try { await readZipEntry(buf, entries, 'liar.opf'); } catch (e) { msg = (e as Error).message; }
    console.log(`  → ${msg || '❌ 未被拒'}`);
    expect(msg).toMatch(/cap|exceeds/);
  });
});
