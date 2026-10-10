var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/lib/collections.ts
var COLLECTION_IDS = ["title", "author", "format", "recent"];
var COLLECTIONS = {
  title: { id: "title", label: "\u6309\u4E66\u540D", bucketed: true },
  author: { id: "author", label: "\u6309\u4F5C\u8005", bucketed: true },
  format: { id: "format", label: "\u6309\u683C\u5F0F", bucketed: true },
  recent: { id: "recent", label: "\u6700\u8FD1\u6536\u5F55", bucketed: false }
};
function isCollectionId(value) {
  return COLLECTION_IDS.includes(value);
}
__name(isCollectionId, "isCollectionId");
var LETTER_BUCKETS = [
  "0-9",
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
  "other"
];
function letterBucket(input) {
  const text = (input ?? "").trim();
  const m = text.match(/[A-Za-z0-9\u4e00-\u9fff]/);
  if (!m) return "other";
  const ch = m[0];
  if (ch >= "A" && ch <= "Z") return ch;
  if (ch >= "a" && ch <= "z") return ch.toUpperCase();
  if (ch >= "0" && ch <= "9") return "0-9";
  return "other";
}
__name(letterBucket, "letterBucket");
function bucketLabel(bucket) {
  if (bucket === "other") return "\u5176\u4ED6\uFF08\u542B\u4E2D\u6587\uFF09";
  return bucket;
}
__name(bucketLabel, "bucketLabel");
var FORMAT_MAP = {
  epub: "epub",
  pdf: "pdf",
  mobi: "mobi",
  azw: "azw3",
  azw3: "azw3",
  fb2: "fb2",
  djvu: "djvu",
  txt: "txt",
  rtf: "rtf",
  doc: "doc",
  docx: "docx",
  cbz: "cbz",
  cbr: "cbr",
  m4a: "m4a",
  m4b: "m4b",
  mp3: "mp3",
  zip: "zip",
  md: "md",
  html: "html"
};
function normaliseFormat(ext) {
  const key = (ext ?? "").trim().toLowerCase().replace(/^\./, "");
  return FORMAT_MAP[key] ?? (key || "other");
}
__name(normaliseFormat, "normaliseFormat");
function isPageSegment(seg) {
  return /^[1-9][0-9]{0,4}$/.test(seg);
}
__name(isPageSegment, "isPageSegment");
function splitPath(pathname) {
  const trailingSlash = pathname.length > 1 && pathname.endsWith("/");
  const segments = pathname.split("/").filter((s) => s.length > 0).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  return { segments, trailingSlash };
}
__name(splitPath, "splitPath");
function resolveNode(pathname) {
  const { segments, trailingSlash } = splitPath(pathname);
  if (segments.length === 0) return { kind: "root" };
  const rawCollection = segments[0];
  if (!isCollectionId(rawCollection)) return { kind: "unknown" };
  const collection = rawCollection;
  const def = COLLECTIONS[collection];
  if (segments.length === 1) {
    if (!def.bucketed) return { kind: "list", collection, bucket: "all", page: 1 };
    return { kind: "nav", collection };
  }
  const seg1 = segments[1];
  if (segments.length === 2) {
    if (def.bucketed) {
      if (trailingSlash) return { kind: "list", collection, bucket: seg1, page: 1 };
      return { kind: "leaf", collection, bucket: seg1, leafName: seg1 };
    }
    if (trailingSlash) {
      if (isPageSegment(seg1)) return { kind: "list", collection, bucket: "all", page: Number(seg1) };
      return { kind: "unknown" };
    }
    return { kind: "leaf", collection, bucket: "all", leafName: seg1 };
  }
  if (segments.length === 3) {
    if (!def.bucketed) return { kind: "unknown" };
    const seg2 = segments[2];
    if (trailingSlash) {
      if (isPageSegment(seg2)) return { kind: "list", collection, bucket: seg1, page: Number(seg2) };
      return { kind: "unknown" };
    }
    return { kind: "leaf", collection, bucket: seg1, leafName: seg2 };
  }
  return { kind: "unknown" };
}
__name(resolveNode, "resolveNode");
function nodePath(node) {
  switch (node.kind) {
    case "root":
      return "/";
    case "nav":
      return `/${node.collection}/`;
    case "list": {
      const def = COLLECTIONS[node.collection];
      if (!def.bucketed) return node.page === 1 ? `/${node.collection}/` : `/${node.collection}/${node.page}/`;
      return node.page === 1 ? `/${node.collection}/${node.bucket}/` : `/${node.collection}/${node.bucket}/${node.page}/`;
    }
    case "leaf": {
      const def = COLLECTIONS[node.collection];
      return def.bucketed ? `/${node.collection}/${node.bucket}/${node.leafName}` : `/${node.collection}/${node.leafName}`;
    }
    default:
      return "/";
  }
}
__name(nodePath, "nodePath");

// src/lib/db.ts
var BOOK_COLUMNS = `id, leaf_name, title, author, language, format, content_type, size,
  sha256, r2_key, etag, title_letter, author_letter, format_bucket, published_at,
  created_at, updated_at, status, cover_key, description`;
async function listBucketTotals(db, collection) {
  const { results } = await db.prepare(
    `SELECT bucket, total FROM buckets
        WHERE collection = ? AND total > 0
        ORDER BY bucket`
  ).bind(collection).all();
  return results ?? [];
}
__name(listBucketTotals, "listBucketTotals");
async function getBucketTotal(db, collection, bucket) {
  const row = await db.prepare(`SELECT total FROM buckets WHERE collection = ? AND bucket = ?`).bind(collection, bucket).first();
  return row?.total ?? 0;
}
__name(getBucketTotal, "getBucketTotal");
async function listBooks(db, collection, bucket, offset, limit) {
  const base = `SELECT ${BOOK_COLUMNS} FROM books WHERE status = 'published'`;
  const paging = `LIMIT ? OFFSET ?`;
  let stmt;
  switch (collection) {
    case "title":
      stmt = db.prepare(`${base} AND title_letter = ? ORDER BY title, id ${paging}`).bind(bucket, limit, offset);
      break;
    case "author":
      stmt = db.prepare(`${base} AND author_letter = ? ORDER BY author, title, id ${paging}`).bind(bucket, limit, offset);
      break;
    case "format":
      stmt = db.prepare(`${base} AND format_bucket = ? ORDER BY title, id ${paging}`).bind(bucket, limit, offset);
      break;
    case "recent":
      stmt = db.prepare(`${base} ORDER BY published_at DESC, id ${paging}`).bind(limit, offset);
      break;
  }
  const { results } = await stmt.all();
  return results ?? [];
}
__name(listBooks, "listBooks");
async function findBookByLeaf(db, leafName) {
  const row = await db.prepare(`SELECT ${BOOK_COLUMNS} FROM books WHERE leaf_name = ? AND status = 'published'`).bind(leafName).first();
  return row ?? null;
}
__name(findBookByLeaf, "findBookByLeaf");
function upsertBookStatement(db, b) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  return db.prepare(
    `INSERT INTO books (id, leaf_name, title, author, language, format, content_type, size,
         sha256, r2_key, etag, title_letter, author_letter, format_bucket, published_at,
          cover_key, description, created_at, updated_at, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         leaf_name = excluded.leaf_name,
         title = excluded.title,
         author = excluded.author,
         language = excluded.language,
         format = excluded.format,
         content_type = excluded.content_type,
         size = excluded.size,
         sha256 = excluded.sha256,
         r2_key = excluded.r2_key,
         etag = excluded.etag,
         title_letter = excluded.title_letter,
         author_letter = excluded.author_letter,
         format_bucket = excluded.format_bucket,
         published_at = excluded.published_at,
         updated_at = excluded.updated_at,
         status = excluded.status`
  ).bind(
    b.id,
    b.leafName,
    b.title,
    b.author,
    b.language,
    b.format,
    b.contentType,
    b.size,
    b.sha256,
    b.r2Key,
    b.etag,
    b.titleLetter,
    b.authorLetter,
    b.formatBucket,
    b.publishedAt,
    b.coverKey ?? null,
    b.description ?? null,
    now,
    now,
    b.status ?? "published"
  );
}
__name(upsertBookStatement, "upsertBookStatement");
async function upsertBook(db, b) {
  await upsertBookStatement(db, b).run();
}
__name(upsertBook, "upsertBook");
async function deleteBook(db, id) {
  await db.prepare(`DELETE FROM books WHERE id = ?`).bind(id).run();
}
__name(deleteBook, "deleteBook");
async function rebuildBuckets(db) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const statements = [
    db.prepare(`DELETE FROM buckets`),
    db.prepare(
      `INSERT INTO buckets (collection, bucket, total, updated_at)
       SELECT 'title', title_letter, COUNT(*), ?
         FROM books WHERE status = 'published' GROUP BY title_letter`
    ).bind(now),
    db.prepare(
      `INSERT INTO buckets (collection, bucket, total, updated_at)
       SELECT 'author', author_letter, COUNT(*), ?
         FROM books WHERE status = 'published' GROUP BY author_letter`
    ).bind(now),
    db.prepare(
      `INSERT INTO buckets (collection, bucket, total, updated_at)
       SELECT 'format', format_bucket, COUNT(*), ?
         FROM books WHERE status = 'published' GROUP BY format_bucket`
    ).bind(now),
    db.prepare(
      `INSERT INTO buckets (collection, bucket, total, updated_at)
       SELECT 'recent', 'all', COUNT(*), ?
         FROM books WHERE status = 'published'`
    ).bind(now)
  ];
  await db.batch(statements);
}
__name(rebuildBuckets, "rebuildBuckets");

// src/lib/http.ts
var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec"
];
function httpDate(input) {
  const d = input == null ? /* @__PURE__ */ new Date() : new Date(input);
  const t = Number.isNaN(d.getTime()) ? /* @__PURE__ */ new Date() : d;
  const pad = /* @__PURE__ */ __name((n) => String(n).padStart(2, "0"), "pad");
  return `${DAYS[t.getUTCDay()]}, ${pad(t.getUTCDate())} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())} GMT`;
}
__name(httpDate, "httpDate");
function isoDate(input) {
  const d = input == null ? /* @__PURE__ */ new Date() : new Date(input);
  const t = Number.isNaN(d.getTime()) ? /* @__PURE__ */ new Date() : d;
  return t.toISOString();
}
__name(isoDate, "isoDate");
function textResponse(status, message, headers = {}) {
  return new Response(`${message}
`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers }
  });
}
__name(textResponse, "textResponse");
function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });
}
__name(jsonResponse, "jsonResponse");
function methodNotAllowed(allow) {
  return textResponse(405, "Method Not Allowed", { allow });
}
__name(methodNotAllowed, "methodNotAllowed");
function multistatusResponse(xml, ttl) {
  const headers = {
    "content-type": "application/xml; charset=utf-8",
    // 让 Cache API 按这个 TTL 保存；这是免费方案里最关键的缓存头
    "cache-control": ttl > 0 ? `public, max-age=${ttl}` : "no-store"
  };
  return new Response(xml, { status: 207, headers });
}
__name(multistatusResponse, "multistatusResponse");
function shortId(bytes = 8) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
__name(shortId, "shortId");

