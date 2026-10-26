/** 纯函数单元测试：路径解析、分桶、元数据推导、PROPFIND 请求体解析。 */

import { describe, expect, it } from 'vitest';
import { CF_REQUEST_BODY_LIMIT, settings } from '../src/config';
import {
  bucketFromSegment,
  bucketSegment,
  canonicalDavPath,
  letterBucket,
  nodePath,
  normaliseFormat,
  resolveNode,
} from '../src/lib/collections';
import { deriveMetadata, preferContentType, sanitiseLeafName } from '../src/lib/metadata';
import { bookObjectKey, encodeR2Key } from '../src/lib/r2';
import { encodeHref, escapeXml } from '../src/lib/xml';
import { parsePropfindBody, resolveDepth } from '../src/webdav/propfind';
import type { Settings } from '../src/config';

const cfg = (over: Partial<Settings> = {}): Settings => ({
  r2PublicBase: 'https://books.test',
  adminToken: null,
  mountPath: '/dav',
  maxEntries: 200,
  propfindTtl: 300,
  depthInfinity: 'downgrade',
  maxUploadBytes: 200 * 1024 * 1024,
  dailyWriteQuota: 300,
  writeToken: null,
  ...over,
});

describe('letterBucket', () => {
  it('拉丁字母与数字', () => {
    expect(letterBucket('Dune')).toBe('D');
    expect(letterBucket('dune')).toBe('D');
    expect(letterBucket('1984')).toBe('0-9');
    expect(letterBucket('')).toBe('other');
    expect(letterBucket(null)).toBe('other');
  });

  it('中文按拼音首字母归桶（不再一律进 other）', () => {
    // 这是中文书库最关键的分类能力：以前所有中文书都堆在 other，等于没分类
    expect(letterBucket('三体')).toBe('S');
    expect(letterBucket('末世降临')).toBe('M');
    expect(letterBucket('呐喊')).toBe('N');
    expect(letterBucket('阿Q正传')).toBe('A');
    expect(letterBucket('围城')).toBe('W');
    expect(letterBucket('活着')).toBe('H');
    expect(letterBucket('天龙八部')).toBe('T');
    expect(letterBucket('红楼梦')).toBe('H');
  });

  it('跳过前导标点/空白，书名号不影响归桶', () => {
    expect(letterBucket('  三体')).toBe('S');
    expect(letterBucket('《呐喊》')).toBe('N');
    expect(letterBucket('【三体】')).toBe('S');
    expect(letterBucket('——活着')).toBe('H');
  });

  it('表里没有的文字才落 other', () => {
    // 日文假名、西里尔字母等在表外
    expect(letterBucket('あいう')).toBe('other');
    expect(letterBucket('Привет')).toBe('other');
    expect(letterBucket('!!!')).toBe('other');
    // 扩展 A 区的生僻字能识别就识别，识别不了也必须有确定结果（不崩）
    expect(typeof letterBucket('㐀')).toBe('string');
  });
});

describe('normaliseFormat', () => {
  it('归一化扩展名', () => {
    expect(normaliseFormat('.EPUB')).toBe('epub');
    expect(normaliseFormat('AZW')).toBe('azw3');
    expect(normaliseFormat('unknown-ext')).toBe('unknown-ext');
    expect(normaliseFormat('')).toBe('other');
  });
});

