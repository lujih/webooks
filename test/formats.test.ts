/**
 * 上传格式白名单：只允许电子书 + 漫画。
 *
 * 背景（真实漏洞）：网页上传有一份白名单，但 **WebDAV PUT 完全没有检查**，
 * 于是任何文件都能绕过网页限制塞进书库。两处必须共用同一份定义，
 * 这个测试同时覆盖两条入口，防止将来又只改一边。
 */

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_UPLOAD_FORMATS,
  AUDIO_FORMATS,
  COMIC_FORMATS,
  EBOOK_FORMATS,
  isAllowedUploadExt,
  mediaKindOfFormat,
  normaliseFormat,
} from '../src/lib/collections';
import { clearDavCache, resetLibrary } from './setup';

const ORIGIN = 'https://webooks.test';

function put(path: string, body = 'x'): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/dav${path}`, {
    method: 'PUT',
    headers: {
      authorization: 'Bearer test-write-token',
      'content-type': 'application/octet-stream',
    },
    body,
  });
}

beforeEach(async () => {
  await resetLibrary();
  await clearDavCache(['/', '/最近收录/']);
});

describe('格式清单本身', () => {
  it('白名单 = 电子书 + 漫画，且不含音频与通用压缩包', () => {
    expect(ALLOWED_UPLOAD_FORMATS).toEqual([...EBOOK_FORMATS, ...COMIC_FORMATS]);
    for (const f of AUDIO_FORMATS) {
      expect(ALLOWED_UPLOAD_FORMATS).not.toContain(f);
    }
    expect(ALLOWED_UPLOAD_FORMATS).not.toContain('zip');
  });

  it('扩展名别名按归一化后的格式判定（azw 走 azw3）', () => {
    expect(isAllowedUploadExt('azw')).toBe(true);
    expect(isAllowedUploadExt('.AZW3')).toBe(true);
    expect(isAllowedUploadExt('epub')).toBe(true);
    expect(isAllowedUploadExt('cbz')).toBe(true);
    expect(isAllowedUploadExt('djv')).toBe(true); // → djvu
    expect(isAllowedUploadExt('exe')).toBe(false);
    expect(isAllowedUploadExt('zip')).toBe(false);
    expect(isAllowedUploadExt('mp3')).toBe(false);
    expect(isAllowedUploadExt('')).toBe(false);
    expect(isAllowedUploadExt(null)).toBe(false);
  });

  it('大类判定与「按类型」桶一致', () => {
    expect(mediaKindOfFormat(normaliseFormat('epub'))).toBe('ebook');
    expect(mediaKindOfFormat(normaliseFormat('pdf'))).toBe('ebook');
    expect(mediaKindOfFormat(normaliseFormat('cbz'))).toBe('comic');
    expect(mediaKindOfFormat(normaliseFormat('cbr'))).toBe('comic');
    expect(mediaKindOfFormat(normaliseFormat('mp3'))).toBe('audio');
  });
});

describe('WebDAV PUT 的格式白名单', () => {
  it('电子书格式允许', async () => {
    for (const name of ['a.epub', 'b.pdf', 'c.mobi', 'd.azw3', 'e.txt', 'f.fb2']) {
      const res = await put(`/最近收录/${name}`);
      expect(res.status, name).toBe(201);
    }
  });

  it('漫画格式允许', async () => {
    for (const name of ['x.cbz', 'y.cbr', 'z.cb7']) {
      const res = await put(`/最近收录/${name}`);
      expect(res.status, name).toBe(201);
    }
  });

  it('可执行文件与脚本被拒（这是网页上传早就拦了、WebDAV 曾漏掉的）', async () => {
    for (const name of ['evil.exe', 'evil.sh', 'evil.php', 'evil.js', 'evil.bat', 'evil.dll']) {
      const res = await put(`/最近收录/${name}`);
      expect(res.status, name).toBe(415);
      await res.text();
    }
  });

  it('通用压缩包与音频被拒', async () => {
    for (const name of ['bundle.zip', 'song.mp3', 'audio.m4b', 'archive.rar', 'pkg.7z']) {
      const res = await put(`/最近收录/${name}`);
      expect(res.status, name).toBe(415);
      await res.text();
    }
  });

  it('415 响应里列出允许的格式，便于用户自查', async () => {
    const res = await put('/最近收录/evil.exe');
    const body = await res.text();
    expect(body).toContain('epub');
    expect(body).toContain('cbz');
    expect(body).toContain('电子书');
  });

  it('无扩展名被拒', async () => {
    const res = await put('/最近收录/noextension');
    expect(res.status).toBe(415);
    await res.text();
  });

  it('被拒的文件不会写进书库', async () => {
    await put('/最近收录/evil.exe');
    const res = await SELF.fetch(`${ORIGIN}/dav/最近收录/`, {
      method: 'PROPFIND',
      headers: { depth: '1', 'content-type': 'application/xml' },
      body: '<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>',
    });
    const xml = await res.text();
    expect(xml).not.toContain('evil.exe');
  });
});

describe('网页上传接口的格式白名单', () => {
  function init(filename: string): Promise<Response> {
    return SELF.fetch(`${ORIGIN}/api/upload/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename, size: 100, turnstileToken: 'x' }),
    });
  }

  it('非书籍格式在配置校验阶段就被拒（415）', async () => {
    for (const name of ['evil.exe', 'bundle.zip', 'song.mp3', 'noext']) {
      const res = await init(name);
      expect(res.status, name).toBe(415);
      const j = await res.json() as { error?: string; allowed?: string[] };
      expect(j.error).toBe('unsupported-format');
      expect(Array.isArray(j.allowed)).toBe(true);
    }
  });

  it('允许的格式会通过格式检查并走到签发环节', async () => {
    // 把 siteverify 的 fetch 换成桩：测试只关心「格式检查是否放行」，
    // 不该真的去请求 Cloudflare（沙箱里会超时 5 秒，且结果不确定）。
    const original = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ success: false }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    try {
      const res = await init('book.epub');
      const j = (await res.json()) as { error?: string; ticket?: string; uploadUrl?: string };
      // 没有报 unsupported-format，且已经签出预签名 URL / 通行证 ——
      // 说明格式检查放行了。（以前这里断言 turnstile-failed，
      // 那是把「必须有人机验证」写成了断言，与现在的默认行为不符。）
      expect(j.error).not.toBe('unsupported-format');
      expect(j.uploadUrl ?? j.ticket).toBeTruthy();
    } finally {
      vi.stubGlobal('fetch', original);
    }
  });
});
