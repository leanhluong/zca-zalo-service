// In-memory bounded cache: gMsgID (string) → cliMsgId (string)
// addReaction yêu cầu cả msgId (gMsgID) lẫn cliMsgId, nhưng upstream chỉ gửi msgId.
// Listener quan sát message nào thì lưu cặp này lại để route reaction tra cứu ngược.

const MAX_ENTRIES = 5000;
const cache = new Map<string, string>(); // insertion-ordered → dùng làm LRU đơn giản

export function rememberMsgId(
  gMsgID: string | number | null | undefined,
  cliMsgId: string | number | null | undefined,
): void {
  if (gMsgID == null || cliMsgId == null) return;
  const key = String(gMsgID);
  const val = String(cliMsgId);
  if (!key || !val) return;
  // refresh recency: xoá rồi set lại để key về cuối thứ tự insertion
  if (cache.has(key)) cache.delete(key);
  cache.set(key, val);
  // bound size: xoá entry cũ nhất (đầu Map)
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

export function getCliMsgId(gMsgID: string | number | null | undefined): string | null {
  if (gMsgID == null) return null;
  return cache.get(String(gMsgID)) ?? null;
}
