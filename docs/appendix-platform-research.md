# Cloudflare WebDAV Public Library — Feasibility Research

Research date **2026-10-05**. Doc dates = "Last updated" as served today.

## 1. Workers request body limit (Cloudflare plan, not Workers plan)

| Plan | Max request body |
|---|---|
| Free | 100 MB |
| Pro | 100 MB |
| Business | 200 MB |
| Enterprise | Up to 5 GB self-serve; **default 500 MB** |

[Workers Limits](https://developers.cloudflare.com/workers/platform/limits/) (Sep 5, 2026): *"Request body size limits depend on your Cloudflare account plan, not your Workers plan. Requests exceeding these limits return a `413 Request entity too large` error."* Same table: [Error 413 KB](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/), [Cache upload limits](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/), [changelog 2026-09-04](https://developers.cloudflare.com/changelog/post/2026-09-04-enterprise-self-serve-upload-limits/).

- **Streaming `request.body`:** no documented exemption — it is a proxy-layer zone limit, so it constrains the inbound request regardless. Streaming bypass is **unverified inference**.
- **PUT + Content-Length:** applies. 413 KB: *"Setting the limit below the size of an incoming request causes a 413."*
- **Chunked encoding:** **not documented either way**; no exemption documented.
- **Documented workarounds:** chunk requests, use a **DNS-only (unproxied)** record, or upgrade. >5 GB needs Support; large uploads may hit read timeouts first.

**Escape hatch:** the R2 S3 endpoint (`<ACCOUNT_ID>.r2.cloudflarestorage.com`) is not a proxied zone, so presigned PUTs bypass the zone limit (R2's 5 GiB single-part cap applies).

## 2. Non-standard methods (PROPFIND, MKCOL, MOVE, LOCK…)

**Runtime, documented:** *"In Workers, all HTTP request methods are supported, except for `CONNECT`."* — [Request API](https://developers.cloudflare.com/workers/runtime-apis/request/).

**Edge:** no method allowlist is published, and no doc says these verbs are blocked or have bodies stripped. That is absence of documentation, not a guarantee.

**Deployed precedent:** [FlareDrive](https://github.com/longern/FlareDrive) (554★), [r2-webdav](https://github.com/abersheeran/r2-webdav) (419★, *"advertises WebDAV Class 1 and Class 2 (LOCK/UNLOCK)"*, CI runs litmus `basic`/`copymove`/`props`/`locks`), [CFr2-webdav](https://github.com/aigem/CFr2-webdav) (225★), [Davflare](https://github.com/fanchenggang/Davflare) (73★), [bookodav](https://github.com/Joshuajrodrigues/bookodav) (33★, WebDAV for **ebooks**/KOReader).

**The blocker is body size, not verbs.** FlareDrive verbatim: *"the standard WebDAV protocol does not support large file (≥128MB) uploads due to the limitation of Cloudflare Workers. You must upload large files through the web interface which supports chunked uploads."*

**Unverified:** any difference between `*.workers.dev`, orange-cloud Route, and Workers Custom Domains for custom verbs; any WAF/`Depth`-header interference. `community.cloudflare.com` returned **403** to every non-browser client, so forum threads could not be read. CDN does not cache non-GET.

## 3. Workers compute limits

[Workers Limits](https://developers.cloudflare.com/workers/platform/limits/): CPU/request **10 ms Free**, **Paid 5 min max, default 30 s**; memory **128 MB per isolate** (both); subrequests **50 Free / 10,000 Paid**; simultaneous outgoing connections **6** (both); Free **100,000 req/day**; HTTP duration **unlimited**; no response body limit. CPU excludes I/O waits; overrun → Error 1102. The 6-connection cap applies only while awaiting response *headers*. Docs recommend `TransformStream` over buffering — but 128 MB is **per isolate**, shared across concurrent requests.

## 4. R2

[Limits](https://developers.cloudflare.com/r2/platform/limits/) (Jun 8, 2026): object **5 TiB**; single-part **5 GiB**, multipart **4.995 TiB**, **10,000 parts**; key 1,024 B; metadata 8,192 B; **1 write/second per object key** (429 beyond).

[Pricing](https://developers.cloudflare.com/r2/pricing/) (Oct 1, 2026): Standard **$0.015/GB-mo**; Class A **$4.50/M**; Class B **$0.36/M**; **egress free**; free tier 10 GB-mo / 1M A / 10M B; usage rounds **up**. Class A = mutating (`PutObject`, `CopyObject`, `CreateMultipartUpload`, `UploadPart`, `ListObjects`); Class B = reads. `DeleteObject` is **free**.

**S3 quirks** ([compat](https://developers.cloudflare.com/r2/api/s3/api/), Jul 31, 2026): region must be `auto`; no ACLs, object locking, tagging, or SSE-KMS; a failed re-`UploadPart` destroys the original part.

**Presigned URLs** ([docs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), Aug 22, 2026): GET/HEAD/PUT/DELETE, expiry 1 s–7 days; `POST` forms unsupported; **cannot** be used with custom domains.

**Public buckets** ([docs](https://developers.cloudflare.com/r2/buckets/public-buckets/), Sep 25, 2026): `r2.dev` is *"not intended for production"*, throttled to **429** at hundreds of req/s; CNAME to `r2.dev` unsupported. Use a custom domain.

**Versioning: not supported** — `PutBucketVersioning`/`GetBucketVersioning` are unimplemented. **Lifecycle rules: yes** — expiration, transition, abort-incomplete-multipart (default 7 days), **max 1,000 rules**, applied within ~24 h. This is your abuse-cleanup mechanism ([lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)).

**No official objection to R2 as a public file host found.** Cloudflare ships a reference architecture, *["Storing user generated content"](https://developers.cloudflare.com/reference-architecture/diagrams/storage/storing-user-generated-content/)* (Oct 13, 2025), recommending R2 as *"ideal for handling content uploads and delivery at scale."* It prescribes **signed URLs after validating permissions** — validated, not unbounded anonymous, uploads.

## 5. D1

[Limits](https://developers.cloudflare.com/d1/platform/limits/) (Apr 21, 2026): DB max **10 GB Paid / 500 MB Free** and *"cannot be further increased"*; row/BLOB **2 MB**; statement 100 KB; **query duration 30 s**; **6 simultaneous connections** per invocation. Each DB is **single-threaded** (one Durable Object) — throughput ≈ 1/query-duration (~1,000 qps at 1 ms, 10 qps at 100 ms).

[Pricing](https://developers.cloudflare.com/d1/platform/pricing/): Free 5M reads/day, 100k writes/day, 5 GB. Paid: **25 billion rows read/mo included**, then $0.001/M; **50M rows written/mo**, then $1.00/M; 5 GB then $0.75/GB-mo. Reads count **rows scanned**, not returned.

**~1M rows: well suited** — fits the 10 GB cap and free allotments *if indexed*. The risk is scan amplification.

## 6. Durable Objects

[Limits](https://developers.cloudflare.com/durable-objects/platform/limits/) (Jun 1, 2026): **10 GB per SQLite DO** (5 GB/account Free); value ≤2 MB; CPU **30 s default, 5 min max**; **~1,000 req/s soft limit per object**; unlimited objects; wall time **unlimited**.

[Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) (Sep 30, 2026): 1M req/mo then **$0.15/M**; 400,000 GB-s then **$12.50/M GB-s**; SQLite 5 GB-mo then **$0.20/GB-mo**; rows priced as D1. Duration bills the **full 128 MB** while active and not hibernating.

**Verdict:** DO is the **right** home for LOCK state — the only strongly-consistent, serialized primitive, and `r2-webdav` proves the pattern. For rate limiting it is the **most expensive** option; prefer the [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) and reserve DO for locks.

## 7. KV

[Limits](https://developers.cloudflare.com/kv/platform/limits/) (Apr 21, 2026): Free **100k reads/day, 1,000 writes/day**, 1 GB; keys ≤512 B; values ≤25 MiB; **1 write/second per key**; min `cacheTtl` 30 s. **Eventually consistent** (propagation up to ~60 s) — unusable for lock state or read-after-write. Cold tolerant data only.

## 8. Free-tier WAF / rate limiting / Turnstile

[Rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/) (Aug 25, 2026): **Free = 1 rule**, fixed **10 s** counting and **10 s** mitigation, expression limited to **Path + Verified Bot**, **IP-only** counting. Thin for upload protection (Pro 2, Business 5, Enterprise 100). Custom rules available to *"all customers"* ([docs](https://developers.cloudflare.com/waf/custom-rules/)).

**Turnstile is free** ([plans](https://developers.cloudflare.com/turnstile/plans/), Aug 14, 2026): **unlimited challenges**, **20 widgets**, 10 hostnames/widget, 7-day analytics. Cheapest effective bot gate for uploads.

## 9. Legal / ToS — **section 2.8 no longer exists**

The premise is outdated. The live [Self-Serve Subscription Agreement](https://www.cloudflare.com/terms/) is **"Last Updated September 12, 2025"** and contains **no 2.8**, no "non-HTML", no "file storage" clause. **2.7 is "Acceptable Use."**

Cloudflare removed it deliberately — [blog, May 16, 2023](https://blog.cloudflare.com/updated-tos/): *"we moved the content-based restriction concept to a new CDN-specific section in our Service-Specific Terms… we got rid of the antiquated HTML vs. non-HTML construct… customers can serve video and other large files using the CDN so long as that content is hosted by a Cloudflare service like Stream, Images, or R2."*

It now sits in [Service-Specific Terms → CDN](https://www.cloudflare.com/service-specific-terms-application-services/): *"Unless you are an Enterprise customer, Cloudflare offers specific Paid Services (e.g., the Developer Platform, Images, and Stream) that you must use in order to serve video and other large files via the CDN."*

**The Developer Platform (Workers + R2) is the sanctioned path — but it says "Paid Services."** Serving large files via the CDN on a *free* Workers plan is exposed; budget the $5 plan as compliance, not capacity.

**The real risk is Section 8 (Termination):** *"…terminate your user account upon receiving any number of DMCA notifications… We may at our sole discretion terminate your user account or Suspend or terminate your use or access to the Service at any time, with or without notice for any reason or no reason at all."* Also 2.2.1(b) (no *"undue burden"*), 2.2.1(j) (no *"VPN or other similar proxy services"*), 2.6 (Free Services terminable at discretion), 2.7(b) (no storing infringing files).

[Abuse approach](https://www.cloudflare.com/trust-hub/abuse-approach/): DMCA notice-and-takedown with counter-notice; *"We may suspend or terminate hosting services… if we conclude that those services have been repeatedly used to store content in violation of our policy and that no meaningful steps have been taken to address the issue."* Its hosting list names Stream, Pages, Workers, KV, Images — **R2 is absent** (likely stale; unverified).

**Risk assessment:** you become the host, so repeat-infringer status attaches to *your* account, and Section 8 permits termination on *"any number"* of DMCA notices or for no reason. Unmoderated anonymous ebook uploads are near worst-case. Mitigate with Turnstile, a designated DMCA agent, hash-based rejection of known-infringing files, takedown SLAs, and lifecycle purges.

## 10. Monthly cost estimate

Workers Paid + Standard R2 + D1; ~2.1M Worker requests; indexed metadata queries.

| Component | Usage | Included | Billable | Rate | Cost |
|---|---|---|---|---|---|
| Workers Paid (base) | — | — | — | $5/mo min | **$5.00** |
| Workers requests | 2.1M | 10M/mo | 0 | $0.30/M | $0.00 |
| Workers CPU | ~4.6M ms | 30M ms | 0 | $0.02/M ms | $0.00 |
| R2 storage | 50 GB-mo | 10 GB-mo | 40 | $0.015/GB-mo | **$0.60** |
| R2 Class A (writes) | 100,000 | 1M/mo | 0 | $4.50/M | $0.00 |
| R2 Class B (reads) | 2,000,000 | 10M/mo | 0 | $0.36/M | $0.00 |
| R2 egress | 5 TB | unlimited | 0 | free | **$0.00** |
| D1 rows read | 50M | 25B/mo | 0 | $0.001/M | $0.00 |
| D1 rows written | 100k | 50M/mo | 0 | $1.00/M | $0.00 |
| D1 storage | ~1 GB | 5 GB | 0 | $0.75/GB-mo | $0.00 |
| Durable Objects | ~200k req | 1M/mo | 0 | $0.15/M | $0.00 |
| DO duration (locks) | ~13k GB-s | 400k GB-s | 0 | $12.50/M GB-s | $0.00 |
| Turnstile | unlimited | free | — | — | $0.00 |
| **TOTAL** | | | | | **≈ $5.60/mo** |

**Scan sensitivity:** if each metadata query scans 1,000 rows, D1 reads = 50B; 50B − 25B included = 25,000M × $0.001 = **$25.00** → ≈ **$30.60/mo**. Indexing is worth ~$25/month. Billing rounds **up**. 5 TB egress is genuinely $0.

## Biggest blockers

1. **100 MB WebDAV PUT ceiling (Free/Pro)** — 413 above it; the hardest constraint, since standard clients issue one PUT. Mitigation: presigned PUT direct to R2 (up to 5 GiB) or a custom chunked path — neither is standard WebDAV.
2. **No R2 object versioning** — overwrites are destructive with no undo; rely on lifecycle rules and your own metadata copies.
3. **LOCK state requires Durable Objects** — impossible in a stateless Worker; correct but adds 128 MB-billed wall-clock and a second failure domain.
4. **Legal exposure scales with anonymity, not with R2** — §2.8 is gone and R2/Workers is the sanctioned path, but only as a **Paid** service; §8's *"any reason or no reason at all"* termination and repeat-infringer suspension make fully open uploads the highest-risk design. Moderation must ship before launch.
5. **Free-plan fragility** — Workers Free (100k req/day, 10 ms CPU), D1 Free (5M reads/day), KV Free (1,000 writes/day) are all far too small. The $5 Workers Paid plan is a floor *and* a compliance requirement.
6. **Unverified edge behaviour** — no doc confirms `Depth: infinity`, WAF inspection of PROPFIND/PUT, or workers.dev vs Custom Domain handling. **Run litmus against the real deployment before committing.**

*Confidence: items 1, 3–8, 10 rest on official docs dated 2026. Item 2 rests on official runtime docs plus deployed GitHub implementations; edge verb/header handling unverified. Item 9 quotes live agreements fetched 2026-10-05.*