// src/lib/metadata.ts
var CONTENT_TYPES = {
  epub: "application/epub+zip",
  pdf: "application/pdf",
  mobi: "application/x-mobipocket-ebook",
  azw3: "application/vnd.amazon.ebook",
  azw: "application/vnd.amazon.ebook",
  fb2: "application/fb2+xml",
  djvu: "image/vnd.djvu",
  txt: "text/plain; charset=utf-8",
  rtf: "application/rtf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  cbz: "application/vnd.comicbook+zip",
  cbr: "application/vnd.comicbook-rar",
  m4a: "audio/mp4",
  m4b: "audio/mp4",
  mp3: "audio/mpeg",
  zip: "application/zip",
  md: "text/markdown; charset=utf-8",
  html: "text/html; charset=utf-8"
};
function extensionOf(name) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}
__name(extensionOf, "extensionOf");
function contentTypeFor(ext) {
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}
__name(contentTypeFor, "contentTypeFor");
var GENERIC_TYPES = /* @__PURE__ */ new Set([
  "",
  "text/plain",
  "application/octet-stream",
  "binary/octet-stream"
]);
function preferContentType(headerValue, derived) {
  const raw = (headerValue ?? "").trim();
  const essence = raw.split(";")[0].trim().toLowerCase();
  return GENERIC_TYPES.has(essence) ? derived : raw;
}
__name(preferContentType, "preferContentType");
function sanitiseLeafName(raw, maxLength = 200) {
  let name = raw.trim();
  if (!name) return null;
  name = name.replace(/[/\\\u0000-\u001f\u007f]/g, "_");
  name = name.replace(/[<>:"|?*]/g, "_");
  name = name.replace(/\s+/g, " ").trim();
  if (!name || name === "." || name === "..") return null;
  if (name.length > maxLength) {
    const ext = extensionOf(name);
    const keep = maxLength - (ext ? ext.length + 1 : 0);
    name = ext ? `${name.slice(0, Math.max(keep, 1))}.${ext}` : name.slice(0, maxLength);
  }
  return name;
}
__name(sanitiseLeafName, "sanitiseLeafName");
function guessAuthor(stem) {
  for (const sep of [" - ", " \u2013 ", " \u2014 ", " by "]) {
    const idx = stem.indexOf(sep);
    if (idx > 0 && idx < stem.length - sep.length) {
      const author = stem.slice(0, idx).trim();
      const title = stem.slice(idx + sep.length).trim();
      if (author && title) return { author, title };
    }
  }
  return { author: null, title: stem };
}
__name(guessAuthor, "guessAuthor");
function deriveMetadata(leafName) {
  const ext = extensionOf(leafName);
  const stem = ext ? leafName.slice(0, -(ext.length + 1)) : leafName;
  const cleanedStem = stem.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim() || stem;
  const { author, title } = guessAuthor(cleanedStem);
  const format = normaliseFormat(ext);
  return { title: title || cleanedStem || leafName, author, format, contentType: contentTypeFor(ext), extension: ext };
}
__name(deriveMetadata, "deriveMetadata");
function leafNameFromKey(key) {
  const base = key.split("/").filter(Boolean).pop() ?? key;
  return base;
}
__name(leafNameFromKey, "leafNameFromKey");
async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex, "sha256Hex");

// src/lib/cache.ts
var CACHE_HOST = "https://webooks.invalid";
function davCache() {
  try {
    return typeof caches !== "undefined" && "default" in caches ? caches.default : null;
  } catch {
    return null;
  }
}
__name(davCache, "davCache");
function entriesCacheKey(davPath, depth) {
  return `${CACHE_HOST}/dav-entries?p=${encodeURIComponent(davPath)}&d=${depth}`;
}
__name(entriesCacheKey, "entriesCacheKey");
async function purgeEntries(targets) {
  const cache = davCache();
  if (!cache) return 0;
  const keys = /* @__PURE__ */ new Set();
  for (const [path, depth] of targets) keys.add(entriesCacheKey(path, depth));
  let removed = 0;
  for (const key of keys) {
    if (await cache.delete(key)) removed++;
  }
  return removed;
}
__name(purgeEntries, "purgeEntries");
function bookCacheTargets(book) {
  const { leafName, titleLetter, authorLetter, formatBucket } = book;
  const leaf = /* @__PURE__ */ __name((p) => [[p, 0]], "leaf");
  return [
    // 叶子：路径里的桶以书自身为准
    ...leaf(`/title/${titleLetter}/${leafName}`),
    ...leaf(`/author/${authorLetter}/${leafName}`),
    ...leaf(`/format/${formatBucket}/${leafName}`),
    ...leaf(`/recent/${leafName}`),
    // 所属列表
    [`/title/${titleLetter}/`, 1],
    [`/author/${authorLetter}/`, 1],
    [`/format/${formatBucket}/`, 1],
    ["/recent/", 1],
    // 导航（新增某个首字母/格式时会出现新桶）
    ["/title/", 1],
    ["/author/", 1],
    ["/format/", 1]
  ];
}
__name(bookCacheTargets, "bookCacheTargets");

// src/api/admin.ts
var BATCH_SIZE = 50;
var MAX_LIST_LIMIT = 1e3;
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
__name(safeEqual, "safeEqual");
function authorised(request, url, cfg) {
  if (!cfg.adminToken) return false;
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const provided = bearer || (url.searchParams.get("token") ?? "");
  return provided.length > 0 && safeEqual(provided, cfg.adminToken);
}
__name(authorised, "authorised");
async function handleAdmin(request, env, cfg, url) {
  if (!cfg.adminToken) return textResponse(404, "Not Found");
  if (!authorised(request, url, cfg)) return textResponse(403, "Forbidden");
  if (request.method !== "POST" && request.method !== "GET") {
    return textResponse(405, "Method Not Allowed", { allow: "GET, POST" });
  }
  const action = url.pathname.slice("/api/admin/".length).replace(/\/+$/, "");
  switch (action) {
    case "reindex":
      return reindex(env, url);
    case "stats":
      return stats(env);
    case "purge":
      return purge(env, cfg, url);
    default:
      return textResponse(404, `Unknown admin action: ${action}`);
  }
}
__name(handleAdmin, "handleAdmin");
async function reindex(env, url) {
  const prefix = url.searchParams.get("prefix") ?? "library/";
  const cursor = url.searchParams.get("cursor") ?? void 0;
  const limit = Math.min(
    Math.max(Number.parseInt(url.searchParams.get("limit") ?? "500", 10) || 500, 1),
    MAX_LIST_LIMIT
  );
  const listing = await env.BUCKET.list({ prefix, cursor, limit });
  const statements = [];
  let skipped = 0;
  for (const object of listing.objects) {
    if (object.key.endsWith("/")) {
      skipped++;
      continue;
    }
    const leafName = sanitiseLeafName(leafNameFromKey(object.key));
    if (!leafName) {
      skipped++;
      continue;
    }
    const meta = deriveMetadata(leafName);
    const id = `r2-${(await sha256Hex(object.key)).slice(0, 20)}`;
    statements.push(
      upsertBookStatement(env.DB, {
        id,
        leafName,
        title: meta.title,
        author: meta.author,
        language: null,
        format: meta.format,
        contentType: preferContentType(object.httpMetadata?.contentType, meta.contentType),
        size: object.size,
        sha256: null,
        r2Key: object.key,
        etag: object.etag,
        titleLetter: letterBucket(meta.title),
        authorLetter: letterBucket(meta.author ?? meta.title),
        formatBucket: meta.format,
        publishedAt: object.uploaded?.toISOString() ?? (/* @__PURE__ */ new Date()).toISOString()
      })
    );
  }
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    await env.DB.batch(statements.slice(i, i + BATCH_SIZE));
  }
  const bucketsRebuilt = !listing.truncated;
  if (bucketsRebuilt) await rebuildBuckets(env.DB);
  return Response.json({
    prefix,
    indexed: statements.length,
    skipped,
    truncated: listing.truncated,
    nextCursor: listing.truncated ? listing.cursor : null,
    bucketsRebuilt
  });
}
__name(reindex, "reindex");
async function stats(env) {
  const collections = ["title", "author", "format", "recent"];
  const out = {};
  let total = 0;
  for (const collection of collections) {
    const rows = await listBucketTotals(env.DB, collection);
    out[collection] = rows;
    if (collection === "recent") total = rows.reduce((sum, r) => sum + r.total, 0);
  }
  const directoryCount = 1 + // root
  collections.length + // nav
  (out.title?.length ?? 0) + (out.author?.length ?? 0) + (out.format?.length ?? 0) + 1;
  return Response.json({ totalBooks: total, directoryCount, buckets: out });
}
__name(stats, "stats");
async function purge(env, cfg, url) {
  if (!davCache() || cfg.propfindTtl === 0) {
    return Response.json({ purged: 0, note: "cache disabled or unavailable" });
  }
  const rawPath = url.searchParams.get("path") ?? "/";
  const normalised = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const parent = normalised.replace(/[^/]+\/?$/, "") || "/";
  const purged = await purgeEntries([
    [normalised, 0],
    [normalised, 1],
    [parent, 0],
    [parent, 1]
  ]);
  return Response.json({
    purged,
    attempted: 4,
    note: "\u7F13\u5B58 TTL \u5230\u671F\u4E5F\u4F1A\u81EA\u52A8\u5931\u6548\uFF1B\u6279\u91CF\u91CD\u5EFA\u5EFA\u8BAE\u76F4\u63A5\u7B49 TTL"
  });
}
__name(purge, "purge");

// src/lib/sigv4.ts
var SERVICE = "s3";
var ALGORITHM = "AWS4-HMAC-SHA256";
function hmac(key, data) {
  const material = typeof key === "string" ? new TextEncoder().encode(key) : key;
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]).then(
    (cryptoKey) => crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data))
  );
}
__name(hmac, "hmac");
async function toHex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}
__name(toHex, "toHex");
function uriEncode(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}
__name(uriEncode, "uriEncode");
function encodeKeyPath(key) {
  return key.split("/").map((segment) => uriEncode(segment)).join("/");
}
__name(encodeKeyPath, "encodeKeyPath");
function splitAmzDate(amzDate) {
  return {
    dateStamp: amzDate.slice(0, 8),
    region: "auto",
    // R2 固定
    service: SERVICE
  };
}
__name(splitAmzDate, "splitAmzDate");
async function createPresignedPutUrl(input) {
  const { accessKeyId, secretAccessKey, accountId, bucket, key, contentType, amzDate } = input;
  const expiresIn = Math.min(Math.max(input.expiresIn ?? 900, 1), 604800);
  const { dateStamp } = splitAmzDate(amzDate);
  const credentialScope = `${dateStamp}/auto/${SERVICE}/aws4_request`;
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const encodedKey = encodeKeyPath(key);
  const signedHeaders = "host";
  const queryParams = {
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": `${accessKeyId}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": signedHeaders
  };
  if (contentType) queryParams["X-Amz-SignedHeaders"] = "content-type;host";
  const canonicalQuery = Object.keys(queryParams).sort().map((k) => `${uriEncode(k)}=${uriEncode(queryParams[k])}`).join("&");
  const canonicalHeaders = contentType ? `content-type:${contentType}
host:${host}
` : `host:${host}
`;
  const canonicalRequest = [
    "PUT",
    `/${bucket}/${encodedKey}`,
    // canonical URI 必须含 bucket（与最终 URL 路径一致）
    canonicalQuery,
    canonicalHeaders,
    contentType ? "content-type;host" : "host",
    "UNSIGNED-PAYLOAD"
  ].join("\n");
  const hashedCanonicalRequest = await toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalRequest)));
  const stringToSign = [ALGORITHM, amzDate, credentialScope, hashedCanonicalRequest].join("\n");
  const kDate = await hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = await hmac(new Uint8Array(kDate), "auto");
  const kService = await hmac(new Uint8Array(kRegion), SERVICE);
  const kSigning = await hmac(new Uint8Array(kService), "aws4_request");
  const signature = await toHex(await hmac(new Uint8Array(kSigning), stringToSign));
  const finalQuery = `${canonicalQuery}&X-Amz-Signature=${signature}`;
  return `https://${host}/${bucket}/${encodedKey}?${finalQuery}`;
}
__name(createPresignedPutUrl, "createPresignedPutUrl");

