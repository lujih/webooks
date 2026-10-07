-- webooks migration 0002：EPUB 解析产物
--
-- cover_key   封面图在 R2 的对象键（covers/{id}.{ext}），没有封面/非 EPUB 为 NULL
-- description 简介（OPF 的 <dc:description>，Phase 2 先预留，暂不解析）
ALTER TABLE books ADD COLUMN cover_key TEXT;
ALTER TABLE books ADD COLUMN description TEXT;