describe('resolveNode', () => {
  it('解析根、导航、列表、分页与叶子', () => {
    expect(resolveNode('/')).toEqual({ kind: 'root' });
    expect(resolveNode('/title/')).toEqual({ kind: 'nav', collection: 'title' });
    expect(resolveNode('/title/A/')).toEqual({
      kind: 'list', collection: 'title', bucket: 'A', page: 1,
    });
    expect(resolveNode('/title/A/2/')).toEqual({
      kind: 'list', collection: 'title', bucket: 'A', page: 2,
    });
    expect(resolveNode('/title/A/Dune.epub')).toEqual({
      kind: 'leaf', collection: 'title', bucket: 'A', leafName: 'Dune.epub',
    });
  });

  it('recent 是扁平集合，没有分桶层', () => {
    expect(resolveNode('/recent/')).toEqual({
      kind: 'list', collection: 'recent', bucket: 'all', page: 1,
    });
    expect(resolveNode('/recent/3/')).toEqual({
      kind: 'list', collection: 'recent', bucket: 'all', page: 3,
    });
    expect(resolveNode('/recent/Dune.epub')).toEqual({
      kind: 'leaf', collection: 'recent', bucket: 'all', leafName: 'Dune.epub',
    });
  });

  it('深度超过 3 层或未知集合返回 unknown', () => {
    expect(resolveNode('/nope/')).toEqual({ kind: 'unknown' });
    expect(resolveNode('/title/A/2/x/y')).toEqual({ kind: 'unknown' });
    expect(resolveNode('/recent/not-a-page/')).toEqual({ kind: 'unknown' });
  });

  it('URL 编码的路径会被解码', () => {
    expect(resolveNode('/title/A/%E4%B8%89%E4%BD%93.epub')).toEqual({
      kind: 'leaf', collection: 'title', bucket: 'A', leafName: '三体.epub',
    });
  });

  /**
   * 2026-10-26 真实事故：很多 WebDAV 客户端自己拼路径，二级目录的请求
   * **不带尾斜杠**（`/dav/按书名/A`、`/dav/最近收录/2`）。以前一律当叶子
   * → 404，表现为「第一层能进、第二层全打不开」。判据是「合法桶段/页码
   * 一定不带扩展名，而本站叶子一定带扩展名」。
   */
  it('无尾斜杠的合法桶段仍解析成目录（客户端兼容）', () => {
    expect(resolveNode('/title/A')).toEqual({
      kind: 'list', collection: 'title', bucket: 'A', page: 1,
    });
    // 中文桶段（「其他」）同样成立
    expect(resolveNode('/title/其他')).toEqual({
      kind: 'list', collection: 'title', bucket: 'other', page: 1,
    });
    expect(resolveNode('/按书名/A')).toEqual({
      kind: 'list', collection: 'title', bucket: 'A', page: 1,
    });
    // 有分桶集合下的分页目录
    expect(resolveNode('/title/A/2')).toEqual({
      kind: 'list', collection: 'title', bucket: 'A', page: 2,
    });
  });

  it('无尾斜杠的 recent 页码解析成目录', () => {
    expect(resolveNode('/recent/2')).toEqual({
      kind: 'list', collection: 'recent', bucket: 'all', page: 2,
    });
    expect(resolveNode('/最近收录/3')).toEqual({
      kind: 'list', collection: 'recent', bucket: 'all', page: 3,
    });
  });

  it('叶子判定不受影响：带扩展名的末段永远是叶子', () => {
    // 哪怕首字母恰好是桶名
    expect(resolveNode('/title/A/Dune.epub')).toEqual({
      kind: 'leaf', collection: 'title', bucket: 'A', leafName: 'Dune.epub',
    });
    expect(resolveNode('/recent/Dune.epub')).toEqual({
      kind: 'leaf', collection: 'recent', bucket: 'all', leafName: 'Dune.epub',
    });
    // 无尾斜杠 + 不是合法桶段 + 不是页码 → 仍是叶子（后续查不到就 404）
    expect(resolveNode('/title/不是桶')).toEqual({
      kind: 'leaf', collection: 'title', bucket: '不是桶', leafName: '不是桶',
    });
    expect(resolveNode('/recent/not-a-page')).toEqual({
      kind: 'leaf', collection: 'recent', bucket: 'all', leafName: 'not-a-page',
    });
  });

  it('nodePath 与 resolveNode 互相可逆（规范形式为中文段名）', () => {
    // nodePath 生成的是「规范形式」：集合与桶段都是中文
    const cases: Array<[string, string]> = [
      ['/', '/'],
      ['/title/', '/按书名/'],
      ['/按书名/', '/按书名/'],
      ['/title/A/', '/按书名/A/'],
      ['/title/A/3/', '/按书名/A/3/'],
      ['/recent/', '/最近收录/'],
      ['/recent/2/', '/最近收录/2/'],
    ];
    for (const [input, expected] of cases) {
      expect(nodePath(resolveNode(input)), input).toBe(expected);
    }
  });

  it('英文段名与中文段名指向同一个节点（旧链接兼容）', () => {
    expect(resolveNode('/recent/')).toEqual(resolveNode('/最近收录/'));
    expect(resolveNode('/title/A/')).toEqual(resolveNode('/按书名/A/'));
    expect(resolveNode('/recent/x.epub')).toEqual(resolveNode('/最近收录/x.epub'));
  });

  it('canonicalDavPath 把两种写法归一到同一个键', () => {
    // 缓存键与锁资源都用它，不归一会导致「失效打不中」「锁形同虚设」
    expect(canonicalDavPath('/recent/')).toBe('/最近收录/');
    expect(canonicalDavPath('/最近收录/')).toBe('/最近收录/');
    expect(canonicalDavPath('/title/A/')).toBe('/按书名/A/');
    expect(canonicalDavPath('/recent/x.epub')).toBe('/最近收录/x.epub');
    expect(canonicalDavPath('/')).toBe('/');
    // 未知集合原样返回，交给 resolveNode 判 unknown
    expect(canonicalDavPath('/nope/')).toBe('/nope/');
  });

  it('「其他」桶：路径段中文、内部 id 仍是 other', () => {
    expect(bucketSegment('other')).toBe('其他');
    expect(bucketFromSegment('其他')).toBe('other');
    expect(bucketSegment('A')).toBe('A');
    // 两种写法解析结果一致
    expect(resolveNode('/title/其他/')).toEqual(resolveNode('/title/other/'));
    expect(nodePath(resolveNode('/title/other/'))).toBe('/按书名/其他/');
  });
});