// src/lib/zip.ts
var ZipReadError = class extends Error {
  static {
    __name(this, "ZipReadError");
  }
  constructor(message) {
    super(message);
    this.name = "ZipReadError";
  }
};
var EOCD_SIG = 101010256;
var CENTRAL_SIG = 33639248;
var LOCAL_SIG = 67324752;
function eocdOffset(buf, byteLength) {
  const view = new DataView(buf);
  const minStart = Math.max(0, byteLength - 22 - 65535);
  for (let i = byteLength - 22; i >= minStart; i--) {
    if (i + 4 > byteLength) continue;
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  throw new ZipReadError("EOCD not found \u2014 not a valid ZIP");
}
__name(eocdOffset, "eocdOffset");
function readZipDirectory(buf) {
  const total = buf.byteLength;
  if (total < 22) throw new ZipReadError("file too small to be a ZIP");
  const eocd = eocdOffset(buf, total);
  const view = new DataView(buf);
  const entryCount = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdEnd = cdSize > 0 ? cdOffset + cdSize : eocd;
  const entries = /* @__PURE__ */ new Map();
  let p = cdOffset;
  for (let n = 0; n < entryCount; n++) {
    if (p + 46 > total || p + 46 > cdEnd + 1) {
      break;
    }
    if (view.getUint32(p, true) !== CENTRAL_SIG) break;
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const uncompressedSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localHeaderOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nameLen));
    if (name && !name.endsWith("/")) {
      entries.set(name, { name, method, compressedSize, uncompressedSize, localHeaderOffset });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
__name(readZipDirectory, "readZipDirectory");
async function inflate(raw) {
  const decompressed = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return await new Response(decompressed).arrayBuffer();
}
__name(inflate, "inflate");
async function readZipEntry(buf, entries, name) {
  const entry = entries.get(name);
  if (!entry) return null;
  const view = new DataView(buf);
  const lh = entry.localHeaderOffset;
  if (lh + 30 > buf.byteLength) return null;
  if (view.getUint32(lh, true) !== LOCAL_SIG) return null;
  const lhNameLen = view.getUint16(lh + 26, true);
  const lhExtraLen = view.getUint16(lh + 28, true);
  const dataStart = lh + 30 + lhNameLen + lhExtraLen;
  const data = new Uint8Array(buf, dataStart, entry.compressedSize);
  if (entry.method === 0) {
    return data.slice().buffer;
  }
  if (entry.method === 8) {
    return await inflate(data);
  }
  throw new ZipReadError(`unsupported compression method ${entry.method} for ${name}`);
}
__name(readZipEntry, "readZipEntry");

// src/lib/epub.ts
var PARSE_SIZE_CAP = 50 * 1024 * 1024;
var COVER_CAP = 2 * 1024 * 1024;
function findEntry(entries, candidates) {
  for (const c of candidates) {
    if (entries.has(c)) return c;
  }
  const target = candidates[0]?.toLowerCase();
  if (target) {
    for (const key of entries.keys()) {
      if (key.toLowerCase() === target) return key;
    }
  }
  return null;
}
__name(findEntry, "findEntry");
function xmlText(xml, tag) {
  const re = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  if (!m) return null;
  const text = stripTags(m[2]);
  return text || null;
}
__name(xmlText, "xmlText");
function stripTags(s) {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
__name(stripTags, "stripTags");
function resolveZipPath(opfDir, href) {
  let h = href.split("#")[0].trim();
  if (!h) return opfDir ? opfDir.replace(/\/+$/, "") : "";
  const base = opfDir.replace(/\/+$/, "");
  const parts = base ? base.split("/") : [];
  for (const seg of h.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.filter((s) => s !== "").join("/");
}
__name(resolveZipPath, "resolveZipPath");
async function parseEpub(buf) {
  let entries;
  try {
    entries = readZipDirectory(buf);
  } catch (e) {
    if (e instanceof ZipReadError) return null;
    throw e;
  }
  const containerName = findEntry(entries, ["META-INF/container.xml"]);
  if (!containerName) return null;
  const containerBuf = await readZipEntry(buf, entries, containerName);
  if (!containerBuf) return null;
  const containerXml = new TextDecoder().decode(new Uint8Array(containerBuf));
  const m = containerXml.match(/full-path\s*=\s*"([^"]+)"/i);
  const opfPath = m ? m[1].trim() : null;
  if (!opfPath) return null;
  const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const opfBuf = await readZipEntry(buf, entries, opfPath);
  if (!opfBuf) return null;
  const opf = new TextDecoder().decode(new Uint8Array(opfBuf));
  const title = xmlText(opf, "dc:title") ?? xmlText(opf, "title");
  const author = xmlText(opf, "dc:creator") ?? xmlText(opf, "creator");
  const language = xmlText(opf, "dc:language") ?? xmlText(opf, "language");
  let coverId = null;
  const metaCover = opf.match(
    /<meta[^>]*property\s*=\s*"ebooks:cover"[^>]*>([\w-]+)<\/meta>/i
  );
  if (metaCover) coverId = stripTags(metaCover[1] ?? "");
  const itemRe = /<item\b([^>]*)>/gi;
  let mItem;
  let itemAttrs = null;
  while ((mItem = itemRe.exec(opf)) !== null) {
    const attrs = mItem[1] ?? "";
    const id = attrs.match(/\bid\s*=\s*"([^"]+)"/i)?.[1] ?? null;
    if (id && id === coverId) {
      itemAttrs = attrs;
      break;
    }
    const props = attrs.match(/\bproperties\s*=\s*"([^"]+)"/i)?.[1] ?? "";
    if (/cover-image/.test(props)) {
      coverId = id;
      itemAttrs = attrs;
      break;
    }
  }
  let cover = null;
  if (coverId && itemAttrs) {
    const href = itemAttrs.match(/\bhref\s*=\s*"([^"]+)"/i)?.[1] ?? null;
    const mediaType = itemAttrs.match(/\bmedia-type\s*=\s*"([^"]+)"/i)?.[1] ?? "image/jpeg";
    if (href) {
      const coverPath = resolveZipPath(opfDir, href);
      const coverBuf = await readZipEntry(buf, entries, coverPath);
      if (coverBuf && coverBuf.byteLength <= COVER_CAP) {
        cover = { bytes: coverBuf, contentType: mediaType };
      }
    }
  }
  return {
    title: stripTags(title ?? "") || null,
    author: stripTags(author ?? "") || null,
    language: language?.trim() || null,
    cover
  };
}
__name(parseEpub, "parseEpub");

// src/api/upload.ts
var SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
var ALLOWED_EXT = /* @__PURE__ */ new Set([
  "epub",
  "pdf",
  "mobi",
  "azw",
  "azw3",
  "fb2",
  "djvu",
  "txt",
  "rtf",
  "cbz",
  "cbr",
  "m4a",
  "m4b",
  "mp3"
]);
var DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
async function verifyTurnstile(env, token, remoteIp) {
  const secret = env.TURNSTILE_SECRET;
  if (!secret) {
    return false;
  }
  const form = new FormData();
  form.set("secret", secret);
  form.set("response", token);
  if (remoteIp) form.set("remoteip", remoteIp);
  try {
    const res = await fetch(SITEVERIFY, { method: "POST", body: form });
    const json = await res.json();
    return json.success === true;
  } catch {
    return false;
  }
}
__name(verifyTurnstile, "verifyTurnstile");
function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For") ?? "";
}
__name(clientIp, "clientIp");
function todayKey() {
  return (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
}
__name(todayKey, "todayKey");
async function handleUploadInit(request, env) {
  if (request.method !== "POST") {
    return textResponse(405, "Method Not Allowed", { allow: "POST" });
  }
  const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID, R2_BUCKET_NAME, TURNSTILE_SECRET } = env;
  const missing = [];
  if (!R2_ACCESS_KEY_ID) missing.push("R2_ACCESS_KEY_ID");
  if (!R2_SECRET_ACCESS_KEY) missing.push("R2_SECRET_ACCESS_KEY");
  if (!R2_ACCOUNT_ID) missing.push("R2_ACCOUNT_ID");
  if (!R2_BUCKET_NAME) missing.push("R2_BUCKET_NAME");
  if (!TURNSTILE_SECRET) missing.push("TURNSTILE_SECRET");
  if (missing.length > 0) {
    return jsonResponse(
      { error: "upload-not-configured", missing },
      503
    );
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "bad-json" }, 400);
  }
  const { filename, size, turnstileToken } = body;
  if (typeof filename !== "string" || !filename.trim()) {
    return jsonResponse({ error: "filename-required" }, 400);
  }
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
    return jsonResponse({ error: "size-required" }, 400);
  }
  if (typeof turnstileToken !== "string" || !turnstileToken) {
    return jsonResponse({ error: "turnstile-token-required" }, 400);
  }
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (!ALLOWED_EXT.has(ext)) {
    return jsonResponse({ error: "unsupported-format", ext, allowed: [...ALLOWED_EXT] }, 415);
  }
  const maxBytes = Number.parseInt(env.UPLOAD_MAX_BYTES ?? "", 10) || DEFAULT_MAX_BYTES;
  if (size > maxBytes) {
    return jsonResponse({ error: "file-too-large", maxBytes }, 413);
  }
  const ip = clientIp(request);
  const ok = await verifyTurnstile(env, turnstileToken, ip);
  if (!ok) {
    return jsonResponse({ error: "turnstile-failed" }, 403);
  }
  const safeName = filename.replace(/[?#]/g, "_").replace(/[\/\\\u0000-\u001f]/g, "_").trim().slice(0, 180);
  if (!safeName || safeName === "." || safeName === "..") {
    return jsonResponse({ error: "invalid-filename" }, 400);
  }
  const key = `uploads/${todayKey()}/${shortId(6)}/${safeName}`;
  const contentType = preferContentType(body.contentType ?? null, deriveMetadata(safeName).contentType);
  const amzDate = (/* @__PURE__ */ new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const putUrl = await createPresignedPutUrl({
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    accountId: R2_ACCOUNT_ID,
    bucket: R2_BUCKET_NAME,
    key,
    contentType,
    expiresIn: 900,
    // 15 分钟
    amzDate
  });
  return jsonResponse({
    uploadUrl: putUrl,
    key,
    method: "PUT",
    headers: { "content-type": contentType },
    expiresIn: 900
  });
}
__name(handleUploadInit, "handleUploadInit");
async function handleUploadComplete(request, env) {
  if (request.method !== "POST") {
    return textResponse(405, "Method Not Allowed", { allow: "POST" });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "bad-json" }, 400);
  }
  const { key, filename, size } = body;
  if (typeof key !== "string" || !key.startsWith("uploads/")) {
    return jsonResponse({ error: "bad-key" }, 400);
  }
  const head = await env.BUCKET.head(key);
  if (!head) {
    return jsonResponse({ error: "object-not-found" }, 404);
  }
  const actualSize = head.size;
  const maxBytes = Number.parseInt(env.UPLOAD_MAX_BYTES ?? "", 10) || DEFAULT_MAX_BYTES;
  if (actualSize > maxBytes) {
    await env.BUCKET.delete(key);
    return jsonResponse({ error: "file-too-large", maxBytes }, 413);
  }
  const safeName = (filename || key.split("/").pop() || "book").replace(/[\/\\]/g, "_");
  const meta = deriveMetadata(safeName);
  const format = normaliseFormat(safeName.split(".").pop());
  const contentType = head.httpMetadata?.contentType ?? meta.contentType;
  const source = await env.BUCKET.get(key);
  if (!source) {
    return jsonResponse({ error: "object-unreadable" }, 404);
  }
  const bookKey = `books/${shortId(8)}`;
  const copied = await env.BUCKET.put(bookKey, source.body, {
    httpMetadata: { contentType: head.httpMetadata?.contentType ?? meta.contentType }
  });
  await env.BUCKET.delete(key);
  let title = meta.title;
  let author = meta.author;
  let language = null;
  let coverKey = null;
  if (format === "epub") {
    try {
      const fetched = await env.BUCKET.get(bookKey);
      const epubBuf = await fetched?.arrayBuffer();
      if (epubBuf && epubBuf.byteLength <= PARSE_SIZE_CAP) {
        const parsed = await parseEpub(epubBuf);
        if (parsed) {
          if (parsed.title) title = parsed.title;
          if (parsed.author) author = parsed.author;
          language = parsed.language;
          if (parsed.cover) {
            const coverType = parsed.cover.contentType || "image/jpeg";
            const ext = coverType.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
            coverKey = `covers/${bookKey.slice("books/".length)}.${ext}`;
            await env.BUCKET.put(coverKey, new Uint8Array(parsed.cover.bytes), {
              httpMetadata: { contentType: coverType }
            });
          }
        }
      }
    } catch {
    }
  }
  await upsertBook(env.DB, {
    id: bookKey.slice("books/".length),
    leafName: safeName,
    title,
    author,
    language,
    format,
    contentType,
    size: actualSize,
    sha256: null,
    r2Key: bookKey,
    etag: head.etag,
    titleLetter: letterBucket(title),
    authorLetter: letterBucket(author ?? title),
    formatBucket: format,
    publishedAt: (/* @__PURE__ */ new Date()).toISOString(),
    coverKey
  });
  await rebuildBuckets(env.DB);
  return jsonResponse({
    ok: true,
    title,
    author,
    language,
    format,
    size: actualSize,
    leafName: safeName,
    // 封面绝对 URL：上传页立刻可预览
    coverUrl: coverKey ? `${env.R2_PUBLIC_BASE}/${coverKey}` : null,
    parsed: format === "epub" && actualSize <= PARSE_SIZE_CAP
  });
}
__name(handleUploadComplete, "handleUploadComplete");

// src/config.ts
var HARD_MAX_ENTRIES = 200;
var PAGINATION_MAX = 100;
function intFrom(value, fallback, min, max) {
  const n = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}
