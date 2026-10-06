/**
 * SigV4 预签名 URL 测试。
 *
 * 这是上传链路最容易出错且最难排查的部分（签名错了只会得到 R2 的 403），
 * 所以单测要覆盖到：URL 结构、必需参数、签名确定性、content-type 绑定、有效期边界。
 */

import { describe, expect, it } from 'vitest';
import { createPresignedPutUrl } from '../src/lib/sigv4';

const base = {
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secretExampleKey',
  accountId: 'account123',
  bucket: 'my-bucket',
  key: 'uploads/20261006/abc/Book.epub',
  amzDate: '20261006T153000Z',
};

function parse(url: string): URL {
  return new URL(url);
}

describe('createPresignedPutUrl', () => {
  it('构造出正确的 R2 S3 端点与路径', async () => {
    const url = await createPresignedPutUrl(base);
    const u = parse(url);
    expect(u.hostname).toBe('account123.r2.cloudflarestorage.com');
    expect(u.pathname).toBe('/my-bucket/uploads/20261006/abc/Book.epub');
  });

  it('包含 SigV4 必需的全部查询参数', async () => {
    const u = parse(await createPresignedPutUrl(base));
    expect(u.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(u.searchParams.get('X-Amz-Credential')).toBe(
      'AKIAEXAMPLE/20261006/auto/s3/aws4_request',
    );
    expect(u.searchParams.get('X-Amz-Date')).toBe('20261006T153000Z');
    expect(u.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('同一输入产生完全相同的签名（确定性）', async () => {
    const a = await createPresignedPutUrl(base);
    const b = await createPresignedPutUrl(base);
    expect(a).toBe(b);
  });

  it('不同密钥产生不同签名', async () => {
    const a = await createPresignedPutUrl(base);
    const b = await createPresignedPutUrl({ ...base, secretAccessKey: 'differentSecret' });
    expect(a).not.toBe(b);
  });

  it('指定 contentType 时把它绑定进签名头', async () => {
    const u = parse(await createPresignedPutUrl({ ...base, contentType: 'application/epub+zip' }));
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
  });

  it('expiresIn 被限制在 S3 合法区间', async () => {
    const tooBig = parse(await createPresignedPutUrl({ ...base, expiresIn: 999_999 }));
    expect(tooBig.searchParams.get('X-Amz-Expires')).toBe('604800');
    const tooSmall = parse(await createPresignedPutUrl({ ...base, expiresIn: 0 }));
    expect(tooSmall.searchParams.get('X-Amz-Expires')).toBe('1');
  });

  it('对象键被 URL 编码，中文与特殊字符不破坏查询串', async () => {
    const u = parse(
      await createPresignedPutUrl({ ...base, key: 'uploads/书 名 &符号#1.epub' }),
    );
    // pathname 中非 ASCII 被编码；特殊字符在 query 中正确编码
    expect(u.pathname).toContain('%E4%B9%A6');
    // query 部分不出现裸 & 之外的冲突（签名本身是 hex，不含 & =）
    expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('签名对 key 的改动敏感', async () => {
    const a = await createPresignedPutUrl(base);
    const b = await createPresignedPutUrl({ ...base, key: 'uploads/20261006/abc/Other.epub' });
    expect(a).not.toBe(b);
  });
});