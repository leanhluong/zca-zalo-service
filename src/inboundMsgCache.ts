// In-memory bounded cache: msgId (string) → SendMessageQuote (subset của TMessage).
// Reply/trích dẫn: khi upstream gửi tin trả lời kèm quoteMsgId, send-text cần dựng
// `MessageContent.quote` (type SendMessageQuote của zca-js) từ tin GỐC đã nhận.
// SendMessageQuote = { content, msgType, propertyExt, uidFrom, msgId, cliMsgId, ts, ttl }
// — tất cả đều là field của TMessage (nằm trong msg.data mà listener nhận được).
// Listener quan sát tin nào (message / old_messages) thì lưu lại đây theo msgId.
// Cache in-memory, mất khi restart → send-text graceful degrade (gửi không quote).

import type { ZaloMessage, ZaloRaw } from './types.js';

/**
 * Subset của TMessage đủ để zca-js dựng `MessageContent.quote`.
 * Khai loose vì đây là dữ liệu Zalo — xem ghi chú ranh giới ở types.ts.
 */
export interface CachedQuote {
  content: ZaloRaw;
  msgType: ZaloRaw;
  propertyExt: ZaloRaw;
  uidFrom: string | number;
  msgId: string | number;
  cliMsgId: string | number;
  ts: ZaloRaw;
  ttl: ZaloRaw;
}

export interface MsgRef {
  msgId: string;
  cliMsgId: string;
}

const MAX_ENTRIES = 5000;
const cache = new Map<string, CachedQuote>(); // insertion-ordered → FIFO evict đơn giản

// Dựng object SendMessageQuote từ TMessage (msg.data). Trả null nếu thiếu field
// định danh tối thiểu (msgId/cliMsgId/uidFrom) — không đủ để zca-js dựng quote.
function buildQuote(data: ZaloRaw): CachedQuote | null {
  if (!data) return null;
  const { content, msgType, propertyExt, uidFrom, msgId, cliMsgId, ts, ttl } = data;
  if (msgId == null || cliMsgId == null || uidFrom == null) return null;
  return { content, msgType, propertyExt, uidFrom, msgId, cliMsgId, ts, ttl };
}

// Lưu tin đến (raw zca-js message) vào cache theo msgId để quote về sau.
export function rememberInboundMsg(msg: ZaloMessage | null | undefined): void {
  if (!msg) return;
  const data = msg.data ?? null;
  const rawMsgId = msg.msgId ?? data?.msgId;
  if (rawMsgId == null) return;
  const quote = buildQuote(data);
  if (!quote) return;
  const key = String(rawMsgId);
  if (!key) return;
  // refresh recency: xoá rồi set lại để key về cuối thứ tự insertion
  if (cache.has(key)) cache.delete(key);
  cache.set(key, quote);
  // bound size: xoá entry cũ nhất (đầu Map)
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

// Tra SendMessageQuote theo msgId. Trả null nếu không có (tin cũ / đã restart).
export function getInboundQuote(msgId: string | number | null | undefined): CachedQuote | null {
  if (msgId == null) return null;
  return cache.get(String(msgId)) ?? null;
}

// Tra ref để THU HỒI (undo/recall) 1 tin theo msgId. zca-js api.undo() cần
// UndoPayload = { msgId, cliMsgId } của chính tin ĐÃ GỬI. Tin agent gửi ra được
// self-echo về listener (isSelf=true) nên cũng nằm trong cache này (kèm cliMsgId).
// Trả { msgId, cliMsgId } nếu cache đủ; null nếu miss / thiếu cliMsgId (vd bridge đã restart).
export function getUndoRef(msgId: string | number | null | undefined): MsgRef | null {
  if (msgId == null) return null;
  const quote = cache.get(String(msgId));
  if (!quote || quote.msgId == null || quote.cliMsgId == null) return null;
  return { msgId: String(quote.msgId), cliMsgId: String(quote.cliMsgId) };
}

// Tra ref để THẢ REACTION theo msgId. zca-js api.addReaction() cần
// dest.data = { msgId, cliMsgId } của tin ĐÍCH (tin của khách hoặc của mình).
// Tin đến/tin self-echo đều nằm trong cache này. Dùng làm FALLBACK khi upstream
// không truyền cliMsgId trong body. Trả { msgId, cliMsgId } hoặc null nếu miss.
export function getReactRef(msgId: string | number | null | undefined): MsgRef | null {
  if (msgId == null) return null;
  const quote = cache.get(String(msgId));
  if (!quote || quote.msgId == null || quote.cliMsgId == null) return null;
  return { msgId: String(quote.msgId), cliMsgId: String(quote.cliMsgId) };
}

// Tra thông tin tin gốc để FORWARD (nếu có trong cache). Dùng để dựng
// ForwardMessagePayload.reference.ts (native forward decorLog) và làm nguồn
// nội dung text fallback khi upstream không truyền `content`. Trả object subset
// { content, msgType, ts } hoặc null.
export function getForwardSource(
  msgId: string | number | null | undefined,
): { content: ZaloRaw; msgType: ZaloRaw; ts: ZaloRaw } | null {
  if (msgId == null) return null;
  const quote = cache.get(String(msgId));
  if (!quote) return null;
  return { content: quote.content, msgType: quote.msgType, ts: quote.ts };
}