__name(intFrom, "intFrom");
function settings(env) {
  const base = (env.R2_PUBLIC_BASE ?? "").trim().replace(/\/+$/, "");
  if (!base) {
    throw new Error("R2_PUBLIC_BASE is not configured; GET would have nowhere to redirect");
  }
  const rawMount = (env.DAV_MOUNT ?? "/dav").trim();
  const mountPath = rawMount === "" || rawMount === "/" ? "" : `/${rawMount.replace(/^\/+|\/+$/g, "")}`;
  return {
    r2PublicBase: base,
    adminToken: env.ADMIN_TOKEN?.trim() || null,
    mountPath,
    maxEntries: intFrom(env.MAX_ENTRIES, 200, 1, HARD_MAX_ENTRIES),
    propfindTtl: intFrom(env.PROPFIND_TTL, 300, 0, 86400),
    depthInfinity: env.DEPTH_INFINITY === "deny" ? "deny" : "downgrade"
  };
}
__name(settings, "settings");

// src/upload-page.ts
function uploadHtml(turnstileSiteKey) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>\u4E0A\u4F20\u4E66\u7C4D \xB7 webooks</title>
<style>
  :root{--bd:#e4e4e7;--mut:#71717a;--ac:#0b62d0;--ok:#177245;--er:#c62828}
  *{box-sizing:border-box}
  body{font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:44rem;margin:2.5rem auto;padding:0 1rem;color:#18181b}
  h1{font-size:1.25rem;margin-bottom:.2rem}
  .sub{color:var(--mut);margin-bottom:1.5rem;font-size:.92rem}
  #drop{border:2px dashed var(--bd);border-radius:12px;padding:2.2rem 1rem;text-align:center;cursor:pointer;transition:.15s;background:#fafafa}
  #drop.drag{border-color:var(--ac);background:#f0f6ff}
  #drop.over{border-color:var(--ac);background:#e8f1ff}
  .hint{color:var(--mut);font-size:.9rem;margin-top:.6rem}
  input[type=file]{display:none}
  .card{margin-top:1.2rem;border:1px solid var(--bd);border-radius:12px;padding:1rem;display:none}
  .card.show{display:block}
  .row{display:flex;gap:1rem;align-items:flex-start}
  .cover{width:88px;height:120px;flex:0 0 auto;border:1px solid var(--bd);border-radius:6px;object-fit:cover;background:#f4f4f5;display:flex;align-items:center;justify-content:center;color:var(--mut);font-size:.75rem;text-align:center;overflow:hidden}
  .cover img{width:100%;height:100%;object-fit:cover;display:block}
  .cover-empty{padding:6px;word-break:break-word}
  .meta{flex:1;min-width:0}
  .fname{font-weight:600;word-break:break-all}
  .kv{color:var(--mut);font-size:.9rem;margin-top:.35rem}
  .kv b{color:#3f3f46;font-weight:600}
  .kv.parsed{margin-top:.6rem;padding-top:.5rem;border-top:1px dashed var(--bd)}
  .badge{display:inline-block;font-size:.7rem;font-weight:600;padding:.1rem .45rem;border-radius:999px;background:#e8f1ff;color:var(--ac);margin-bottom:.25rem}
  .bar{height:8px;background:#ececee;border-radius:999px;overflow:hidden;margin-top:.9rem}
  .bar>i{display:block;height:100%;width:0;background:var(--ac);transition:width .15s}
  .msg{margin-top:.9rem;font-size:.92rem;display:none}
  .msg.show{display:block}
  .msg.err{color:var(--er)}
  .msg.ok{color:var(--ok)}
  button{font:inherit;padding:.55rem 1.1rem;border-radius:8px;border:1px solid var(--ac);background:var(--ac);color:#fff;cursor:pointer}
  button.ghost{background:#fff;color:var(--ac)}
  button:disabled{opacity:.5;cursor:not-allowed}
  .steps{margin:1rem 0;padding:0;list-style:none;font-size:.9rem;color:var(--mut)}
  .steps li{padding:.15rem 0}
  .steps li.on{color:var(--ac);font-weight:600}
  .steps li.ok{color:var(--ok)}
  #ts{margin-top:1rem}
  a{color:var(--ac)}
</style></head>
<body>
<h1>\u4E0A\u4F20\u4E66\u7C4D</h1>
<p class="sub">\u652F\u6301 EPUB / PDF / MOBI / AZW3 / CBZ / \u6709\u58F0\u4E66\u7B49\u3002\u5927\u6587\u4EF6\u76F4\u4F20 Cloudflare R2\uFF0C\u4E0D\u7ECF\u670D\u52A1\u5668\u3002</p>

<div id="drop">
  <div>\u628A\u6587\u4EF6\u62D6\u5230\u8FD9\u91CC\uFF0C\u6216 <a href="#" id="pick">\u70B9\u51FB\u9009\u62E9</a></div>
  <div class="hint">\u5355\u6587\u4EF6\u4E0A\u9650\u7531\u670D\u52A1\u5668\u51B3\u5B9A\uFF1B\u4E0A\u4F20\u540E\u7ACB\u5373\u53EF\u5728 WebDAV /opds \u4E2D\u68C0\u7D22</div>
  <input type="file" id="file">
</div>

<div class="card" id="card">
  <div class="row">
    <div class="cover" id="cover"><div class="cover-empty">\u65E0\u5C01\u9762</div></div>
    <div class="meta">
      <div class="fname" id="fname"></div>
      <div class="kv">\u7C7B\u578B\uFF1A<b id="ftype"></b></div>
      <div class="kv">\u5927\u5C0F\uFF1A<b id="fsize"></b></div>
      <div class="kv" id="derived" hidden>\u4E66\u540D\uFF1A<b id="ftitle"></b> \xB7 \u4F5C\u8005\uFF1A<b id="fauthor"></b></div>
      <div class="kv parsed" id="parsed" hidden>
        <span class="badge" id="parsedBadge">\u5DF2\u89E3\u6790 EPUB</span>
        \u771F\u5B9E\u4E66\u540D\uFF1A<b id="ptitle"></b><br>\u771F\u5B9E\u4F5C\u8005\uFF1A<b id="pauthor"></b>
      </div>
    </div>
  </div>
  <div class="bar" id="bar"><i id="pct"></i></div>
  <div class="msg" id="msg"></div>
  <ol class="steps" id="steps">
    <li id="s1">1. \u83B7\u53D6\u4E0A\u4F20\u5730\u5740</li>
    <li id="s2">2. \u4E0A\u4F20\u5230 R2</li>
    <li id="s3">3. \u5199\u5165\u4E66\u5E93</li>
  </ol>
  <button id="go">\u5F00\u59CB\u4E0A\u4F20</button>
  <button class="ghost" id="reset" style="margin-left:.5rem">\u6362\u4E00\u4E2A</button>
</div>

<div id="ts"></div>

<script>
const $ = (id) => document.getElementById(id);
let picked = null, turnstileToken = null, siteKey = ${JSON.stringify(turnstileSiteKey)};

const drop = $('drop'), file = $('file');
drop.onclick = () => file.click();
$('pick').onclick = (e) => { e.stopPropagation(); file.click(); };
file.onchange = () => file.files[0] && preview(file.files[0]);

['dragenter','dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag','over'); }));
['dragleave','drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('drag','over'); }));
drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) preview(f); });

$('reset').onclick = () => { picked = null; file.value=''; $('card').classList.remove('show'); $('msg').className='msg'; turnstileToken=null; };

function fmtSize(b){ if(b<1024) return b+' B'; if(b<1048576) return (b/1024).toFixed(1)+' KB'; if(b<1073741824) return (b/1048576).toFixed(1)+' MB'; return (b/1073741824).toFixed(2)+' GB'; }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// \u4E0E\u540E\u7AEF deriveMetadata \u540C\u89C4\u5219\u7684\u8F7B\u91CF\u7248\uFF0C\u7528\u4E8E\u4E0A\u4F20\u524D\u9884\u89C8
function derive(name){
  const i = name.lastIndexOf('.'), ext = (i>0?name.slice(i+1):'').toLowerCase();
  let stem = (i>0?name.slice(0,i):name).replace(/_+/g,' ').trim();
  let author = null;
  for(const sep of [' - ',' \u2013 ',' \u2014 ',' by ']){ const k=stem.indexOf(sep); if(k>0&&k<stem.length-sep.length){ author=stem.slice(0,k).trim(); stem=stem.slice(k+sep.length).trim(); break; } }
  return { ext, title: stem||name, author };
}

function preview(f){
  picked = f;
  $('card').classList.add('show');
  // \u6E05\u6389\u4E0A\u4E00\u6B21\u4E0A\u4F20\u7559\u4E0B\u7684\u300C\u5DF2\u89E3\u6790\u300D\u533A
  $('parsed').hidden = true;
  $('fname').textContent = f.name;
  $('fsize').textContent = fmtSize(f.size);
  const d = derive(f.name);
  $('ftype').textContent = d.ext.toUpperCase()||'?';
  $('derived').hidden = false;
  $('ftitle').textContent = d.title;
  $('fauthor').textContent = d.author || '\uFF08\u672A\u8BC6\u522B\uFF09';
  // \u56FE\u7247\u7C7B\u7ED9\u771F\u5B9E\u9884\u89C8\uFF0C\u5176\u4F59\u7ED9\u5360\u4F4D
  const cov = $('cover');
  if(/^image//.test(f.type)){ const url=URL.createObjectURL(f); cov.innerHTML='<img src="'+url+'" style="width:100%;height:100%;object-fit:cover">'; }
  else { cov.innerHTML='<div class="cover-empty">'+ (d.ext.toUpperCase() || '\u65E0\u5C01\u9762') +'</div>'; }
  $('go').disabled = false;
  setStep(1);
}

// Turnstile
function loadTurnstile(){
  return new Promise((resolve, reject) => {
    if(!siteKey){ reject(new Error('\u670D\u52A1\u5668\u672A\u914D\u7F6E Turnstile\uFF08\u7F3A\u5C11 TURNSTILE_SITE_KEY\uFF09\uFF0C\u4E0A\u4F20\u4E0D\u53EF\u7528')); return; }
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Turnstile \u811A\u672C\u52A0\u8F7D\u5931\u8D25\uFF08\u53EF\u80FD\u88AB\u7F51\u7EDC\u62E6\u622A\uFF09'));
    document.head.appendChild(s);
  });
}
async function renderWidget(){
  await loadTurnstile();
  turnstileToken = null;
  window.turnstile.render('#ts', {
    sitekey: siteKey,
    callback: (token) => { turnstileToken = token; $('go').disabled=false; },
    'expired-callback': () => { turnstileToken = null; },
  });
}

function setStep(n){ for(let i=1;i<=3;i++){ const el=$('s'+i); el.classList.toggle('on', i===n); } }
function markStep(n){ const el=$('s'+n); el.classList.remove('on'); el.classList.add('ok'); }
function msg(text, cls){ const m=$('msg'); m.textContent=text; m.className='msg show '+(cls||''); }

$('go').onclick = async () => {
  if(!picked) return;
  if(!turnstileToken){ msg('\u8BF7\u5148\u5B8C\u6210\u4EBA\u673A\u9A8C\u8BC1', 'err'); return; }
  $('go').disabled = true;
  try{
    setStep(1); msg('\u6B63\u5728\u83B7\u53D6\u4E0A\u4F20\u5730\u5740\u2026');
    const init = await fetch('/api/upload/init', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ filename: picked.name, size: picked.size, contentType: picked.type, turnstileToken }),
    }).then(async r => ({ ok:r.ok, status:r.status, json: await r.json().catch(()=>({})) }));
    if(!init.ok){
      const code = init.json.error || ('HTTP '+init.status);
      const tip = { 'turnstile-failed':'\u4EBA\u673A\u9A8C\u8BC1\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5', 'file-too-large':'\u6587\u4EF6\u8D85\u8FC7\u670D\u52A1\u5668\u9650\u5236', 'unsupported-format':'\u4E0D\u652F\u6301\u7684\u6587\u4EF6\u7C7B\u578B', 'upload-not-configured':'\u670D\u52A1\u5668\u5C1A\u672A\u914D\u7F6E\u4E0A\u4F20\u529F\u80FD\uFF1A\u7F3A\u5C11 '+(init.json.missing||[]).join(', ') }[code] || code;
      throw new Error(tip);
    }
    markStep(1);

    setStep(2); msg('\u6B63\u5728\u4E0A\u4F20\u5230 R2\u2026');
    await putToR2WithRetry(init.json.uploadUrl, picked, init.json.headers['content-type']);

    setStep(3); msg('\u6B63\u5728\u5199\u5165\u4E66\u5E93\u2026');
    const done = await fetch('/api/upload/complete', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ key: init.json.key, filename: picked.name, size: picked.size, contentType: picked.type }),
    }).then(async r => ({ ok:r.ok, status:r.status, json: await r.json().catch(()=>({})) }));
    if(!done.ok) throw new Error(done.json.error || ('HTTP '+done.status));
    markStep(3);

    // \u5C55\u793A\u670D\u52A1\u5668\u89E3\u6790\u51FA\u7684\u771F\u5B9E\u5C01\u9762\u4E0E\u5143\u6570\u636E\uFF08EPUB \u4E14 < 50MB \u65F6 available\uFF09
    const j = done.json;
    if (j.coverUrl) {
      $('cover').innerHTML = '<img src="'+j.coverUrl+'" style="width:100%;height:100%;object-fit:cover" alt="cover">';
      $('parsed').hidden = false;
      $('ptitle').textContent = j.title || '\u2014';
      $('pauthor').textContent = j.author || '\uFF08\u672A\u8BC6\u522B\uFF09';
      $('parsedBadge').textContent = '\u5DF2\u89E3\u6790 EPUB \u5C01\u9762';
    }
    msg('\u2705 \u4E0A\u4F20\u6210\u529F\uFF1A\u300A'+(j.title||j.leafName)+'\u300B\u5DF2\u4E0A\u67B6', 'ok');
    $('pct').style.width='100%';
  }catch(e){
    const detail = e.message||String(e);
    // \u8FDE\u63A5\u7C7B\u9519\u8BEF\u5728\u516C\u7F51\u4E0A\u4F20\u5F88\u5E38\u89C1\uFF0C\u660E\u786E\u544A\u8BC9\u7528\u6237\u53EF\u4EE5\u91CD\u8BD5\uFF0C\u800C\u4E0D\u662F\u8BA9\u4ED6\u4EE5\u4E3A\u574F\u4E86
    const retryable = /\u4E2D\u65AD|\u8D85\u65F6|ERR_|\u7F51\u7EDC/.test(detail);
    msg('\u274C ' + detail + (retryable ? '\uFF08\u5927\u6587\u4EF6\u5728\u5F31\u7F51\u4E0B\u4E2D\u65AD\u5C5E\u5E38\u89C1\u60C5\u51B5\uFF0C\u518D\u70B9\u4E00\u6B21\u300C\u5F00\u59CB\u4E0A\u4F20\u300D\u5373\u53EF\uFF09' : ''), 'err');
    $('go').disabled=false;
  }
};