describe('encodeHref', () => {
  it('逐段编码并保留目录尾斜杠', () => {
    expect(encodeHref('/title/A/')).toBe('/title/A/');
    expect(encodeHref('/')).toBe('/');
    expect(encodeHref('/title/A/三体.epub')).toBe('/title/A/%E4%B8%89%E4%BD%93.epub');
    expect(encodeHref('/title/A/三体.epub', false)).not.toMatch(/\/$/);
  });
});

describe('escapeXml', () => {
  it('转义五个 XML 特殊字符', () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
  });
});

describe('sanitiseLeafName', () => {
  it('去掉路径分隔符、控制字符与 Windows 非法字符', () => {
    expect(sanitiseLeafName('a/b\\c.epub')).toBe('a_b_c.epub');
    expect(sanitiseLeafName('a:b*c?.epub')).toBe('a_b_c_.epub');
    expect(sanitiseLeafName('  spaced  name.epub ')).toBe('spaced name.epub');
  });

  it('拒绝空、点与点点', () => {
    expect(sanitiseLeafName('')).toBeNull();
    expect(sanitiseLeafName('   ')).toBeNull();
    expect(sanitiseLeafName('.')).toBeNull();
    expect(sanitiseLeafName('..')).toBeNull();
  });

  it('超长名称截断但保留扩展名', () => {
    const long = `${'x'.repeat(300)}.epub`;
    const out = sanitiseLeafName(long, 50)!;
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith('.epub')).toBe(true);
  });
});

describe('deriveMetadata', () => {
  it('从 "作者 - 书名.ext" 猜测作者与书名', () => {
    const m = deriveMetadata('Frank Herbert - Dune.epub');
    expect(m.author).toBe('Frank Herbert');
    expect(m.title).toBe('Dune');
    expect(m.format).toBe('epub');
    expect(m.contentType).toBe('application/epub+zip');
  });

  it('猜不到作者时不编造', () => {
    const m = deriveMetadata('Dune.epub');
    expect(m.author).toBeNull();
    expect(m.title).toBe('Dune');
  });

  it('下划线转空格', () => {
    expect(deriveMetadata('Liu_Cixin_-_The_Three_Body_Problem.epub').title)
      .toBe('The Three Body Problem');
  });

  it('未知扩展名归到 other 且用通用 content-type', () => {
    const m = deriveMetadata('book.xyz');
    expect(m.format).toBe('xyz');
    expect(m.contentType).toBe('application/octet-stream');
  });
});

