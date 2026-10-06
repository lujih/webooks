/**
 * AWS Signature Version 4 —— 只实现生成 R2 预签名 PUT URL 所必需的部分。
 *
 * 为什么不用 aws4fetch / @aws-sdk：这两个包会显著增大 Worker 体积（超出免费版
 * 1MB 压缩限制的风险），而这里只需要「对一个 PUT 生成签名 URL」，几十行就够了。
 * crypto.subtle 在 Workers 里原生支持 HMAC-SHA256，无需 node:crypto。
 *
 * 参考：https://developers.cloudflare.com/r2/api/s3/presigned-urls/
 */

const SERVICE = 's3';
const ALGORITHM = 'AWS4-HMAC-SHA256';

export interface PresignInput {
  accessKeyId: string;
  secretAccessKey: string;
  accountId: string;
  bucket: string;
  /** 对象键（已 URL 编码的路径） */
  key: string;
  /** PUT 时限定 content-type，可选 */
  contentType?: string;
  /** 有效期秒数，1 ~ 604800（7 天）。这里用 15 分钟。 */
  expiresIn?: number;
  /** 单次请求唯一标识，建议用 UUIDv4 */
  amzDate: string;
}

interface AmzParts {
  dateStamp: string;
  region: string;
  service: string;
}

function hmac(key: Uint8Array | string, data: string): Promise<ArrayBuffer> {
  const material: BufferSource =
    typeof key === 'string' ? new TextEncoder().encode(key) as BufferSource : (key as BufferSource);
  return crypto.subtle
    .importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    .then((cryptoKey) =>
      crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data) as BufferSource),
    );
}

async function toHex(buf: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** RFC 3986 编码：比 encodeURIComponent 更严格，空格转 %20 而非 + */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * 把对象键编码成 URL 路径。
 * 必须逐段编码：文件名里的 # / ? / & 会破坏 URL 结构
 * （# 之后会被当成 fragment，签名直接丢失）。
 * 同时这也是 SigV4 CanonicalURI 要求的编码形式。
 */
function encodeKeyPath(key: string): string {
  return key
    .split('/')
    .map((segment) => uriEncode(segment))
    .join('/');
}

function splitAmzDate(amzDate: string): AmzParts {
  // amzDate 形如 20261006T153000Z
  return {
    dateStamp: amzDate.slice(0, 8),
    region: 'auto', // R2 固定
    service: SERVICE,
  };
}

/**
 * 生成一个「单次 PUT」的预签名 URL。
 * 浏览器拿这个 URL 直接把字节 PUT 到 R2，绕过 Worker，也绕过 zone 的 100MB 请求体上限。
 */
export async function createPresignedPutUrl(input: PresignInput): Promise<string> {
  const { accessKeyId, secretAccessKey, accountId, bucket, key, contentType, amzDate } = input;
  const expiresIn = Math.min(Math.max(input.expiresIn ?? 900, 1), 604800);
  const { dateStamp } = splitAmzDate(amzDate);
  const credentialScope = `${dateStamp}/auto/${SERVICE}/aws4_request`;
  const host = `${accountId}.r2.cloudflarestorage.com`;
  // 逐段编码后的对象键：既用于签名（SigV4 规定 canonical URI 用编码形式），
  // 也用于最终 URL —— 否则文件名里的 # 会把签名截断成 fragment。
  const encodedKey = encodeKeyPath(key);

  // 1. Canonical request
  const signedHeaders = 'host';
  const queryParams: Record<string, string> = {
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': signedHeaders,
  };
  if (contentType) queryParams['X-Amz-SignedHeaders'] = 'content-type;host';

  const canonicalQuery = Object.keys(queryParams)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(queryParams[k] as string)}`)
    .join('&');

  const canonicalHeaders = contentType
    ? `content-type:${contentType}\nhost:${host}\n`
    : `host:${host}\n`;
  const canonicalRequest = [
    'PUT',
    `/${encodedKey}`,
    canonicalQuery,
    canonicalHeaders,
    contentType ? 'content-type;host' : 'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  // 2. String to sign
  const hashedCanonicalRequest = await toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalRequest) as BufferSource));
  const stringToSign = [ALGORITHM, amzDate, credentialScope, hashedCanonicalRequest].join('\n');

  // 3. Signing key
  const kDate = await hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = await hmac(new Uint8Array(kDate), 'auto');
  const kService = await hmac(new Uint8Array(kRegion), SERVICE);
  const kSigning = await hmac(new Uint8Array(kService), 'aws4_request');
  const signature = await toHex(await hmac(new Uint8Array(kSigning), stringToSign));

  const finalQuery = `${canonicalQuery}&X-Amz-Signature=${signature}`;
  return `https://${host}/${bucket}/${encodedKey}?${finalQuery}`;
}