// \u7528 XHR \u4EE5\u83B7\u5F97\u4E0A\u4F20\u8FDB\u5EA6
function putToR2(url, blob, contentType, onProgress){
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    if(contentType) xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (e) => { if(e.lengthComputable && onProgress) onProgress(e.loaded/e.total); };
    xhr.onload = () => { if(xhr.status>=200&&xhr.status<300) resolve(); else reject(new Error('R2 \u76F4\u4F20\u5931\u8D25 HTTP '+xhr.status)); };
    xhr.onerror = () => reject(new Error('\u7F51\u7EDC\u4E2D\u65AD'));
    xhr.ontimeout = () => reject(new Error('\u4E0A\u4F20\u8D85\u65F6'));
    xhr.send(blob);
  });
}

/**
 * \u5E26\u91CD\u8BD5\u7684\u4E0A\u4F20\u3002
 *
 * \u4E3A\u4EC0\u4E48\u8981\u91CD\u8BD5\uFF1A\u5B9E\u6D4B R2 \u9884\u7B7E\u540D\u76F4\u4F20**\u6CA1\u6709 100MB \u4E0A\u9650**\uFF08200MB \u4E00\u6B21\u6210\u529F\uFF09\uFF0C
 * \u4F46\u4F20\u8F93\u9014\u4E2D\u51FA\u73B0 ERR_CONNECTION_RESET \u8FD9\u7C7B\u77AC\u65F6\u4E2D\u65AD\u662F\u516C\u7F51\u4E0A\u4F20\u5BB6\u5E38\u4FBF\u996D \u2014\u2014
 * \u5B9E\u6D4B 120MB \u6863\u5C31\u5076\u53D1\u65AD\u5728 41 \u79D2\u5904\uFF0C\u800C\u66F4\u5927\u7684 200MB \u5374\u4E00\u6B21\u8FC7\u3002
 * \u8BF4\u660E\u8FD9\u662F\u77AC\u65F6\u6545\u969C\u800C\u975E\u4F53\u79EF\u9608\u503C\uFF0C\u6240\u4EE5\u6B63\u786E\u5904\u7F6E\u662F\u300C\u5931\u8D25\u81EA\u52A8\u91CD\u8BD5\u300D\uFF0C
 * \u800C\u4E0D\u662F\u8BBE\u4E00\u4E2A\u4F53\u79EF\u4E0A\u9650\u53BB\u62D2\u7EDD\u5927\u6587\u4EF6\u3002
 *
 * \u9884\u7B7E\u540D URL 15 \u5206\u949F\u5185\u53EF\u91CD\u590D\u4F7F\u7528\uFF0C\u91CD\u8BD5\u4E0D\u9700\u8981\u91CD\u65B0\u7B7E\u53D1\u3002
 */
async function putToR2WithRetry(url, blob, contentType, maxAttempts){
  maxAttempts = maxAttempts || 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++){
    try {
      await putToR2(url, blob, contentType, (ratio) => {
        // \u91CD\u8BD5\u65F6\u628A\u8FDB\u5EA6\u6761\u56DE\u9000\uFF0C\u907F\u514D\u663E\u793A\u6210 100% \u5374\u5931\u8D25
        $('pct').style.width = (ratio * 100) + '%';
      });
      return;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      const waitSec = Math.pow(2, attempt - 1); // 2s, 4s, 8s
      msg('\u7B2C ' + attempt + '/' + maxAttempts + ' \u6B21\u4E0A\u4F20\u4E2D\u65AD\uFF08' + (err.message||err) + '\uFF09\uFF0C' + waitSec + ' \u79D2\u540E\u81EA\u52A8\u91CD\u8BD5\u2026', '');
      await new Promise(r => setTimeout(r, waitSec * 1000));
      $('pct').style.width = '0%';
    }
  }
}

// \u521D\u59CB\u5316
renderWidget().catch(e => { msg('\u274C '+e.message, 'err'); $('go').disabled=true; });
<\/script>
</body></html>`;
}
__name(uploadHtml, "uploadHtml");

// src/lib/preconditions.ts
function parseTagList(header) {
  const raw = header.trim();
  if (raw === "*") return { star: true, tags: [] };
  const tags = raw.split(",").map((t) => t.trim()).filter((t) => t.length > 0).map((t) => t.startsWith("W/") ? t.slice(2) : t);
  return { star: false, tags };
}
__name(parseTagList, "parseTagList");
function checkPreconditions(headers, currentEtag) {
  const ifMatch = headers.get("if-match");
  const ifNoneMatch = headers.get("if-none-match");
  if (ifMatch !== null) {
    const { star, tags } = parseTagList(ifMatch);
    if (currentEtag === null) {
      return { ok: false, reason: "If-Match \u6307\u5B9A\u4E86\u6761\u4EF6\uFF0C\u4F46\u76EE\u6807\u4E0D\u5B58\u5728" };
    }
    const matches = star || tags.includes(currentEtag);
    if (!matches) {
      return { ok: false, reason: `If-Match \u4E0D\u5339\u914D\uFF08\u5F53\u524D ETag=${currentEtag}\uFF09` };
    }
  }
  if (ifNoneMatch !== null) {
    const { star, tags } = parseTagList(ifNoneMatch);
    if (star) {
      if (currentEtag !== null) {
        return { ok: false, reason: "If-None-Match: * \u8981\u6C42\u76EE\u6807\u4E0D\u5B58\u5728\uFF0C\u4F46\u76EE\u6807\u5DF2\u5B58\u5728" };
      }
    } else if (currentEtag !== null && tags.includes(currentEtag)) {
      return { ok: false, reason: `If-None-Match \u547D\u4E2D\uFF08\u5F53\u524D ETag=${currentEtag}\uFF09` };
    }
  }
  return { ok: true };
}
__name(checkPreconditions, "checkPreconditions");

// src/lib/locks.ts
var INFINITE_LOCK_SECONDS = 3600;
var DEFAULT_LOCK_SECONDS = 300;
var MAX_LOCK_SECONDS = INFINITE_LOCK_SECONDS;
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
__name(nowIso, "nowIso");
function isoPlusSeconds(baseIso, seconds) {
  return new Date(Date.parse(baseIso) + seconds * 1e3).toISOString();
}
__name(isoPlusSeconds, "isoPlusSeconds");
function parseTimeoutHeader(value) {
  if (!value || value === "Infinite" || value === "infinity") return INFINITE_LOCK_SECONDS;
  const m = value.match(/Second-N=(\d+)/i);
  if (!m) return DEFAULT_LOCK_SECONDS;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_LOCK_SECONDS;
  return Math.min(n, MAX_LOCK_SECONDS);
}
__name(parseTimeoutHeader, "parseTimeoutHeader");
function newLockToken() {
  const b = crypto.randomUUID();
  return `<urn:uuid:${b}>`;
}
__name(newLockToken, "newLockToken");
async function acquireLock(db, opts) {
  const now = nowIso();
  const expires = isoPlusSeconds(now, opts.timeoutSec);
  if (opts.refreshToken) {
    const existing = await db.prepare(`SELECT token FROM locks WHERE token = ? AND resource = ?`).bind(opts.refreshToken, opts.resource).first();
    if (existing) {
      await db.prepare(
        `UPDATE locks SET expires_at = ?, timeout_sec = ? WHERE token = ?`
      ).bind(expires, opts.timeoutSec, opts.refreshToken).run();
      return {
        lock: {
          token: opts.refreshToken,
          resource: opts.resource,
          owner: opts.owner ?? null,
          type: opts.type,
          depth: opts.depth,
          timeoutSec: opts.timeoutSec,
          createdAt: now,
          expiresAt: expires
        },
        isRefresh: true
      };
    }
  }
  const blocking = await liveLockForResource(db, opts.resource);
  if (blocking) {
    const err = new Error("LOCK_CONFLICT");
    err.lockConflict = true;
    err.liveToken = blocking.token;
    throw err;
  }
  const token = newLockToken();
  await db.prepare(
    `INSERT INTO locks (token, resource, owner, type, depth, timeout_sec, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(token) DO UPDATE SET
         resource = excluded.resource,
         owner = excluded.owner,
         type = excluded.type,
         depth = excluded.depth,
         timeout_sec = excluded.timeout_sec,
         expires_at = excluded.expires_at`
  ).bind(
    token,
    opts.resource,
    opts.owner ?? null,
    opts.type,
    opts.depth,
    opts.timeoutSec,
    now,
    expires
  ).run();
  return {
    lock: {
      token,
      resource: opts.resource,
      owner: opts.owner ?? null,
      type: opts.type,
      depth: opts.depth,
      timeoutSec: opts.timeoutSec,
      createdAt: now,
      expiresAt: expires
    },
    isRefresh: Boolean(opts.refreshToken)
  };
}
__name(acquireLock, "acquireLock");
async function releaseLock(db, token) {
  await db.prepare(`DELETE FROM locks WHERE token = ?`).bind(token).run();
}
__name(releaseLock, "releaseLock");
async function allLiveLocks(db) {
  const out = /* @__PURE__ */ new Map();
  const { results } = await db.prepare(`SELECT * FROM locks WHERE expires_at > ?`).bind(nowIso()).all();
  for (const row of results ?? []) {
    out.set(row.resource, {
      token: row.token,
      resource: row.resource,
      owner: row.owner ?? null,
      type: row.type,
      depth: row.depth,
      timeoutSec: row.timeout_sec,
      createdAt: row.created_at,
      expiresAt: row.expires_at
    });
  }
  return out;
}
__name(allLiveLocks, "allLiveLocks");
function matchLocksToPaths(locks, paths) {
  const out = /* @__PURE__ */ new Map();
  if (locks.size === 0) return out;
  for (const p of paths) {
    let hit;
    for (const lock of locks.values()) {
      const r = lock.resource;
      if (r === p || p.startsWith(r.endsWith("/") ? r : r + "/")) {
        if (!hit || lock.expiresAt > hit.expiresAt) hit = lock;
      }
    }
    if (hit) out.set(p, hit);
  }
  return out;
}
__name(matchLocksToPaths, "matchLocksToPaths");
async function liveLockForResource(db, resource) {
  const now = nowIso();
  const row = await db.prepare(
    // 资源 r 被锁的判定：
    //   (1) r 自身有锁          resource = ?
    //   (2) r 的任意祖先目录有 Depth:1/infinity 锁
    //       祖先目录锁的 resource 形如 '/recent/'（带尾斜杠）或 '/'
    //       子资源 '/recent/child.epub' 应以该目录串为前缀
    `SELECT * FROM locks
        WHERE (
             resource = ?
             OR (? LIKE resource || '%' AND resource LIKE '%/')
             OR resource = '/'
        )
        AND expires_at > ?
        ORDER BY (CASE WHEN resource = ? THEN 0 ELSE 1 END) ASC, expires_at DESC
        LIMIT 1`
  ).bind(resource, resource, now, resource).first();
  if (!row) return null;
  return {
    token: row.token,
    resource: row.resource,
    owner: row.owner ?? null,
    type: row.type,
    depth: row.depth,
    timeoutSec: row.timeout_sec,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
}
__name(liveLockForResource, "liveLockForResource");
function lockDiscoveryXml(lock, requestHref) {
  const ownerXml = lock.owner ? `<D:owner>${escapeOwner(lock.owner)}</D:owner>` : "";
  const scope = lock.type === "shared" ? "shared" : "exclusive";
  const lockType = lock.type === "shared" ? "read" : "write";
  const depth = lock.depth === "1" || lock.depth === "0" ? lock.depth : "infinity";
  return `<D:lockdiscovery><D:lock><D:lockscope><D:${scope}/></D:lockscope><D:locktype><D:${lockType}/></D:locktype><D:depth>${depth}</D:depth><D:timeout>Second-${lock.timeoutSec}</D:timeout><D:locktoken><D:locktoken><D:href>${escapeOwner(lock.token)}</D:href></D:locktoken>` + ownerXml + `</D:lock></D:lockdiscovery>`;
}
__name(lockDiscoveryXml, "lockDiscoveryXml");
function escapeOwner(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
__name(escapeOwner, "escapeOwner");

// src/lib/xml.ts
var ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;"
};
function escapeXml(value) {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}
__name(escapeXml, "escapeXml");
function encodeHref(path, isCollection = false) {
  const wantsSlash = isCollection || path.endsWith("/");
  const segments = path.split("/").filter((s) => s.length > 0);
  const encoded = segments.map((s) => encodeURIComponent(s)).join("/");
  const withLeading = `/${encoded}`;
  if (!wantsSlash) return withLeading;
  return withLeading === "/" ? "/" : `${withLeading}/`;
}
__name(encodeHref, "encodeHref");
function davResponse(href, found, notFound = []) {
  const parts = [];
  if (found) {
    parts.push(`<D:propstat><D:prop>${found}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>`);
  }
  if (notFound.length > 0) {
    const names = notFound.map((n) => `<D:${n}/>`).join("");
    parts.push(
      `<D:propstat><D:prop>${names}</D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>`
    );
  }
  return `<D:response><D:href>${escapeXml(href)}</D:href>${parts.join("")}</D:response>`;
}
__name(davResponse, "davResponse");
function multistatus(responses) {
  return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">${responses.join("")}</D:multistatus>`;
}
__name(multistatus, "multistatus");
function davError(precondition) {
  return `<?xml version="1.0" encoding="utf-8"?>
<D:error xmlns:D="DAV:"><D:${precondition}/></D:error>`;
}
__name(davError, "davError");