describe('preferContentType', () => {
  it('客户端给泛型类型时让位给扩展名推导', () => {
    // fetch 发字符串 body 会自动带 text/plain，这对电子书毫无信息量
    expect(preferContentType('text/plain;charset=UTF-8', 'application/epub+zip'))
      .toBe('application/epub+zip');
    expect(preferContentType('application/octet-stream', 'application/pdf'))
      .toBe('application/pdf');
    expect(preferContentType(null, 'application/epub+zip')).toBe('application/epub+zip');
    expect(preferContentType('', 'application/pdf')).toBe('application/pdf');
  });

  it('客户端给具体类型时以客户端为准', () => {
    expect(preferContentType('application/x-mobipocket-ebook', 'application/pdf'))
      .toBe('application/x-mobipocket-ebook');
    // 带参数的具体类型完整保留
    expect(preferContentType('application/pdf; version=1.7', 'application/epub+zip'))
      .toBe('application/pdf; version=1.7');
  });
});

describe('parsePropfindBody', () => {
  it('空 body 视为 allprop', () => {
    expect(parsePropfindBody('')).toEqual({ mode: 'allprop', names: [] });
    expect(parsePropfindBody(null)).toEqual({ mode: 'allprop', names: [] });
  });

  it('识别 allprop / propname', () => {
    expect(parsePropfindBody('<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>').mode)
      .toBe('allprop');
    expect(parsePropfindBody('<D:propfind xmlns:D="DAV:"><D:propname/></D:propfind>').mode)
      .toBe('propname');
  });

  it('提取指定的属性名，去重并排序', () => {
    const body =
      '<D:propfind xmlns:D="DAV:"><D:prop>' +
      '<D:getcontentlength/><D:resourcetype/><D:getcontentlength/>' +
      '</D:prop></D:propfind>';
    expect(parsePropfindBody(body)).toEqual({
      mode: 'prop',
      names: ['getcontentlength', 'resourcetype'],
    });
  });

  it('无命名空间前缀也能解析', () => {
    const body = '<propfind xmlns="DAV:"><prop><getetag/></prop></propfind>';
    expect(parsePropfindBody(body)).toEqual({ mode: 'prop', names: ['getetag'] });
  });
});

describe('resolveDepth', () => {
  it('缺失按 1 处理（相对 RFC 4918 的有意偏离）', () => {
    expect(resolveDepth(null, cfg())).toEqual({ depth: 1 });
    expect(resolveDepth('', cfg())).toEqual({ depth: 1 });
  });

  it('0 和 1 原样返回', () => {
    expect(resolveDepth('0', cfg())).toEqual({ depth: 0 });
    expect(resolveDepth('1', cfg())).toEqual({ depth: 1 });
  });

  it('infinity 默认降级为 1，配置 deny 时拒绝', () => {
    expect(resolveDepth('infinity', cfg())).toEqual({ depth: 1 });
    expect(resolveDepth('infinity', cfg({ depthInfinity: 'deny' }))).toEqual({ rejected: true });
  });
});

/**
 * 配置默认值的一致性（回归测试）。
 *
 * wrangler.jsonc 曾经重复声明 6 个参数（DAV_MOUNT / MAX_ENTRIES /
 * PROPFIND_TTL / DEPTH_INFINITY / MAX_UPLOAD_BYTES / DAILY_WRITE_QUOTA），
 * 值与 src/config.ts 的默认值完全一致 —— 纯冗余，且有漂移风险。
 * 现在 wrangler.jsonc 只留唯一必填项 R2_PUBLIC_BASE，其余走代码默认值。
 *
 * 这条测试锁住两件事：
 *  1. 不传 vars 时 settings() 的结果 == 旧配置文件声明的值
 *  2. 代码里的常量与那些字面量一致
 * 将来谁改了 config.ts 的默认值，这里会立刻指出「文档/注释里的数字过时了」。
 */
