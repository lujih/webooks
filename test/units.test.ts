/** 纯函数单元测试：路径解析、分桶、元数据推导、PROPFIND 请求体解析。 */

import { describe, expect, it } from 'vitest';
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