// src/webdav/propfind.ts
var TAG_RE = /<(?:[A-Za-z0-9_.-]+:)?([A-Za-z0-9_.-]+)\b[^>]*?(\/?)>/g;
function parsePropfindBody(body) {
  const text = (body ?? "").trim();
  if (text.length === 0) return { mode: "allprop", names: [] };
  if (/<(?:[A-Za-z0-9_.-]+:)?propname\b/i.test(text)) return { mode: "propname", names: [] };
  if (/<(?:[A-Za-z0-9_.-]+:)?allprop\b/i.test(text)) return { mode: "allprop", names: [] };
  const block = text.match(
    /<(?:[A-Za-z0-9_.-]+:)?prop\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?prop>/i
  );
  if (!block) return { mode: "allprop", names: [] };
  const names = [];
  for (const tag of block[1].matchAll(TAG_RE)) {
    const name = tag[1];
    if (name === "prop") continue;
    names.push(name);
  }
  if (names.length === 0) return { mode: "allprop", names: [] };
  return { mode: "prop", names: [...new Set(names)].sort() };
}
__name(parsePropfindBody, "parsePropfindBody");
function resolveDepth(header, cfg) {
  const raw = (header ?? "").trim().toLowerCase();
  if (raw === "0") return { depth: 0 };
  if (raw === "1") return { depth: 1 };
  if (raw === "infinity") {
    return cfg.depthInfinity === "deny" ? { rejected: true } : { depth: 1 };
  }
  return { depth: 1 };
}
__name(resolveDepth, "resolveDepth");
var RFC_PROPS = [
  "resourcetype",
  "getcontentlength",
  "getcontenttype",
  "getlastmodified",
  "getetag",
  "displayname",
  "creationdate",
  "supportedlock",
  "lockdiscovery",
  "getcontentlanguage"
];
var MS_PROPS = [
  "isdirectory",
  "isreadonly",
  "issymlink",
  "iswriteable",
  "issparsesupported",
  "maxuploadpacketsize",
  "linkishint",
  "qproptype",
  "ms-fsstoragetype",
  "ms-author-via"
];
var FILE_PROPS = [...RFC_PROPS, ...MS_PROPS];
var DIR_PROPS = [...RFC_PROPS, ...MS_PROPS];
var MAX_UPLOAD_PACKET_SIZE = 1024 * 1024;
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  return Math.abs(h);
}
__name(hash, "hash");
function propNamesOnly(isCollection) {
  const all = isCollection ? DIR_PROPS : FILE_PROPS;
  return all.filter((n) => n !== "linkishint" && n !== "qproptype").map((n) => `<D:${n}/>`).join("");
}
__name(propNamesOnly, "propNamesOnly");
function renderProps(isCollection, req, meta) {
  if (req.mode === "propname") return { found: propNamesOnly(isCollection), notFound: [] };
  const available = new Set(isCollection ? DIR_PROPS : FILE_PROPS);
  const wanted = req.mode === "prop" ? req.names : [...available];
  const found = [];
  const notFound = [];
  for (const name of wanted) {
    if (!available.has(name)) {
      notFound.push(name);
      continue;
    }
    switch (name) {
      case "resourcetype":
        found.push(
          isCollection ? "<D:resourcetype><D:collection/></D:resourcetype>" : "<D:resourcetype/>"
        );
        break;
      case "getcontentlength":
        found.push(`<D:getcontentlength>${meta.contentLength ?? 0}</D:getcontentlength>`);
        break;
      case "getcontenttype":
        found.push(
          `<D:getcontenttype>${escapeXml(meta.contentType ?? "application/octet-stream")}</D:getcontenttype>`
        );
        break;
      case "getlastmodified":
        found.push(`<D:getlastmodified>${httpDate(meta.lastModified)}</D:getlastmodified>`);
        break;
      case "getetag":
        found.push(`<D:getetag>${escapeXml(meta.etag ?? `"auto-${hash(meta.displayName + String(meta.lastModified ?? ""))}"`)}</D:getetag>`);
        break;
      case "displayname":
        found.push(`<D:displayname>${escapeXml(meta.displayName)}</D:displayname>`);
        break;
      case "creationdate":
        found.push(`<D:creationdate>${isoDate(meta.created ?? meta.lastModified)}</D:creationdate>`);
        break;
      case "getcontentlanguage":
        found.push(
          meta.language ? `<D:getcontentlanguage>${escapeXml(meta.language)}</D:getcontentlanguage>` : "<D:getcontentlanguage/>"
        );
        break;
      // 现在实现了完整 Class 2 锁：supportedlock 宣告 exclusive/write，
      // 让客户端知道我们对锁是真的支持的（而不是「不支持请忽略」）。
      case "supportedlock":
        found.push(
          "<D:supportedlock><D:supportedlockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:supportedlockentry><D:supportedlockentry><D:lockscope><D:shared/></D:lockscope><D:locktype><D:read/></D:locktype></D:supportedlockentry></D:supportedlock>"
        );
        break;
      case "lockdiscovery":
        found.push(
          meta.lockDiscoveryXml ? meta.lockDiscoveryXml : "<D:lockdiscovery/>"
        );
        break;
      // ── MS-WebDAV 扩展（Windows 系客户端挂载时强制要求）──
      case "isdirectory":
        found.push(`<D:isdirectory>${isCollection ? 1 : 0}</D:isdirectory>`);
        break;
      case "isreadonly":
        found.push(`<D:isreadonly>0</D:isreadonly>`);
        break;
      case "issymlink":
        found.push("<D:issymlink>0</D:issymlink>");
        break;
      case "iswriteable":
        found.push("<D:iswriteable>1</D:iswriteable>");
        break;
      case "issparsesupported":
        found.push("<D:issparsesupported>0</D:issparsesupported>");
        break;
      case "maxuploadpacketsize":
        found.push(`<D:maxuploadpacketsize>${MAX_UPLOAD_PACKET_SIZE}</D:maxuploadpacketsize>`);
        break;
      case "linkishint":
      case "qproptype":
      case "ms-fsstoragetype":
      case "ms-author-via":
        found.push(`<D:${name}/>`);
        break;
      default:
        notFound.push(name);
    }
  }
  return { found: found.join(""), notFound };
}
__name(renderProps, "renderProps");
function bookEntry(collection, bucket, book) {
  const def = COLLECTIONS[collection];
  return {
    path: def.bucketed ? `/${collection}/${bucket}/${book.leaf_name}` : `/${collection}/${book.leaf_name}`,
    isCollection: false,
    meta: {
      // 解析过 EPUB 时用真实书名/作者，否则退回文件名
      displayName: book.title || book.leaf_name,
      lastModified: book.updated_at,
      created: book.created_at,
      etag: `"${book.etag ?? book.id}"`,
      contentType: book.content_type,
      contentLength: book.size,
      language: book.language
    }
  };
}
__name(bookEntry, "bookEntry");
async function collectDavEntries(node, depth, env, cfg) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  switch (node.kind) {
    case "root": {
      const entries = [
        { path: "/", isCollection: true, meta: { displayName: "webooks" } }
      ];
      if (depth === 0) return entries;
      for (const def of Object.values(COLLECTIONS)) {
        entries.push({
          path: `/${def.id}/`,
          isCollection: true,
          meta: { displayName: def.label }
        });
      }
      return entries;
    }
    case "nav": {
      const label = COLLECTIONS[node.collection].label;
      const entries = [
        { path: `/${node.collection}/`, isCollection: true, meta: { displayName: label } }
      ];
      if (depth === 0) return entries;
      const buckets = await listBucketTotals(env.DB, node.collection);
      for (const b of buckets) {
        entries.push({
          path: `/${node.collection}/${b.bucket}/`,
          isCollection: true,
          meta: { displayName: bucketLabel(b.bucket) }
        });
      }
      return entries;
    }
    case "list": {
      const total = await getBucketTotal(env.DB, node.collection, node.bucket);
      const offset = (node.page - 1) * cfg.maxEntries;
      if (node.page > 1 && offset >= total) return null;
      const selfPath = nodePath(node);
      const entries = [
        { path: selfPath, isCollection: true, meta: { displayName: selfPath } }
      ];
      if (depth === 0) return entries;
      const books = await listBooks(env.DB, node.collection, node.bucket, offset, cfg.maxEntries);
      for (const book of books) entries.push(bookEntry(node.collection, node.bucket, book));
      if (node.page === 1) {
        const pageCount = Math.min(Math.ceil(total / cfg.maxEntries), PAGINATION_MAX + 1);
        const def = COLLECTIONS[node.collection];
        for (let p = 2; p <= pageCount; p++) {
          entries.push({
            path: def.bucketed ? `/${node.collection}/${node.bucket}/${p}/` : `/${node.collection}/${p}/`,
            isCollection: true,
            meta: { displayName: `\u7B2C ${p} \u9875` }
          });
        }
      }
      return entries;
    }
    case "leaf": {
      const book = await findBookByLeaf(env.DB, node.leafName);
      if (!book) return null;
      return [bookEntry(node.collection, node.bucket, book)];
    }
    default:
      return null;
  }
}
__name(collectDavEntries, "collectDavEntries");
function collectionEtag(entries) {
  let newest = "";
  for (const e of entries) {
    const t = e.meta.lastModified ?? "";
    if (t > newest) newest = t;
  }
  return `"d-${entries.length}-${hash(newest + entries.map((e) => e.path).join("|"))}"`;
}
__name(collectionEtag, "collectionEtag");
function stabiliseEntryTimes(entries) {
  let newest = "";
  for (const e of entries) {
    const t = e.meta.lastModified ?? "";
    if (t > newest) newest = t;
  }
  const fallback = newest || "1970-01-01T00:00:00.000Z";
  for (const e of entries) {
    if (!e.meta.lastModified) e.meta.lastModified = fallback;
    if (!e.meta.created) e.meta.created = fallback;
  }
  return fallback;
}
__name(stabiliseEntryTimes, "stabiliseEntryTimes");
async function handlePropfind(request, env, cfg, davPath) {
  const depthResult = resolveDepth(request.headers.get("depth"), cfg);
  if ("rejected" in depthResult) {
    return new Response(davError("propfind-finite-depth"), {
      status: 403,
      headers: { "content-type": "application/xml; charset=utf-8" }
    });
  }
  const { depth } = depthResult;
  const bodyText = await request.text().catch(() => "");
  const propReq = parsePropfindBody(bodyText);
  const cache = cfg.propfindTtl > 0 ? davCache() : null;
  const cacheKeyUrl = entriesCacheKey(davPath, depth);
  let entries = null;
  let cacheState = cache ? "MISS" : "OFF";
  if (cache) {
    const hit = await cache.match(cacheKeyUrl);
    if (hit) {
      entries = await hit.json();
      cacheState = "HIT";
    }
  }
  if (!entries) {
    entries = await collectDavEntries(resolveNode(davPath), depth, env, cfg);
    if (!entries) {
      return new Response("Not Found\n", { status: 404, headers: { "content-type": "text/plain" } });
    }
    stabiliseEntryTimes(entries);
    if (cache) {
      try {
        await cache.put(
          cacheKeyUrl,
          new Response(JSON.stringify(entries), {
            headers: {
              "content-type": "application/json",
              "cache-control": `public, max-age=${cfg.propfindTtl}`
            }
          })
        );
      } catch {
      }
    }
  }
  {
    const allLocks = await allLiveLocks(env.DB);
    if (allLocks.size > 0) {
      const matched = matchLocksToPaths(allLocks, entries.map((e) => e.path));
      for (const e of entries) {
        const lock = matched.get(e.path);
        if (lock) {
          e.meta.lockDiscoveryXml = lockDiscoveryXml(lock, `${cfg.mountPath}${e.path}`);
        }
      }
    }
  }
  const dirEtag = collectionEtag(entries);
  const responses = entries.map((entry) => {
    const meta = entry.isCollection ? { ...entry.meta, etag: dirEtag } : entry.meta;
    const { found, notFound } = renderProps(entry.isCollection, propReq, meta);
    const href = encodeHref(`${cfg.mountPath}${entry.path}`, entry.isCollection);
    return davResponse(href, found, notFound);
  });
  const response = multistatusResponse(multistatus(responses), cfg.propfindTtl);
  response.headers.set("x-dav-entries", String(entries.length));
  response.headers.set("x-dav-cache", cacheState);
  return response;
}
__name(handlePropfind, "handlePropfind");