describe('配置默认值与 wrangler.jsonc 精简', () => {
  const OLD_VARS = {
    DAV_MOUNT: '/dav',
    MAX_ENTRIES: '200',
    PROPFIND_TTL: '300',
    DEPTH_INFINITY: 'downgrade',
    MAX_UPLOAD_BYTES: '104857600',
    DAILY_WRITE_QUOTA: '300',
  } as const;

  const BASE = { R2_PUBLIC_BASE: 'https://books.example.com' } as never;

  it('不传 vars 时，settings 结果与旧配置逐项相同', () => {
    expect(settings(BASE)).toEqual(settings({ ...(BASE as object), ...OLD_VARS } as never));
  });

  it('代码默认值常量与旧配置字面量一致', () => {
    const s = settings(BASE);
    expect(s.mountPath).toBe(OLD_VARS.DAV_MOUNT);
    expect(s.maxEntries).toBe(Number(OLD_VARS.MAX_ENTRIES));
    expect(s.propfindTtl).toBe(Number(OLD_VARS.PROPFIND_TTL));
    expect(s.depthInfinity).toBe(OLD_VARS.DEPTH_INFINITY);
    expect(s.maxUploadBytes).toBe(Number(OLD_VARS.MAX_UPLOAD_BYTES));
    expect(s.dailyWriteQuota).toBe(Number(OLD_VARS.DAILY_WRITE_QUOTA));
  });

  it('R2_PUBLIC_BASE 仍然是必填（没默认值可退回）', () => {
    expect(() => settings({} as never)).toThrow(/R2_PUBLIC_BASE/);
  });

  it('仍然可以用 --var 临时覆盖任意参数', () => {
    // 精简的是配置文件，不是能力：显式传值依然生效
    const s = settings({ ...(BASE as object), PROPFIND_TTL: '60' } as never);
    expect(s.propfindTtl).toBe(60);
  });

  it('MAX_UPLOAD_BYTES 被 clamp 到 Cloudflare 请求体上限（配更大也不生效）', () => {
    // 这是删掉 wrangler.jsonc 那一项的直接理由之一：
    // 配置里写 200MiB 不会放宽任何东西，只会造成「以为生效了」的错觉。
    const s = settings({ ...(BASE as object), MAX_UPLOAD_BYTES: '209715200' } as never);
    expect(s.maxUploadBytes).toBe(CF_REQUEST_BODY_LIMIT);
  });
});

// ── 书籍对象键（2026-10-21：键里加可读文件名）───────────────────────────

describe('bookObjectKey', () => {
  it('键是 books/<id>/<文件名>，id 段与文件名段都可取', () => {
    // 这个格式的唯一目的：让走 S3 协议的客户端（rclone / aws-cli）落盘时
    // 拿到可读名字，而不是 `b01`。旧键 `books/<随机 id>` 没有扩展名，
    // 拉到本地打不开、也认不出是哪本书。
    const key = bookObjectKey('6ab0d114', '三体.epub');
    expect(key).toBe('books/6ab0d114/三体.epub');
    // 键的 basename 必须就是书名 —— S3 客户端只认这个
    expect(key.split('/').pop()).toBe('三体.epub');
  });

  it('文件名含路径分隔符时被清洗成单段，不会多出层级', () => {
    // 书名是用户可控的：`../../etc/passwd` 若原样进键，就多出层级甚至穿越。
    // sanitiseLeafName 把 `/` 与 `\` 换成 `_`，所以结果永远是**单段**。
    //
    // ⚠️ 注意这里**不能**断言「键里不含 `..`」：清洗后的名字是
    //    `.._.._etc_passwd.epub`，里面仍然有字面的 `..`，但它**只是普通字符**
    //    （同一段内），没有任何穿越含义 —— 穿越的前提是 `..` 独立成段。
    //    真正的判据是「段数」与「没有独立成段的 ..」，不是子串。
    const key = bookObjectKey('abc', '../../etc/passwd.epub');
    const parts = key.split('/');
    expect(parts).toHaveLength(3); // books / abc / <一段>
    expect(parts[1]).toBe('abc');
    // 关键：没有任何一段**恰好**是 .. 或 .
    expect(parts.some((s) => s === '..' || s === '.')).toBe(false);
    expect(parts[2]).toBe('.._.._etc_passwd.epub');
  });

  it('清洗后为空时退回 book，绝不产出带 .. 的键', () => {
    const key = bookObjectKey('abc', '..');
    expect(key).toBe('books/abc/book');
    expect(key).not.toContain('..');
  });

  it('键必须逐段编码后才能进 URL（含中文）', () => {
    const key = bookObjectKey('abc', '三体.epub');
    const url = encodeR2Key(key);
    // 斜杠是层级分隔符，不能被编码成 %2F
    expect(url.startsWith('books/abc/')).toBe(true);
    expect(url).toContain('%E4%B8%89%E4%BD%93');
    expect(url).not.toContain('%2F');
  });
});
