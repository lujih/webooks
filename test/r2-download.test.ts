/**
 * 浏览页书卡直链 R2 —— 「点一次下载不再消耗一次 Worker 请求」。
 *
 * 免费套餐每天只有 10 万次 Worker 请求，而每一次「点开一本书」原本都必须
 * 经过 Worker 拿一个 302（还带 no-store，缓存不上）。这里守住三件事：
 *
 *   1. 目录页的书卡 href 是 R2 公开域直链，目录卡仍走 /dav
 *   2. R2 对象带 Content-Disposition（否则下载下来叫 books/<随机 id>）
 *   3. 拼接与编码规则只有一份实现（lib/r2.ts），且挡得住 header 注入
 */

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Entry } from '../src/webdav/propfind';
import { renderBrowsePage } from '../src/browse-page';
import { asciiFallback, contentDispositionFor, encodeR2Key, r2HttpMetadata } from '../src/lib/r2';
import { clearDavCache, resetLibrary, testEnv } from './setup';

const ORIGIN = 'https://webooks.test';
const R2_BASE = 'https://books.test';
const ALL_PATHS = ['/', '/按书名/', '/按书名/S/', '/最近收录/', '/title/', '/recent/'];

function browse(path: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/dav${path}`, { headers: { accept: 'text/html' } });
}

function dav(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/dav${path}`, {
    ...init,
    headers: {
      authorization: 'Bearer test-write-token',
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

/** 取某个 DAV 路径对应对象在 R2 里的真实 httpMetadata */
async function storedMeta(
  leafName: string,
): Promise<{ contentType: string; contentDisposition: string }> {
  const row = await testEnv.DB.prepare('SELECT r2_key FROM books WHERE leaf_name = ?')
    .bind(leafName)
    .first<{ r2_key: string }>();
  expect(row?.r2_key, `D1 里找不到 ${leafName}`).toBeTruthy();
  const head = await testEnv.BUCKET.head(row!.r2_key);
  return {
    contentType: head?.httpMetadata?.contentType ?? '',
    contentDisposition: head?.httpMetadata?.contentDisposition ?? '',
  };
}

beforeEach(async () => {
  await resetLibrary();
  await clearDavCache(ALL_PATHS);
});

// ── 造一个带封面的最小 EPUB ─────────────────────────────────────────────
// 为了验证「封面对象不带 contentDisposition」，必须让 Worker 真的解析出封面。
// 全是 stored 条目（method=0），所以只有 CRC 与长度要填对，不需要 deflate。

const EPUB_CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const EPUB_OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:r2test</dc:identifier>
    <dc:title>带封面的书</dc:title>
    <dc:language>zh</dc:language>
  </metadata>
  <manifest>
    <item id="cover" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>
  </manifest>
</package>`;

/** 1×1 JPEG（长度 > 12，否则嗅探直接放弃） */
function tinyJpeg(): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
  ]);
}

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  const table = crcTable;
  let c = 0xffffffff;
  for (const b of bytes) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildStoredEpub(): ArrayBuffer {
  const entries: Array<[string, string | Uint8Array]> = [
    ['META-INF/container.xml', EPUB_CONTAINER],
    ['OEBPS/content.opf', EPUB_OPF],
    ['OEBPS/images/cover.jpg', tinyJpeg()],
  ];

  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.byteLength + data.byteLength);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true); // method = stored
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.byteLength, true);
    lv.setUint32(22, data.byteLength, true);
    lv.setUint16(26, nameBytes.byteLength, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.byteLength);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.byteLength);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true); // stored
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.byteLength, true);
    cv.setUint32(24, data.byteLength, true);
    cv.setUint16(28, nameBytes.byteLength, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.byteLength;
  }

  const cdSize = centrals.reduce((n, c) => n + c.byteLength, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const l of locals) { out.set(l, p); p += l.byteLength; }
  for (const c of centrals) { out.set(c, p); p += c.byteLength; }
  out.set(eocd, p);
  return out.buffer as ArrayBuffer;
}

describe('书卡 href 指向 R2 公开域', () => {
  it('目录页书卡是 R2 直链，且不再出现 /dav 形式的书卡链接', async () => {
    const put = await dav('/recent/三体.epub', { method: 'PUT', body: 'x' });
    expect([201, 204]).toContain(put.status);

    const res = await browse('/recent/');
    expect(res.status).toBe(200);
    const html = await res.text();

    const row = await testEnv.DB.prepare('SELECT r2_key FROM books WHERE leaf_name = ?')
      .bind('三体.epub')
      .first<{ r2_key: string }>();
    const key = row!.r2_key;
    // 对象键现在是 `books/<id>/<书名>`（2026-10-21 起，为了走 S3 的客户端
    // 也能拿到可读文件名）。键里含中文，所以直链**必须**经 encodeR2Key 逐段
    // 编码 —— 原先这里是直接拼原始键（那时键是 `books/<随机 id>`，纯 ASCII，
    // 不编码也对）。断言改成编码后的形态，并额外钉住「键里确实带书名」。
    expect(html).toContain(`href="${R2_BASE}/${encodeR2Key(key)}"`);
    // 键的第二段就是书名 —— 这是整个改动的目的，单独钉住
    expect(key.split('/').pop()).toBe('三体.epub');
    // 反向断言：书卡不能再指回 /dav（否则「省一次请求」是假的）
    expect(html).not.toContain(`href="/dav/${encodeURIComponent('最近收录')}/%E4%B8%89%E4%BD%93.epub"`);
  });

  it('书卡直链的点击不经过 Worker：GET /dav 的 302 行为本身保持不变', async () => {
    await dav('/recent/direct.epub', { method: 'PUT', body: 'x' });
    // WebDAV 客户端（rclone / Finder）仍依赖这个 302，直链改造不能把它删掉
    const res = await dav('/recent/direct.epub', { method: 'GET', redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(new RegExp(`^${R2_BASE}/books/`));
  });
});

describe('downloadUrl 缺失时的回退', () => {
  /** 直接调渲染器造一个「没有 downloadUrl」的条目（老缓存条目就是这样） */
  function entryWithoutDownloadUrl(): Entry {
    return {
      path: '/按书名/S/三体.epub',
      isCollection: false,
      meta: { displayName: '三体' },
    };
  }

  it('downloadUrl 为 undefined 时退回 /dav 路径，而不是渲染出 href="undefined"', () => {
    const html = renderBrowsePage('/按书名/S/', [entryWithoutDownloadUrl()], '/dav');
    expect(html).not.toContain('href="undefined"');
    expect(html).not.toContain('undefined');
    expect(html).toContain(
      `href="/dav/${encodeURIComponent('按书名')}/S/${encodeURIComponent('三体.epub')}"`,
    );
  });

  it('downloadUrl 为空字符串时同样回退', () => {
    const entry: Entry = {
      path: '/按书名/S/三体.epub',
      isCollection: false,
      meta: { displayName: '三体', downloadUrl: '' },
    };
    const html = renderBrowsePage('/按书名/S/', [entry], '/dav');
    expect(html).toContain(`href="/dav/${encodeURIComponent('按书名')}/S/%E4%B8%89%E4%BD%93.epub"`);
  });

  it('downloadUrl 存在时优先用它（集合卡不受影响）', () => {
    const book: Entry = {
      path: '/按书名/S/三体.epub',
      isCollection: false,
      meta: { displayName: '三体', downloadUrl: `${R2_BASE}/books/abc123` },
    };
    const shelf: Entry = {
      path: '/按书名/S/',
      isCollection: true,
      meta: { displayName: 'S' },
    };
    const html = renderBrowsePage('/按书名/', [shelf, book], '/dav');
    expect(html).toContain(`href="${R2_BASE}/books/abc123"`);
    expect(html).toContain(`href="/dav/${encodeURIComponent('按书名')}/S/"`);
  });
});

describe('encodeR2Key：逐段编码', () => {
  it('斜杠是层级分隔符，不能被编码成 %2F', () => {
    expect(encodeR2Key('books/abc123')).toBe('books/abc123');
    expect(encodeR2Key('books/a/b')).toBe('books/a/b');
    expect(encodeR2Key('books/a/b')).not.toContain('%2F');
  });

  it('中文段逐段编码，斜杠保留', () => {
    expect(encodeR2Key('books/三体.epub')).toBe('books/%E4%B8%89%E4%BD%93.epub');
    expect(encodeR2Key('书库/三体 全集.epub')).toBe(
      `%E4%B9%A6%E5%BA%93/%E4%B8%89%E4%BD%93%20%E5%85%A8%E9%9B%86.epub`,
    );
  });

  it('空格、井号、问号等会截断 URL 的字符被编码（否则对象 404）', () => {
    expect(encodeR2Key('books/a b#c?d.epub')).toBe('books/a%20b%23c%3Fd.epub');
  });
});

describe('contentDispositionFor：RFC 6266 + header 注入清洗', () => {
  /** 头值必须能原样塞进一个真实 Response —— workerd 会拒绝含 CR/LF 的头 */
  function asHeaderValue(value: string): string {
    const res = new Response('x', { headers: { 'content-disposition': value } });
    return res.headers.get('content-disposition') ?? '';
  }

  /**
   * 头值的合法形状，**锚定整串**、逐字符校验。
   *
   * ⚠️ 为什么不能只写「取出的 filename 里不含引号」：那种断言用
   * `/filename="([^"]*)"/` 抽取时，一旦清洗失效，`"` 会让引号**提前闭合**，
   * 捕获到的只是 `"` 之前的一小段（例如 `a`），于是「不含 `"`」自动成立 ——
   * 断言在读被测行为变坏的同一个瞬间变成了空转。
   * （变异测试验证过：把 lib/r2.ts 的 `raw.replace(UNSAFE_HEADER_CHARS, '_')`
   * 删掉，旧断言 0 条红。锚定整串后立刻转红。）
   *
   * `filename*` 的取值逐个字符限定在 RFC 5987 `attr-char` 与 `%XX` 之内，
   * 所以任何漏清洗的 `"`、`\`、控制字符都会让整串匹配失败。
   */
  const DISPOSITION_SHAPE =
    /^attachment; filename="[A-Za-z0-9._-]+"; filename\*=UTF-8''(?:[A-Za-z0-9!#$&+.^_`|~-]|%[0-9A-F]{2})+$/;

  it('中文书名：同时给 ASCII 兜底与 filename*（UTF-8 百分号编码）', () => {
    const value = contentDispositionFor('三体.epub');
    // 汉字按 UTF-8 百分号编码进 filename*，客户端拿到的就是「三体.epub」
    expect(value).toContain(`filename*=UTF-8''%E4%B8%89%E4%BD%93.epub`);
    // ASCII 兜底必须存在且是合法 quoted-string（整串锚定）
    expect(value).toMatch(DISPOSITION_SHAPE);
    expect(asHeaderValue(value)).toBe(value);
    // 原始非 ASCII 字节绝不能出现在头里（HTTP 头是 latin-1 字节流）
    expect(/[\u0080-\uffff]/.test(value)).toBe(false);
  });

  it('含引号 / 反斜杠 / CR / LF / 控制字符的书名被清洗，无 header 注入', () => {
    const nasty = 'a"b\\c\r\nSet-Cookie: x=1\rd\u0000e\u001f\u007f.txt';
    const value = contentDispositionFor(nasty);

    // 关键断言：真实 Response 能接受这个头值（含 CR/LF 会直接抛）
    expect(asHeaderValue(value)).toBe(value);
    expect(value).not.toContain('\r');
    expect(value).not.toContain('\n');
    // 整串形状：ASCII 兜底是合法 quoted-string，filename* 只含 attr-char 与 %XX。
    // 这一条同时兜住「引号被提前闭合」与「尾部反斜杠转义掉收尾引号」两种坏法。
    expect(value).toMatch(DISPOSITION_SHAPE);
    // quoted-string 内部不能出现未转义的 " 或 \
    const quoted = /filename="([^"]*)"/.exec(value);
    expect(quoted, 'ASCII 兜底 filename 必须是合法 quoted-string').toBeTruthy();
    expect(quoted![1]).not.toContain('"');
    expect(quoted![1]).not.toContain('\\');
    // 控制字符不得存活
    expect(/[\u0000-\u001f\u007f]/.test(value)).toBe(false);

    // 真正的防线是「CR/LF 没了」：把这段书名当头的值塞进一个真实 Response，
    // 不能凭空多出第二个头来。注入串里的字面文本（set-cookie）留在文件名里
    // 是无害的 —— 它只是名字的一部分，不会有头被解析出来。
    const res = new Response('x', { headers: { 'content-disposition': value } });
    expect(res.headers.get('set-cookie')).toBeNull();
    // 除了 Response 自己补的 content-type，不许出现第三个头
    expect([...res.headers.keys()].sort()).toEqual(['content-disposition', 'content-type']);
  });

  /**
   * 回归：**连续**引号 / 反斜杠 / 控制字符必须全部清洗掉。
   *
   * 这条抓的是 lib/r2.ts 里一个真实踩过的坑：清洗用带 `/g` 的正则，
   * 而 ASCII 兜底名里又用同一个正则做单字符 `.test()`。`/g` 的 `test()` 是有
   * 状态的 —— 命中一次推进 `lastIndex`，下一次从中间继续，于是长度 1 的字符
   * 被判成「安全」。具体路径：`"` 命中（lastIndex=1）→ 紧跟的控制字符走
   * `cp < 0x20` 分支、**不重置** lastIndex → 再紧跟的 `\` 从索引 1 起查 → false。
   * 结果 `filename="\.epub"`：一个尾部反斜杠把收尾引号转义掉，
   * `filename*` 参数被吞进 quoted-string 里。
   */
  it('连续的危险字符（引号紧跟反斜杠、控制字符夹在中间）全部被清洗', () => {
    for (const nasty of [
      'a"\\b.epub', // 引号紧跟反斜杠
      'a\r\\.epub', // 控制字符把两者隔开（触发 lastIndex 不重置的那条路径）
      'a"\\"\\x.epub', // 连续交替
      '\\".epub',
      'a\u0000"\\.epub',
    ]) {
      const value = contentDispositionFor(nasty);
      expect(asHeaderValue(value), `${JSON.stringify(nasty)} 必须能作为头值`).toBe(value);
      // 锚定整串：漏掉任何一个 " / \ 都会在这里暴露
      expect(value, `${JSON.stringify(nasty)} 的清洗结果形状必须完整合法`).toMatch(DISPOSITION_SHAPE);
      // 尾部反斜杠是最危险的一种残留：它会把收尾引号转义掉
      expect(value).not.toMatch(/\\"\s*;/);
      expect(/[\u0000-\u001f\u007f]/.test(value)).toBe(false);
    }
  });

  /**
   * 第二层防线必须能**独立**站住 —— 直接调 `asciiFallback`，喂未清洗的原始名。
   *
   * 为什么要绕过 `contentDispositionFor`：那个入口的第一层
   * （`sanitiseForHeader` 的 `replace`）会把 `"`、`\`、CR/LF 全部先换掉，
   * 于是第二层无论怎么写都会「看起来是对的」。真实发生过的就是这种情况 ——
   * `asciiFallback` 里用带 `/g` 的黑名单正则做单字符 `.test()`（有状态，
   * 隔一次才命中一次），却因为上游已经洗过而从未暴露。
   *
   * 这条测试的作用是：以后谁改了调用顺序、或者把 `asciiFallback` 拿去别处复用，
   * 这一层仍然被钉住。
   */
  it('第二层：asciiFallback 直接吃未清洗的书名，也不放任何裸引号 / 反斜杠 / 控制字符过去', () => {
    for (const raw of ['"'.repeat(6), '\\'.repeat(6), '"\\"\\"\\x.epub', 'a"\r"b.epub', '\u0000"\\\u007f.epub']) {
      const out = asciiFallback(raw);
      expect(out, `${JSON.stringify(raw)} → asciiFallback`).not.toMatch(/["\\]/);
      expect(/[\u0000-\u001f\u007f]/.test(out), `${JSON.stringify(raw)} 不应残留控制字符`).toBe(false);
      // 输出的每个字符都必须在白名单里（这就是「少列一个字符」也逃不掉的原因）
      for (const ch of out) {
        expect('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-', `非白名单字符 ${JSON.stringify(ch)} 出现在 ${JSON.stringify(out)}`).toContain(ch);
      }
    }
  });

  it('纯中文 / 无 ASCII 字母数字时，ASCII 兜底退回 download.<扩展名>', () => {
    const value = contentDispositionFor('三体.epub');
    expect(value).toContain('filename="download.epub"');
  });

  it('超长书名被压到上限内，扩展名保留', () => {
    const long = `${'长'.repeat(500)}.epub`;
    const value = contentDispositionFor(long);
    expect(asHeaderValue(value)).toBe(value);
    const star = /filename\*=UTF-8''(.+)$/.exec(value);
    expect(star).toBeTruthy();
    // filename* 的原始字符数（解码前约等于百分号编码的 3 倍）受上限约束
    const decoded = decodeURIComponent(star![1]!);
    expect(Array.from(decoded).length).toBeLessThanOrEqual(200);
    expect(decoded.endsWith('.epub')).toBe(true);
  });

  it('空名 / 只有下划线的名字退到 download，仍合法', () => {
    for (const name of ['', '   ', '...', '_']) {
      const value = contentDispositionFor(name);
      expect(asHeaderValue(value)).toBe(value);
      expect(value).toMatch(/^attachment; filename="[A-Za-z0-9._-]+"/);
    }
  });

  it('r2HttpMetadata 同时给出 contentType 与 contentDisposition', () => {
    expect(r2HttpMetadata('三体.epub')).toEqual({
      contentType: 'application/epub+zip',
      contentDisposition: contentDispositionFor('三体.epub'),
    });
    // 安全不变量：按扩展名推导，绝不用客户端声明（html 也不例外）
    expect(r2HttpMetadata('x.html').contentType).toBe('text/plain; charset=utf-8');
    expect(r2HttpMetadata('x.unknownext').contentType).toBe('application/octet-stream');
  });
});

describe('写 R2 的三条路径都带上 contentDisposition', () => {
  it('WebDAV PUT：中文书名 → 对象带下载名', async () => {
    const res = await dav('/recent/三体.epub', { method: 'PUT', body: 'x' });
    expect([201, 204]).toContain(res.status);
    const meta = await storedMeta('三体.epub');
    expect(meta.contentType).toBe('application/epub+zip');
    expect(meta.contentDisposition).toBe(contentDispositionFor('三体.epub'));
    expect(meta.contentDisposition).toContain("%E4%B8%89%E4%BD%93.epub");
  });

  it('WebDAV COPY：目标对象按目标扩展名带下载名', async () => {
    await dav('/recent/src.epub', { method: 'PUT', body: 'x' });
    // Destination 按真实客户端的方式做百分号编码（原始中文会让头变成非 ASCII）
    const target = `/dav/recent/${encodeURIComponent('拷贝版.epub')}`;
    const res = await dav('/recent/src.epub', {
      method: 'COPY',
      headers: { destination: `https://webooks.test${target}` },
    });
    expect(res.status).toBe(201);
    const meta = await storedMeta('拷贝版.epub');
    expect(meta.contentDisposition).toBe(contentDispositionFor('拷贝版.epub'));
    expect(meta.contentType).toBe('application/epub+zip');
  });

  it('网页上传 complete：搬到 books/ 时带上下载名', async () => {
    const key = 'uploads/2026-01-01/aaa111/raw.epub';
    await testEnv.BUCKET.put(key, new TextEncoder().encode('x'), {
      httpMetadata: { contentType: 'application/epub+zip' },
    });
    const res = await SELF.fetch(`${ORIGIN}/api/upload/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        key,
        filename: '三体.epub',
        size: 1,
        contentType: 'application/epub+zip',
      }),
    });
    expect(res.status).toBe(200);
    const meta = await storedMeta('三体.epub');
    expect(meta.contentDisposition).toBe(contentDispositionFor('三体.epub'));
    expect(meta.contentDisposition).toContain('%E4%B8%89%E4%BD%93.epub');
    // 客户端声明的 contentType 不可信：仍按扩展名推导
    expect(meta.contentType).toBe('application/epub+zip');

    // ── 键格式与 id 派生（2026-10-21）─────────────────────────────────
    // 这条守的是一个**极隐蔽**的回归：complete 端点曾经用
    //     id: bookKey.slice('books/'.length)
    // 反推 id。键改成两段式（`books/<id>/<书名>`）之后，slice 会把
    // 「id + 文件名」一起切出来 —— 于是 id 变成 `xxx/三体.epub`，
    // 接着被写进 D1、又拼成封面键 `covers/xxx/三体.epub.jpg`。
    // 整个流程照样「能跑」，每一行数据却是错的，而且没有任何报错。
    const row = await testEnv.DB.prepare('SELECT id, r2_key FROM books WHERE leaf_name = ?')
      .bind('三体.epub')
      .first<{ id: string; r2_key: string }>();
    const parts = row!.r2_key.split('/');
    // 键必须是 books / <id> / <文件名> 三段
    expect(parts).toHaveLength(3);
    // id 段必须等于 D1 里的 id，且**不含**斜杠（切片回归的直接症状）
    expect(parts[1]).toBe(row!.id);
    expect(row!.id).not.toContain('/');
    // 文件名段必须是可读书名 —— 这就是整个改动的目的
    expect(parts[2]).toBe('三体.epub');
  });

  it('封面对象不带 contentDisposition（它是 <img> 内联展示的）', async () => {
    // 必须**真的**造出一个封面对象，否则这条用例是空转（covers/ 下什么都没有，
    // 循环体一次都不执行，断言永远绿）—— 这里用最小的 stored-条目 EPUB。
    const epub = buildStoredEpub();
    const put = await dav('/recent/带封面.epub', {
      method: 'PUT',
      body: new Uint8Array(epub),
      headers: { 'content-type': 'application/epub+zip' },
    });
    expect([201, 204]).toContain(put.status);

    // 前置条件：封面确实被解析出来了（否则下面的断言是空转）
    const covers = await testEnv.BUCKET.list({ prefix: 'covers/' });
    expect(covers.objects.length, '没有解析出封面，本用例会假绿').toBeGreaterThan(0);

    for (const obj of covers.objects) {
      const head = await testEnv.BUCKET.head(obj.key);
      // 封面是给 <img src> 用的：带上 attachment 会让图片变成下载
      expect(head?.httpMetadata?.contentDisposition ?? '', `封面 ${obj.key}`).toBe('');
      // 封面自身的 Content-Type 来自字节嗅探（只可能是图片）
      expect(head?.httpMetadata?.contentType ?? '').toMatch(/^image\//);
    }
    // 顺带确认书本身是带下载名的（对照组，说明 helper 只对封面特别处理）
    const meta = await storedMeta('带封面.epub');
    expect(meta.contentDisposition).toContain('attachment;');
  });
});