// src/webdav/index.ts
var ALLOW = "OPTIONS, GET, HEAD, PROPFIND, PROPPATCH, MKCOL, LOCK, UNLOCK, PUT, DELETE, COPY, MOVE";
var DAV_HEADER = "1, 2, 3";
async function handleDav(request, env, cfg, davPath) {
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: {
        allow: ALLOW,
        dav: DAV_HEADER,
        "ms-author-via": "DAV"
      }
    });
  }
  if (method === "PROPFIND") return handlePropfind(request, env, cfg, davPath);
  const node = resolveNode(davPath);
  switch (method) {
    case "GET":
    case "HEAD":
      return handleGet(env, cfg, node, davPath, method === "HEAD");
    case "PUT":
      return handleLockedWrite(() => handlePut(request, env, node, davPath), env, davPath);
    case "DELETE":
      return handleLockedWrite(() => handleDelete(env, node, davPath), env, davPath);
    case "MKCOL":
      return handleMkcol(request, env, node, davPath);
    case "MOVE":
      return handleMoveCopy(request, env, cfg, node, davPath, true);
    case "COPY":
      return handleMoveCopy(request, env, cfg, node, davPath, false);
    case "LOCK":
      return handleLock(request, env, davPath);
    case "UNLOCK":
      return handleUnlock(request, env, davPath);
    case "PROPPATCH":
      return handleProppatch(request, env, node, davPath);
    default:
      return methodNotAllowed(ALLOW);
  }
}
__name(handleDav, "handleDav");
async function handleLockedWrite(run, env, davPath) {
  const lock = await liveLockForResource(env.DB, davPath);
  if (lock) {
    return lockConflictResponse(lock, davPath);
  }
  return run();
}
__name(handleLockedWrite, "handleLockedWrite");
function lockConflictResponse(lock, davPath) {
  const xml = lockDiscoveryXml(
    {
      token: lock.token,
      resource: lock.resource,
      owner: lock.owner,
      type: lock.type,
      depth: lock.depth,
      timeoutSec: lock.timeoutSec,
      createdAt: "",
      expiresAt: ""
    },
    davPath
  );
  return new Response(
    `<?xml version="1.0" encoding="utf-8"?>
<D:response xmlns:D="DAV:"><D:href>${escapeXml(davPath)}</D:href><D:propstat><D:prop><D:lock /></D:prop><D:status>HTTP/1.1 423 Locked</D:status></D:propstat><D:lockdiscovery>${xml}</D:lockdiscovery></D:response>`,
    {
      status: 423,
      headers: {
        "content-type": "application/xml; charset=utf-8",
        "lock-token": lock.token
      }
    }
  );
}
__name(lockConflictResponse, "lockConflictResponse");
async function handleLock(request, env, davPath) {
  const body = await request.text().catch(() => "");
  const typeMatch = body.match(/<D:(exclusive|write)\/>/i);
  const type = typeMatch ? "exclusive" : "exclusive";
  const scopeMatch = body.match(/<D:scope><D:(exclusive|shared)\/>/i);
  const scope = scopeMatch ? scopeMatch[1] === "shared" ? "shared" : "exclusive" : "exclusive";
  const depthMatch = body.match(/<D:depth>(\w+)<\/D:depth>/i);
  const depth = depthMatch ? depthMatch[1] : "infinity";
  const timeoutSec = parseTimeoutHeader(request.headers.get("timeout"));
  const owner = body.match(/<D:owner>([\s\S]*?)<\/D:owner>/i)?.[1]?.trim() ?? null;
  const ifHeader = request.headers.get("if");
  const ifToken = ifHeader?.match(/<urn:uuid:[0-9a-f-]+>/i)?.[0] ?? null;
  try {
    const { lock, isRefresh } = await acquireLock(env.DB, {
      resource: davPath,
      type: scope,
      depth,
      timeoutSec,
      owner,
      refreshToken: ifToken
    });
    const lockXml = lockDiscoveryXml({ ...lock, createdAt: lock.createdAt, expiresAt: lock.expiresAt }, davPath);
    const status = 200;
    return new Response(lockXml, {
      status,
      headers: {
        "content-type": "application/xml; charset=utf-8",
        "lock-token": lock.token
      }
    });
  } catch (err) {
    if (err.lockConflict) {
      const live = await liveLockForResource(env.DB, davPath);
      const conflictXml = live ? lockDiscoveryXml(live, davPath) : "";
      return new Response(
        `<?xml version="1.0" encoding="utf-8"?>
<D:response xmlns:D="DAV:"><D:href>${escapeXml(davPath)}</D:href><D:propstat><D:prop><D:lock /></D:prop><D:status>HTTP/1.1 423 Locked</D:status></D:propstat>` + (conflictXml ? `<D:lockdiscovery>${conflictXml}</D:lockdiscovery>` : ""),
        {
          status: 423,
          headers: { "content-type": "application/xml; charset=utf-8" }
        }
      );
    }
    throw err;
  }
}
__name(handleLock, "handleLock");
async function handleUnlock(request, env, davPath) {
  const tokenHeader = request.headers.get("lock-token");
  if (!tokenHeader) {
    await releaseLock(env.DB, davPath);
    return new Response(null, { status: 204 });
  }
  const live = await liveLockForResource(env.DB, davPath);
  if (!live || live.token !== tokenHeader) {
    const xml = live ? `<D:unlock-response><D:href>${escapeXml(davPath)}</D:href><D:locktoken>${live.token}</D:locktoken></D:unlock-response>` : `<D:unlock-response><D:href>${escapeXml(davPath)}</D:href></D:unlock-response>`;
    return new Response(xml, {
      status: live ? 423 : 409,
      headers: { "content-type": "application/xml; charset=utf-8" }
    });
  }
  await releaseLock(env.DB, tokenHeader);
  return new Response(null, { status: 204 });
}
__name(handleUnlock, "handleUnlock");
async function handleMkcol(request, env, node, davPath) {
  return new Response(null, { status: 201, headers: { "content-length": "0" } });
}
__name(handleMkcol, "handleMkcol");
async function handleProppatch(request, env, node, davPath) {
  const body = await request.text().catch(() => "");
  const propNames = [
    ...body.matchAll(/<(?:[A-Za-z0-9_.-]+:)?([A-Za-z][A-Za-z0-9_.-]*)(?:\s[^>]*)?\/>/g)
  ].map((m) => m[1]);
  const propXml = propNames.map((p) => `<D:prop><D:${p}/></D:prop>`).join("");
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:"><D:response><D:href>${escapeXml(davPath)}</D:href><D:propstat>${propXml ? `<D:prop>${propXml}</D:prop>` : ""}<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;
  return new Response(xml, {
    status: 207,
    headers: { "content-type": "application/xml; charset=utf-8" }
  });
}
__name(handleProppatch, "handleProppatch");
async function handleMoveCopy(request, env, cfg, node, davPath, isMove) {
  const dest = request.headers.get("destination");
  if (!dest) return textResponse(400, "Destination header required", { allow: ALLOW });
  if (node.kind !== "leaf") {
    return textResponse(
      403,
      "Only leaf files can be moved/copied (virtual collections are derived, not stored)",
      { allow: ALLOW }
    );
  }
  const sourceBook = await findBookByLeaf(env.DB, node.leafName);
  if (!sourceBook) return textResponse(404, "Source not found", { allow: ALLOW });
  let targetDavPath;
  try {
    const destUrl = new URL(dest, "https://webooks.invalid");
    let rawPath = destUrl.pathname;
    const mount2 = cfg.mountPath;
    if (mount2 && rawPath.startsWith(mount2)) rawPath = rawPath.slice(mount2.length) || "/";
    targetDavPath = rawPath;
  } catch {
    return textResponse(400, "Invalid Destination URL", { allow: ALLOW });
  }
  const targetNode = resolveNode(targetDavPath);
  if (targetNode.kind !== "leaf") {
    return textResponse(400, "Destination must be a file path", { allow: ALLOW });
  }
  for (const p of [davPath, targetDavPath]) {
    const lock = await liveLockForResource(env.DB, p);
    if (lock) return lockConflictResponse(lock, p);
  }
  const targetLeaf = targetNode.leafName;
  const targetBook = await findBookByLeaf(env.DB, targetLeaf);
  const targetId = targetBook?.id ?? shortId(8);
  const targetR2Key = `books/${targetId}`;
  const sourceObj = await env.BUCKET.get(sourceBook.r2_key);
  if (!sourceObj) return textResponse(404, "Source object not found in R2", { allow: ALLOW });
  await env.BUCKET.put(targetR2Key, sourceObj.body, {
    httpMetadata: { contentType: sourceBook.content_type }
  });
  const targetLeafName = sanitiseLeafName(targetLeaf) ?? targetLeaf;
  await upsertBook(env.DB, {
    id: targetId,
    leafName: targetLeafName,
    title: sourceBook.title,
    author: sourceBook.author,
    language: sourceBook.language,
    format: sourceBook.format,
    contentType: sourceBook.content_type,
    size: sourceBook.size,
    sha256: sourceBook.sha256,
    r2Key: targetR2Key,
    etag: null,
    titleLetter: letterBucket(sourceBook.title),
    authorLetter: letterBucket(sourceBook.author ?? sourceBook.title),
    formatBucket: sourceBook.format_bucket,
    publishedAt: (/* @__PURE__ */ new Date()).toISOString(),
    coverKey: null
  });
  if (isMove) {
    await env.BUCKET.delete(sourceBook.r2_key);
    await deleteBook(env.DB, sourceBook.id);
    await releaseLock(env.DB, davPath);
  }
  await rebuildBuckets(env.DB);
  await purgeEntries(
    bookCacheTargets({
      leafName: targetLeafName,
      titleLetter: letterBucket(sourceBook.title),
      authorLetter: letterBucket(sourceBook.author ?? sourceBook.title),
      formatBucket: sourceBook.format_bucket
    })
  );
  const reqUrl = new URL(request.url);
  const mount = cfg.mountPath;
  const locationHref = mount ? `${mount}${targetDavPath}` : targetDavPath;
  const locationUrl = `${reqUrl.protocol}//${reqUrl.host}${locationHref}`;
  return new Response(null, {
    status: 201,
    headers: {
      location: locationUrl,
      "content-length": "0"
    }
  });
}
__name(handleMoveCopy, "handleMoveCopy");
async function handleGet(env, cfg, node, davPath, headOnly) {
  if (node.kind === "leaf") {
    const book = await findBookByLeaf(env.DB, node.leafName);
    if (!book) return textResponse(404, "Not Found");
    if (headOnly) {
      return new Response(null, {
        status: 200,
        headers: {
          "content-length": String(book.size),
          "content-type": book.content_type,
          etag: `"${book.etag ?? book.id}"`,
          "last-modified": new Date(book.updated_at).toUTCString(),
          "accept-ranges": "bytes"
        }
      });
    }
    const headers2 = {
      location: `${cfg.r2PublicBase}/${encodeR2Key(book.r2_key)}`,
      "cache-control": "no-store",
      "accept-ranges": "bytes"
    };
    return new Response(null, { status: 302, headers: headers2 });
  }
  const entries = await collectDavEntries(node, 1, env, cfg);
  if (!entries) return textResponse(404, "Not Found");
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "public, max-age=300"
  };
  if (headOnly) return new Response(null, { status: 200, headers });
  return new Response(renderHtmlIndex(davPath, entries, cfg.mountPath), { status: 200, headers });
}
__name(handleGet, "handleGet");
function encodeR2Key(key) {
  return key.split("/").map((s) => encodeURIComponent(s)).join("/");
}
__name(encodeR2Key, "encodeR2Key");
function renderHtmlIndex(davPath, entries, mountPath) {
  const rows = entries.filter((e) => e.path !== davPath).map((e) => {
    const label = e.isCollection ? `${e.meta.displayName}/` : e.meta.displayName;
    const size = e.isCollection ? "" : ` <span class="sz">${formatSize(e.meta.contentLength ?? 0)}</span>`;
    return `<li><a href="${escapeAttr(`${mountPath}${e.path}`)}">${escapeAttr(label)}</a>${size}</li>`;
  }).join("\n");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeAttr(davPath)} \u2014 webooks</title>
<style>
  body{font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
  h1{font-size:1.05rem;font-weight:600;border-bottom:1px solid #e5e5e5;padding-bottom:.5rem;word-break:break-all}
  ul{list-style:none;padding:0}li{padding:.15rem 0}
  a{color:#0b62d0;text-decoration:none}a:hover{text-decoration:underline}
  .sz{color:#999;font-size:.85em}
  footer{margin-top:2rem;color:#888;font-size:.85rem}
</style></head>
<body>
<h1>${escapeAttr(davPath)}</h1>
<ul>${rows}</ul>
<footer>WebDAV \u7AEF\u70B9 <code>/dav/</code> \xB7 \u5BA2\u6237\u7AEF\u6302\u8F7D\u5EFA\u8BAE\u7528 rclone\uFF08\u89C1 README\uFF09</footer>
</body></html>`;
}
__name(renderHtmlIndex, "renderHtmlIndex");
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
__name(formatSize, "formatSize");
function escapeAttr(s) {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}
__name(escapeAttr, "escapeAttr");
async function handlePut(request, env, node, davPath) {
  if (node.kind !== "leaf") {
    return textResponse(405, "PUT is only allowed on file paths", { allow: ALLOW });
  }
  const leafName = sanitiseLeafName(node.leafName);
  if (!leafName) return textResponse(400, "Invalid file name");
  if (!request.body) return textResponse(411, "Length Required");
  const meta = deriveMetadata(leafName);
  const existing = await findBookByLeaf(env.DB, leafName);
  const id = existing?.id ?? shortId(8);
  const r2Key = `books/${id}`;
  const contentType = preferContentType(request.headers.get("content-type"), meta.contentType);
  const currentEtag = existing?.etag ? `"${existing.etag}"` : null;
  const precondition = checkPreconditions(request.headers, currentEtag);
  if (!precondition.ok) {
    return textResponse(412, `Precondition Failed: ${precondition.reason}`, { allow: ALLOW });
  }
  const isEpub = meta.format === "epub";
  let parsed = null;
  let coverKey = null;
  let object;
  if (isEpub) {
    const buf = await request.arrayBuffer();
    if (buf.byteLength <= PARSE_SIZE_CAP) {
      object = await env.BUCKET.put(r2Key, new Uint8Array(buf), { httpMetadata: { contentType } });
      try {
        parsed = await parseEpub(buf);
        if (parsed?.cover) {
          const coverType = parsed.cover.contentType || "image/jpeg";
          const ext = coverType.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
          coverKey = `covers/${id}.${ext}`;
          await env.BUCKET.put(coverKey, new Uint8Array(parsed.cover.bytes), {
            httpMetadata: { contentType: coverType }
          });
        }
      } catch {
      }
    } else {
      object = await env.BUCKET.put(r2Key, buf, { httpMetadata: { contentType } });
    }
  } else {
    object = await env.BUCKET.put(r2Key, request.body, {
      httpMetadata: { contentType }
    });
  }
  const title = parsed?.title ?? meta.title;
  const author = parsed?.author ?? meta.author;
  await upsertBook(env.DB, {
    id,
    leafName,
    title,
    author,
    language: parsed?.language ?? null,
    format: meta.format,
    contentType,
    size: object?.size ?? 0,
    sha256: null,
    // Phase 1：Queue consumer 计算哈希并校验墓碑表
    r2Key,
    etag: object?.etag ?? null,
    titleLetter: letterBucket(title),
    authorLetter: letterBucket(author ?? title),
    formatBucket: meta.format,
    publishedAt: (/* @__PURE__ */ new Date()).toISOString(),
    coverKey
  });
  await rebuildBuckets(env.DB);
  await purgeEntries(
    bookCacheTargets({
      leafName,
      titleLetter: letterBucket(title),
      authorLetter: letterBucket(author ?? title),
      formatBucket: meta.format
    })
  );
  const headers = new Headers();
  if (object?.etag) headers.set("etag", `"${object.etag}"`);
  return new Response(null, { status: existing ? 204 : 201, headers });
}
__name(handlePut, "handlePut");
async function handleDelete(env, node, davPath) {
  if (node.kind !== "leaf") {
    return textResponse(405, "DELETE is only allowed on file paths", { allow: ALLOW });
  }
  const book = await findBookByLeaf(env.DB, node.leafName);
  if (!book) return textResponse(404, "Not Found");
  await env.BUCKET.delete(book.r2_key);
  await deleteBook(env.DB, book.id);
  await rebuildBuckets(env.DB);
  await purgeEntries(
    bookCacheTargets({
      leafName: book.leaf_name,
      titleLetter: book.title_letter,
      authorLetter: book.author_letter,
      formatBucket: book.format_bucket
    })
  );
  return new Response(null, { status: 204 });
}
__name(handleDelete, "handleDelete");

// src/index.ts
var index_default = {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/health") {
      return Response.json({ ok: true, service: "webooks" });
    }
    if (path === "/api/upload/init") {
      return handleUploadInit(request, env);
    }
    if (path === "/api/upload/complete") {
      return handleUploadComplete(request, env);
    }
    if (path === "/api/turnstile-config") {
      return Response.json({ siteKey: env.TURNSTILE_SITE_KEY ?? null });
    }
    let cfg;
    try {
      cfg = settings(env);
    } catch (err) {
      return textResponse(
        500,
        `Configuration error: ${err.message}
Set R2_PUBLIC_BASE in wrangler.jsonc vars to your R2 public custom domain.`
      );
    }
    if (path.startsWith("/api/admin/")) {
      return guarded(() => handleAdmin(request, env, cfg, url));
    }
    const mount = cfg.mountPath;
    const isDav = mount === "" || path === mount || path.startsWith(`${mount}/`);
    if (isDav) {
      const davPath = mount === "" ? path : path.slice(mount.length) || "/";
      return guarded(() => handleDav(request, env, cfg, davPath));
    }
    if (path === "/" || path === "") {
      return new Response(indexHtml(cfg), {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=3600"
        }
      });
    }
    if (path === "/upload" || path === "/upload/") {
      return new Response(uploadHtml(env.TURNSTILE_SITE_KEY ?? ""), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
      });
    }
    return textResponse(404, "Not Found");
  }
};
async function guarded(run) {
  try {
    return await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no such table|no such column|no such index/i.test(message)) {
      return textResponse(
        503,
        "Database schema is not initialised.\n\nD1 \u5DF2\u7ED1\u5B9A\u4F46\u8FD8\u6CA1\u5EFA\u8868\u3002\u6267\u884C\uFF1A\n  npm run db:migrate          # \u672C\u5730\u914D\u7F6E\u4E86\u8FDC\u7AEF\u51ED\u636E\u65F6\n  \u6216\u5728 Cloudflare \u7684 Deploy command \u91CC\u4F7F\u7528\uFF1A\n  npx wrangler deploy && npx wrangler d1 migrations apply DB --remote\n",
        { "retry-after": "60" }
      );
    }
    throw err;
  }
}
__name(guarded, "guarded");
function indexHtml(cfg) {
  const mount = `${cfg.mountPath}/`;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>webooks</title>
<style>
  body{font:16px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:44rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}
  h1{font-size:1.3rem}
  code,pre{background:#f4f4f5;border-radius:4px;font-size:.9em}
  code{padding:.15em .4em}
  pre{padding:.8rem 1rem;overflow-x:auto}
  li{margin:.3rem 0}
</style></head>
<body>
<h1>webooks</h1>
<p>Cloudflare Workers Free + R2 \u4E0A\u7684 WebDAV \u7535\u5B50\u4E66\u5E93\u3002</p>
<ul>
  <li>WebDAV \u7AEF\u70B9\uFF1A<a href="${mount}"><code>${mount}</code></a></li>
  <li>\u5065\u5EB7\u68C0\u67E5\uFF1A<code>/health</code></li>
</ul>
<p>\u5BA2\u6237\u7AEF\u6302\u8F7D\u5EFA\u8BAE\u7528 rclone\uFF0C\u5E76\u628A\u76EE\u5F55\u7F13\u5B58\u62C9\u957F\u4EE5\u8282\u7701\u6BCF\u65E5\u8BF7\u6C42\u989D\u5EA6\uFF1A</p>
<pre><code>rclone mount webooks: /mnt/books \\
  --dir-cache-time 24h --poll-interval 0 --vfs-cache-mode off</code></pre>
<p>\u6CE8\u610F\uFF1AWebDAV \u6BCF\u4E2A\u8BF7\u6C42\u90FD\u4F1A\u6D88\u8017 Workers Free \u6BCF\u5929 100,000 \u6B21\u7684\u989D\u5EA6\u3002
\u80FD\u8BB2 S3 \u7684\u5BA2\u6237\u7AEF\uFF08rclone\u3001\u811A\u672C\uFF09\u8BF7\u76F4\u63A5\u8FDE R2 \u7684 S3 \u7AEF\u70B9\uFF0C\u90A3\u6837\u662F 0 \u6B21 Worker \u8BF7\u6C42\u3002</p>
</body></html>`;
}
__name(indexHtml, "indexHtml");
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
