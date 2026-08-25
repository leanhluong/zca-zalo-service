import express from 'express';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { ThreadType, Reactions } from 'zca-js';
import { getSessionByAccountId, listSessions } from '../sessionStore.js';
import { getInboundQuote, getUndoRef, getReactRef, getForwardSource } from '../inboundMsgCache.js';

const router = express.Router();

// Map threadType string từ body → ThreadType enum ('Group' → Group, else User).
function mapThreadType(threadType) {
  return threadType === 'Group' ? ThreadType.Group : ThreadType.User;
}

// Lookup + guard session (giống send-text). Trả { session } hoặc gửi lỗi qua res.
function resolveSession(res, tag, accountId) {
  const session = getSessionByAccountId(accountId);
  if (!session) {
    const active = listSessions();
    console.warn(`[${tag}] 404 — session not found for accountId=${accountId}`);
    console.warn(`[${tag}] active sessions: [${active.map(s => `${s.accountId}(${s.status})`).join(', ') || 'none'}]`);
    res.status(404).json({ error: 'Session not found or not logged in' });
    return null;
  }
  if (session.status !== 'confirmed') {
    console.warn(`[${tag}] 404 — session status=${session.status} (not confirmed) for accountId=${accountId}`);
    res.status(404).json({ error: 'Session not found or not logged in' });
    return null;
  }
  if (!session.api) {
    console.warn(`[${tag}] 503 — api not ready for accountId=${accountId}`);
    res.status(503).json({ error: 'API not ready yet — login still in progress' });
    return null;
  }
  return session;
}

// Suy đuôi file từ content-type thật của response (khi fileName không có đuôi rõ).
// zca-js chọn nhánh xử lý attachment THEO ĐUÔI FILE (getFileExtension): jpg/jpeg/png/webp
// mới được coi là ảnh gửi kèm caption; gif đi nhánh riêng. Nếu ảnh png/webp bị lưu .jpg,
// image-size + Zalo có thể xử lý sai → phải map đúng đuôi theo content-type.
function extFromContentType(contentType) {
  if (!contentType) return '';
  const ct = contentType.split(';')[0].trim().toLowerCase();
  const map = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'application/pdf': '.pdf',
  };
  return map[ct] ?? '';
}

// Chờ ms mili-giây (backoff giữa các lần retry).
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Timeout mặc định cho 1 lời gọi zca-js (ms). Text/react/undo nhanh; media phải tải + upload.
const ZCA_TIMEOUT_TEXT_MS  = 15000;
const ZCA_TIMEOUT_MEDIA_MS = 20000;

// Đánh dấu lỗi timeout để route trả 504 (upstream coi 5xx là TRANSIENT → ghi outbox + retry backoff)
// thay vì 500 chung chung.
class ZcaTimeoutError extends Error {
  constructor(tag, ms) {
    super(`${tag}: quá thời gian chờ ${ms}ms từ Zalo`);
    this.isTimeout = true;
  }
}

// Bọc 1 promise với deadline. zca-js KHÔNG có timeout nội bộ: khi phiên Zalo hỏng hoặc WebSocket
// đứt, sendMessage có thể treo vô hạn → request HTTP của upstream treo theo → app (receiveTimeout 30s)
// huỷ trước, tin kẹt trạng thái Sending và KHÔNG đi vào đường outbox/retry. Luôn phải có deadline.
function withTimeout(promise, tag, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ZcaTimeoutError(tag, ms)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Trả lỗi cho client: timeout → 504 (retry được), còn lại → 500.
function sendZcaError(res, tag, err, context) {
  const status = err?.isTimeout ? 504 : 500;
  console.error(`[${tag}] ${status} — ${context}:`, err?.message);
  res.status(status).json({ error: err?.message ?? 'unknown error' });
}

// Bọc 1 async fn với retry cho lỗi TRANSIENT (mạng/tải/upload chập chờn).
// Chỉ retry tối đa `attempts` lần với backoff ngắn tăng dần. Lỗi ở lần cuối được ném ra.
async function withRetry(fn, tag, attempts = 3, timeoutMs = ZCA_TIMEOUT_MEDIA_MS) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await withTimeout(Promise.resolve().then(fn), tag, timeoutMs);
    } catch (err) {
      // Timeout = phiên Zalo/mạng đang treo, thử lại ngay cũng treo tiếp và ăn thêm nguyên
      // một deadline nữa → ném luôn để route trả 504, upstream ghi outbox retry với backoff.
      if (err?.isTimeout) throw err;
      lastErr = err;
      if (i < attempts) {
        console.warn(`[${tag}] attempt ${i}/${attempts} failed: ${err?.message} — retrying...`);
        await delay(300 * i);
      }
    }
  }
  throw lastErr;
}

// Tải fileUrl về file tạm trong os.tmpdir(). Trả { tmpPath, contentType }.
// zca-js sendMessage attachment cần ĐƯỜNG DẪN FILE LOCAL (string) — nó fs.readFile(source).
// Có retry cho lỗi tải chập chờn (fetch fail / HTTP 5xx).
async function downloadToTmp(fileUrl, fileName, tag = 'download') {
  return withRetry(async () => {
    const resp = await fetch(fileUrl);
    if (!resp.ok) {
      // 4xx = presigned URL sai/hết hạn → không đáng retry; ném rõ để nhìn thấy nguyên nhân.
      throw new Error(`Failed to download file (HTTP ${resp.status})`);
    }
    const arrayBuf = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    const contentType = resp.headers.get('content-type') ?? '';

    // Đặt tên file tạm — giữ đuôi để zca-js suy loại attachment đúng.
    // Ưu tiên đuôi từ fileName, rồi URL path, cuối cùng suy từ content-type thật.
    let ext =
      path.extname(fileName ?? '') ||
      path.extname(new URL(fileUrl).pathname) ||
      extFromContentType(contentType);
    if (!ext) ext = '.bin';
    const tmpPath = path.join(os.tmpdir(), `zca_${crypto.randomUUID()}${ext}`);
    await fs.writeFile(tmpPath, buffer);
    return { tmpPath, contentType };
  }, tag);
}

// Map mentions từ body ({uid, offset, length}) → shape zca-js ({uid, pos, len}).
// zca-js Mention public shape = { pos, uid, len }; thư viện tự set `type` internally
// (uid==='-1' ? 1 : 0) nên KHÔNG cần truyền type. Chỉ giữ entry hợp lệ (uid + length > 0).
// Lưu ý: mentions chỉ có hiệu lực với ThreadType.Group (nhóm) — thư viện bỏ qua với User.
// Chuẩn hoá message lỗi từ zca-js/tải file thành thông điệp RÕ để upstream/FE hiển thị.
// Đặc biệt: lỗi vượt giới hạn dung lượng của Zalo → câu tiếng Việt dễ hiểu.
function humanizeSendError(err) {
  const msg = err?.message ?? 'Unknown error';
  const m = /size exceed maximum size of (\d+)\s*MB/i.exec(msg);
  if (m) {
    return `Ảnh/tệp vượt giới hạn Zalo (tối đa ${m[1]} MB)`;
  }
  if (/Missing `imageMetadataGetter`/i.test(msg)) {
    return 'Bridge chưa cấu hình đọc metadata ảnh (imageMetadataGetter)';
  }
  if (/extension .* is not allowed/i.test(msg)) {
    return 'Định dạng tệp không được Zalo cho phép';
  }
  return msg;
}

function mapMentions(mentions) {
  if (!Array.isArray(mentions)) return undefined;
  const mapped = mentions
    .filter((m) => m && m.uid && Number(m.length) > 0)
    .map((m) => ({
      uid: String(m.uid),
      pos: Number(m.offset) || 0,
      len: Number(m.length),
    }));
  return mapped.length > 0 ? mapped : undefined;
}

// Map tên reaction (chuỗi) từ upstream → giá trị enum Reactions của zca-js.
// zca-js addReaction(icon, dest): `icon` là chuỗi enum Reactions (vd Reactions.HEART="/-heart");
// hàm tự suy rType/source từ chuỗi này (switch). Chuỗi rỗng / không map / "NONE" → Reactions.NONE
// (""), rơi vào nhánh default rType=-1 => BỎ reaction (unreact). Chấp nhận cả:
//  - key enum:  "HEART","LIKE","HAHA"... (không phân biệt hoa/thường)
//  - value enum thô: "/-heart", ":>"... (upstream gửi thẳng ký hiệu Zalo)
// Trả chuỗi Reactions hợp lệ (có thể là "" cho unreact) hoặc null nếu icon không hợp lệ kiểu.
function mapReaction(icon) {
  if (icon == null) return Reactions.NONE; // không truyền → coi như unreact
  if (typeof icon !== 'string') return null;
  const raw = icon.trim();
  if (raw === '' || raw.toUpperCase() === 'NONE') return Reactions.NONE;
  // 1) khớp theo KEY enum (HEART, LIKE, ...)
  const key = raw.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(Reactions, key)) return Reactions[key];
  // 2) khớp theo VALUE enum thô (upstream gửi thẳng "/-heart")
  const values = Object.values(Reactions);
  if (values.includes(raw)) return raw;
  return null; // không nhận diện được
}

// POST /messages/send-text
router.post('/send-text', async (req, res) => {
  const { accountId, recipientId, content, threadType = 'User', mentions, quoteMsgId } = req.body;

  console.log(`[send-text] accountId=${accountId} recipientId=${recipientId} threadType=${threadType} contentLen=${content?.length ?? 0} mentions=${Array.isArray(mentions) ? mentions.length : 0} quoteMsgId=${quoteMsgId ?? '-'}`);

  if (!accountId || !recipientId || !content) {
    console.warn('[send-text] 400 — missing required fields');
    return res.status(400).json({ error: 'accountId, recipientId, content required' });
  }

  const session = resolveSession(res, 'send-text', accountId);
  if (!session) return;

  const mappedThreadType = mapThreadType(threadType);
  const mappedMentions = mapMentions(mentions);

  try {
    console.log(`[send-text] sending to recipientId=${recipientId}...`);
    const messagePayload = { msg: content };
    if (mappedMentions) messagePayload.mentions = mappedMentions;
    // Reply/trích dẫn: nếu upstream gửi quoteMsgId → tra tin gốc trong cache để dựng quote.
    // Cache miss (tin cũ / bridge đã restart) → gửi KHÔNG quote (graceful, không lỗi).
    if (quoteMsgId != null && quoteMsgId !== '') {
      const quote = getInboundQuote(quoteMsgId);
      if (quote) {
        messagePayload.quote = quote;
        console.log(`[send-text] quote hit — quoteMsgId=${quoteMsgId}`);
      } else {
        console.warn(`[send-text] quoteMsgId=${quoteMsgId} not in cache, sending without quote`);
      }
    }
    const result = await withTimeout(
      session.api.sendMessage(messagePayload, recipientId, mappedThreadType),
      'send-text', ZCA_TIMEOUT_TEXT_MS);
    const messageId = result?.message?.msgId ?? `msg_${Date.now()}`;
    console.log(`[send-text] OK — messageId=${messageId}`);
    res.json({ messageId: String(messageId) });
  } catch (err) {
    sendZcaError(res, 'send-text', err, `error sending to ${recipientId}`);
  }
});

// POST /messages/send-image
// body { accountId, recipientId, fileUrl, caption?, threadType? }
router.post('/send-image', async (req, res) => {
  const { accountId, recipientId, fileUrl, caption, threadType = 'User' } = req.body;

  console.log(`[send-image] accountId=${accountId} recipientId=${recipientId} threadType=${threadType} fileUrl=${fileUrl?.substring(0, 80)}`);

  if (!accountId || !recipientId || !fileUrl) {
    console.warn('[send-image] 400 — missing required fields');
    return res.status(400).json({ error: 'accountId, recipientId, fileUrl required' });
  }

  const session = resolveSession(res, 'send-image', accountId);
  if (!session) return;

  const mappedThreadType = mapThreadType(threadType);
  let tmpPath = null;
  try {
    // fileName không truyền → đuôi suy từ URL path hoặc content-type thật (png/webp/gif...).
    const dl = await downloadToTmp(fileUrl, null, 'send-image');
    tmpPath = dl.tmpPath;
    console.log(`[send-image] downloaded → ${tmpPath} (ct=${dl.contentType || '?'}), sending to ${recipientId}...`);
    // Upload/gửi qua Zalo có thể chập chờn mạng → retry ngắn.
    const result = await withRetry(
      () => session.api.sendMessage(
        { msg: caption ?? '', attachments: [tmpPath] },
        recipientId,
        mappedThreadType
      ),
      'send-image-zalo'
    );
    // Ảnh trả msgId ở attachment[]; fallback về message.msgId.
    const messageId = result?.attachment?.[0]?.msgId ?? result?.message?.msgId ?? `msg_${Date.now()}`;
    console.log(`[send-image] OK — messageId=${messageId}`);
    res.json({ messageId: String(messageId) });
  } catch (err) {
    console.error(`[send-image] 500 — error sending to ${recipientId}: ${err?.message}`);
    console.error(err?.stack);
    // Timeout → 504 để upstream phân loại TRANSIENT (ghi outbox + retry), còn lại giữ 500.
    res.status(err?.isTimeout ? 504 : 500).json({ error: humanizeSendError(err), code: err?.name });
  } finally {
    if (tmpPath) {
      try { await fs.unlink(tmpPath); } catch (e) { /* best-effort cleanup */ }
    }
  }
});

// POST /messages/send-file
// body { accountId, recipientId, fileUrl, fileName?, threadType? }
router.post('/send-file', async (req, res) => {
  const { accountId, recipientId, fileUrl, fileName, threadType = 'User' } = req.body;

  console.log(`[send-file] accountId=${accountId} recipientId=${recipientId} threadType=${threadType} fileName=${fileName} fileUrl=${fileUrl?.substring(0, 80)}`);

  if (!accountId || !recipientId || !fileUrl) {
    console.warn('[send-file] 400 — missing required fields');
    return res.status(400).json({ error: 'accountId, recipientId, fileUrl required' });
  }

  const session = resolveSession(res, 'send-file', accountId);
  if (!session) return;

  const mappedThreadType = mapThreadType(threadType);
  let tmpPath = null;
  try {
    const dl = await downloadToTmp(fileUrl, fileName ?? 'file', 'send-file');
    tmpPath = dl.tmpPath;
    console.log(`[send-file] downloaded → ${tmpPath} (ct=${dl.contentType || '?'}), sending to ${recipientId}...`);
    const result = await withRetry(
      () => session.api.sendMessage(
        { msg: '', attachments: [tmpPath] },
        recipientId,
        mappedThreadType
      ),
      'send-file-zalo'
    );
    const messageId = result?.attachment?.[0]?.msgId ?? result?.message?.msgId ?? `msg_${Date.now()}`;
    console.log(`[send-file] OK — messageId=${messageId}`);
    res.json({ messageId: String(messageId) });
  } catch (err) {
    console.error(`[send-file] 500 — error sending to ${recipientId}: ${err?.message}`);
    console.error(err?.stack);
    // Timeout → 504 để upstream phân loại TRANSIENT (ghi outbox + retry), còn lại giữ 500.
    res.status(err?.isTimeout ? 504 : 500).json({ error: humanizeSendError(err), code: err?.name });
  } finally {
    if (tmpPath) {
      try { await fs.unlink(tmpPath); } catch (e) { /* best-effort cleanup */ }
    }
  }
});

// POST /messages/undo — thu hồi (recall) 1 tin MÌNH đã gửi qua Zalo cá nhân.
// body { accountId, msgId, cliMsgId?, threadId | recipientId, threadType? }
// zca-js v2.1.2 signature THẬT:
//   api.undo(payload:{ msgId:string, cliMsgId:string }, threadId:string, type:ThreadType=User)
//   → params { msgId, cliMsgId (as cliMsgIdUndo), clientId, toid|grid }; chỉ recall tin của mình.
// Nguồn { msgId, cliMsgId }: ưu tiên body.cliMsgId (upstream truyền thẳng), fallback cache self-echo
// (getUndoRef). Miss cả hai → 409 (upstream nuốt lỗi, recall nội bộ đã đánh dấu, KHÔNG chặn).
router.post('/undo', async (req, res) => {
  const { accountId, msgId, cliMsgId, threadType = 'User' } = req.body;
  // Chấp nhận cả threadId (mới) lẫn recipientId (cũ) cho tương thích ngược.
  const threadId = req.body.threadId ?? req.body.recipientId;

  console.log(`[undo] accountId=${accountId} msgId=${msgId} cliMsgId=${cliMsgId ?? '-'} threadId=${threadId} threadType=${threadType}`);

  if (!accountId || !msgId || !threadId) {
    console.warn('[undo] 400 — missing required fields');
    return res.status(400).json({ error: 'accountId, msgId, threadId (or recipientId) required' });
  }

  const session = resolveSession(res, 'undo', accountId);
  if (!session) return;

  // Ưu tiên cliMsgId từ body; nếu thiếu → tra cache self-echo.
  let ref = null;
  if (cliMsgId != null && cliMsgId !== '') {
    ref = { msgId: String(msgId), cliMsgId: String(cliMsgId) };
  } else {
    ref = getUndoRef(String(msgId));
  }
  if (!ref) {
    console.warn(`[undo] 409 — msgId=${msgId} not undoable (no cliMsgId in body nor cache)`);
    return res.status(409).json({ error: 'message not undoable (missing cliMsgId)' });
  }

  try {
    console.log(`[undo] recalling msgId=${ref.msgId} cliMsgId=${ref.cliMsgId} → threadId=${threadId}...`);
    await session.api.undo(
      { msgId: ref.msgId, cliMsgId: ref.cliMsgId },
      String(threadId),
      mapThreadType(threadType)
    );
    console.log(`[undo] OK — msgId=${ref.msgId}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[undo] 500 — error recalling msgId=${msgId}:`, err?.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /messages/react — thả (hoặc bỏ) reaction lên 1 tin qua Zalo cá nhân.
// body { accountId, threadId, threadType?, msgId, cliMsgId?, icon }
// zca-js v2.1.2 signature THẬT:
//   api.addReaction(icon: Reactions | { rType, source, icon }, dest: {
//       data: { msgId: string, cliMsgId: string }, threadId: string, type: ThreadType })
//   → AddReactionResponse { msgIds: number[] }.
//   `icon` chuỗi enum Reactions ("/-heart"...) tự suy rType/source; Reactions.NONE("") ⇒ default
//   rType=-1 ⇒ BỎ reaction (unreact). dest.data cần cả msgId + cliMsgId (parseInt trong lib).
// Nguồn cliMsgId: ưu tiên body.cliMsgId, fallback cache (getReactRef). Thiếu cliMsgId → 409.
router.post('/react', async (req, res) => {
  const { accountId, threadId, threadType = 'User', msgId, cliMsgId, icon } = req.body;

  console.log(`[react] accountId=${accountId} threadId=${threadId} threadType=${threadType} msgId=${msgId} cliMsgId=${cliMsgId ?? '-'} icon=${icon ?? '(none)'}`);

  if (!accountId || !threadId || !msgId) {
    console.warn('[react] 400 — missing required fields');
    return res.status(400).json({ error: 'accountId, threadId, msgId required' });
  }

  // Map icon → enum Reactions. "" / "NONE" / không truyền ⇒ unreact (Reactions.NONE).
  const mappedIcon = mapReaction(icon);
  if (mappedIcon == null) {
    console.warn(`[react] 400 — unknown icon=${icon}`);
    return res.status(400).json({ error: `unknown reaction icon: ${icon}` });
  }

  const session = resolveSession(res, 'react', accountId);
  if (!session) return;

  // dest.data cần { msgId, cliMsgId }. Ưu tiên body; fallback cache self-echo/inbound.
  let dataRef = null;
  if (cliMsgId != null && cliMsgId !== '') {
    dataRef = { msgId: String(msgId), cliMsgId: String(cliMsgId) };
  } else {
    dataRef = getReactRef(String(msgId));
  }
  if (!dataRef) {
    console.warn(`[react] 409 — msgId=${msgId} missing cliMsgId (not in body nor cache)`);
    return res.status(409).json({ error: 'cannot react (missing cliMsgId)' });
  }

  try {
    const isUnreact = mappedIcon === Reactions.NONE;
    console.log(`[react] ${isUnreact ? 'un-reacting' : 'reacting'} msgId=${dataRef.msgId} → threadId=${threadId}...`);
    const result = await session.api.addReaction(mappedIcon, {
      data: { msgId: dataRef.msgId, cliMsgId: dataRef.cliMsgId },
      threadId: String(threadId),
      type: mapThreadType(threadType),
    });
    // Response { msgIds: number[] } — lấy phần tử đầu làm messageId (best-effort).
    const messageId = Array.isArray(result?.msgIds) && result.msgIds.length > 0
      ? String(result.msgIds[0])
      : undefined;
    console.log(`[react] OK — msgId=${dataRef.msgId} messageId=${messageId ?? '-'}`);
    res.json(messageId ? { ok: true, messageId } : { ok: true });
  } catch (err) {
    console.error(`[react] 500 — error reacting msgId=${msgId}:`, err?.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /messages/forward — chuyển tiếp 1 tin (theo NỘI DUNG text) tới nhiều đích.
// body { accountId, msgId?, content?, targets: [{ threadId, threadType? }], threadType? }
// zca-js v2.1.2 signature THẬT:
//   api.forwardMessage(payload: { message: string, ttl?, reference? }, threadIds: string[],
//       type: ThreadType) → { success: [{clientId,msgId}], fail: [{clientId,error_code}] }.
// LƯU Ý QUAN TRỌNG:
//  • forwardMessage NATIVE chỉ nhận `payload.message` là CHUỖI TEXT — KHÔNG nhận msgId nguồn,
//    KHÔNG forward attachment/ảnh. Mọi threadIds trong 1 lần gọi phải CÙNG một `type`.
//  • Vì vậy ta chọn FORWARD-NATIVE cho nội dung TEXT: gom targets theo threadType rồi gọi
//    forwardMessage 1 lần / nhóm type. `message` lấy từ body.content, nếu thiếu thì suy từ
//    cache tin gốc (getForwardSource) theo msgId.
//  • Nếu KHÔNG có nội dung text (tin gốc là ảnh/file, cache miss) → forward-as-resend KHÔNG khả
//    thi ở đây (không có URL attachment). Trả lỗi rõ; upstream nên dùng /send-image|/send-file để
//    resend attachment. TODO forward-native attachment khi zca-js hỗ trợ msgId-based forward.
router.post('/forward', async (req, res) => {
  const { accountId, msgId, content, targets } = req.body;

  console.log(`[forward] accountId=${accountId} msgId=${msgId ?? '-'} contentLen=${content?.length ?? 0} targets=${Array.isArray(targets) ? targets.length : 0}`);

  if (!accountId || !Array.isArray(targets) || targets.length === 0) {
    console.warn('[forward] 400 — missing required fields');
    return res.status(400).json({ error: 'accountId, targets[] required' });
  }

  const session = resolveSession(res, 'forward', accountId);
  if (!session) return;

  // Nội dung text để forward: ưu tiên body.content, fallback cache tin gốc theo msgId.
  let message = typeof content === 'string' && content !== '' ? content : null;
  let refTs;
  if (msgId != null) {
    const src = getForwardSource(String(msgId));
    if (src) {
      if (!message && typeof src.content === 'string') message = src.content;
      refTs = src.ts;
    }
  }
  if (!message) {
    console.warn('[forward] 422 — no text content to forward (attachment forward not supported)');
    return res.status(422).json({
      error: 'no forwardable text content — use /send-image or /send-file to resend attachments',
    });
  }

  // Chuẩn hoá targets → [{ threadId, type }], bỏ entry thiếu threadId.
  const normTargets = targets
    .filter((t) => t && (t.threadId != null && t.threadId !== ''))
    .map((t) => ({ threadId: String(t.threadId), type: mapThreadType(t.threadType ?? 'User') }));
  if (normTargets.length === 0) {
    console.warn('[forward] 400 — no valid targets');
    return res.status(400).json({ error: 'no valid targets (threadId required per target)' });
  }

  // Gom theo type: forwardMessage yêu cầu tất cả threadIds cùng 1 type / lần gọi.
  const byType = new Map(); // type → [threadId]
  for (const t of normTargets) {
    if (!byType.has(t.type)) byType.set(t.type, []);
    byType.get(t.type).push(t.threadId);
  }

  // reference (decorLog) tuỳ chọn: chỉ set khi có đủ ts từ cache tin gốc.
  const payload = { message };
  if (refTs != null && msgId != null) {
    payload.reference = { id: String(msgId), ts: refTs, logSrcType: 1, fwLvl: 1 };
  }

  const results = [];
  for (const [type, threadIds] of byType.entries()) {
    try {
      const resp = await session.api.forwardMessage(payload, threadIds, type);
      // resp.success/fail có clientId nhưng KHÔNG map lại threadId → khớp theo thứ tự gọi:
      // gán msgId thành công theo index, còn lại đánh dấu fail.
      const success = Array.isArray(resp?.success) ? resp.success : [];
      const fail = Array.isArray(resp?.fail) ? resp.fail : [];
      threadIds.forEach((threadId, i) => {
        if (i < success.length) {
          results.push({ threadId, messageId: String(success[i].msgId), ok: true });
        } else {
          const f = fail[i - success.length];
          results.push({ threadId, ok: false, error: f?.error_code ?? 'forward failed' });
        }
      });
    } catch (err) {
      console.error(`[forward] error forwarding to type=${type}:`, err?.message);
      threadIds.forEach((threadId) => {
        results.push({ threadId, ok: false, error: err?.message ?? 'forward failed' });
      });
    }
  }

  const anyOk = results.some((r) => r.ok);
  console.log(`[forward] done — ${results.filter((r) => r.ok).length}/${results.length} ok`);
  res.status(anyOk ? 200 : 500).json({ ok: anyOk, results });
});

// POST /messages/send-typing — báo "đang soạn tin" cho khách (Zalo cá nhân).
// body { accountId, threadId, threadType? }
// zca-js v2.1.2: api.sendTypingEvent(threadId, type) — type là ThreadType enum (0=User,1=Group).
// Best-effort: lỗi → 200 {ok:false,reason} (không chặn luồng chat).
router.post('/send-typing', async (req, res) => {
  const { accountId, threadId, threadType = 'User' } = req.body;

  console.log(`[send-typing] accountId=${accountId} threadId=${threadId} threadType=${threadType}`);

  if (!accountId || !threadId) {
    console.warn('[send-typing] 400 — missing required fields');
    return res.status(400).json({ error: 'accountId, threadId required' });
  }

  const session = resolveSession(res, 'send-typing', accountId);
  if (!session) return;

  try {
    await session.api.sendTypingEvent(String(threadId), mapThreadType(threadType));
    res.json({ ok: true });
  } catch (err) {
    console.error(`[send-typing] error for threadId=${threadId}:`, err?.message);
    res.status(200).json({ ok: false, reason: err?.message ?? 'send-typing failed' });
  }
});

// POST /messages/send-seen — báo "đã xem/đã nhận" các tin của khách (Zalo cá nhân).
// body { accountId, threadId, threadType?, msgIds? }
// zca-js v2.1.2: api.sendDeliveredEvent(isSeen, messages, type). `messages` là object/array với
// shape đầy đủ { msgId, cliMsgId, uidFrom, idTo, msgType, st, at, cmd, ts }. upstream thường chỉ có
// msgIds → dựng object tối thiểu (cliMsgId/msgType để rỗng, idTo=threadId). Nếu thiếu msgIds hoặc
// thư viện từ chối → best-effort trả 200 {ok:false,reason}.
router.post('/send-seen', async (req, res) => {
  const { accountId, threadId, threadType = 'User', msgIds } = req.body;

  console.log(`[send-seen] accountId=${accountId} threadId=${threadId} threadType=${threadType} msgIds=${Array.isArray(msgIds) ? msgIds.length : 0}`);

  if (!accountId || !threadId) {
    console.warn('[send-seen] 400 — missing required fields');
    return res.status(400).json({ error: 'accountId, threadId required' });
  }

  const session = resolveSession(res, 'send-seen', accountId);
  if (!session) return;

  const ids = Array.isArray(msgIds) ? msgIds.filter((m) => m != null && m !== '') : [];
  if (ids.length === 0) {
    console.warn('[send-seen] no msgIds — nothing to mark seen');
    return res.status(200).json({ ok: false, reason: 'no msgIds provided' });
  }

  // Dựng message param tối thiểu cho từng msgId. cliMsgId không có từ upstream → dùng chính msgId
  // (thư viện chỉ dùng để build payload). idTo = threadId (tin của khách gửi tới mình).
  const messages = ids.map((id) => ({
    msgId: String(id),
    cliMsgId: String(id),
    uidFrom: String(threadId),
    idTo: String(threadId),
    msgType: 'webchat',
    st: 0,
    at: 0,
    cmd: 0,
    ts: Date.now(),
  }));

  try {
    await session.api.sendDeliveredEvent(true, messages, mapThreadType(threadType));
    res.json({ ok: true });
  } catch (err) {
    console.error(`[send-seen] error for threadId=${threadId}:`, err?.message);
    res.status(200).json({ ok: false, reason: err?.message ?? 'send-seen failed' });
  }
});

// POST /messages/send-sticker — gửi 1 sticker qua Zalo cá nhân.
// body { accountId, threadId, threadType?, stickerId, cateId, type }
// zca-js v2.1.2 signature THẬT (node_modules/zca-js/dist/apis/sendSticker.js):
//   api.sendSticker(sticker: { id: number, cateId: number, type: number },
//       threadId: string, type: ThreadType = User) -> { msgId: number }.
//   Lib CHẶN cứng: thiếu id / cateId (kể cả null/undefined) / type -> ném "Missing ...".
//   → cả 3 field (id, cateId, type) BẮT BUỘC; upstream lấy từ /stickers (getStickersDetail).
// Best-effort retry cho lỗi mạng chập chờn (giống send-image).
router.post('/send-sticker', async (req, res) => {
  const { accountId, threadId, threadType = 'User', stickerId } = req.body;
  let { cateId, type } = req.body;

  console.log(`[send-sticker] accountId=${accountId} threadId=${threadId} threadType=${threadType} stickerId=${stickerId} cateId=${cateId} type=${type}`);

  // Chỉ stickerId bắt buộc — cateId/type có thể thiếu (FE/upstream chỉ gửi stickerId) → tự tra getStickersDetail.
  if (!accountId || !threadId || stickerId == null) {
    console.warn('[send-sticker] 400 — missing required fields');
    return res.status(400).json({ error: 'accountId, threadId, stickerId required' });
  }

  const session = resolveSession(res, 'send-sticker', accountId);
  if (!session) return;

  try {
    // sendSticker CHẶN cứng thiếu id/cateId/type → nếu thiếu cateId/type, tự tra chi tiết sticker.
    if (cateId == null || type == null) {
      const details = await session.api.getStickersDetail([Number(stickerId)]);
      const d = Array.isArray(details)
        ? (details.find((x) => Number(x?.id) === Number(stickerId)) ?? details[0])
        : null;
      if (d) {
        if (cateId == null) cateId = d.cateId;
        if (type == null) type = d.type;
      }
    }
    if (cateId == null || type == null) {
      return res.status(422).json({ error: 'Không lấy được cateId/type cho sticker này', code: 'STICKER_DETAIL_MISSING' });
    }
    const sticker = { id: Number(stickerId), cateId: Number(cateId), type: Number(type) };
    const result = await withRetry(
      () => session.api.sendSticker(sticker, String(threadId), mapThreadType(threadType)),
      'send-sticker-zalo'
    );
    const messageId = result?.msgId != null ? String(result.msgId) : undefined;
    console.log(`[send-sticker] OK — messageId=${messageId ?? '-'}`);
    res.json(messageId ? { ok: true, messageId } : { ok: true });
  } catch (err) {
    console.error(`[send-sticker] 500 — error for threadId=${threadId}: ${err?.message}`);
    // Timeout → 504 để upstream phân loại TRANSIENT (ghi outbox + retry), còn lại giữ 500.
    res.status(err?.isTimeout ? 504 : 500).json({ error: humanizeSendError(err), code: err?.name });
  }
});

// Từ khoá gợi ý khi picker mở mà agent chưa gõ gì. zca-js KHÔNG có API liệt kê kho sticker
// (chỉ getStickers(keyword)) → cách duy nhất dựng "bộ mặc định" là quét vài từ khoá phổ biến.
const SEED_STICKER_KEYWORDS = ['hi', 'cảm ơn', 'ok', 'haha', 'yêu', 'buồn'];
const SUGGESTED_STICKER_LIMIT = 48;

/**
 * Gom id sticker cho picker lúc chưa có keyword: quét lần lượt SEED_STICKER_KEYWORDS,
 * dedupe, dừng sớm khi đủ SUGGESTED_STICKER_LIMIT. Một keyword lỗi thì bỏ qua, không phá cả bộ.
 */
async function collectSuggestedStickerIds(session) {
  const seen = new Set();
  for (const kw of SEED_STICKER_KEYWORDS) {
    if (seen.size >= SUGGESTED_STICKER_LIMIT) break;
    try {
      const ids = await session.api.getStickers(kw);
      if (Array.isArray(ids)) {
        for (const id of ids) {
          seen.add(id);
          if (seen.size >= SUGGESTED_STICKER_LIMIT) break;
        }
      }
    } catch (err) {
      console.warn(`[stickers] seed keyword "${kw}" failed: ${err?.message}`);
    }
  }
  return [...seen];
}

// GET|POST /stickers?keyword= — tìm sticker theo keyword để FE dựng picker.
// keyword rỗng → bộ gợi ý (quét SEED_STICKER_KEYWORDS).
// zca-js v2.1.2 signature THẬT:
//   api.getStickers(keyword: string) -> number[]  (chỉ trả MẢNG stickerId, không có URL)
//   api.getStickersDetail(ids: number | number[]) -> StickerDetail[]
//     StickerDetail = { id, cateId, type, stickerUrl, stickerWebpUrl, stickerSpriteUrl, ... }.
// getStickers KHÔNG có cateId/URL → phải gọi getStickersDetail để lấy cateId (cần cho
// send-sticker) + stickerUrl (FE render). Trả mảng { id, cateId, type, url }.
// Handler tách riêng để mount ở CẢ /stickers (top-level) lẫn /messages/stickers.
export async function stickersHandler(req, res) {
  // Nhận keyword từ query (GET) hoặc body (POST).
  const keyword = req.query?.keyword ?? req.body?.keyword;
  const accountId = req.query?.accountId ?? req.body?.accountId;

  console.log(`[stickers] accountId=${accountId} keyword=${keyword}`);

  // keyword BẮT BUỘC trước đây → picker vừa mở (chưa gõ gì) luôn rỗng. Giờ keyword rỗng =
  // "gợi ý": quét SEED_STICKER_KEYWORDS để dựng 1 bộ mặc định. accountId vẫn bắt buộc.
  if (!accountId) {
    console.warn('[stickers] 400 — missing accountId');
    return res.status(400).json({ error: 'accountId required' });
  }

  const session = resolveSession(res, 'stickers', accountId);
  if (!session) return;

  try {
    const ids = keyword
      ? await withRetry(() => session.api.getStickers(String(keyword)), 'stickers-search')
      : await collectSuggestedStickerIds(session);
    if (!Array.isArray(ids) || ids.length === 0) {
      console.log('[stickers] no results');
      return res.json({ ok: true, stickers: [] });
    }
    // Lấy chi tiết để có cateId + URL ảnh. getStickersDetail bỏ qua id lỗi (allSettled).
    const details = await withRetry(() => session.api.getStickersDetail(ids), 'stickers-detail');
    const stickers = (Array.isArray(details) ? details : []).map((d) => ({
      id: d.id,
      cateId: d.cateId,
      type: d.type,
      // Ưu tiên webp (động), fallback ảnh tĩnh.
      url: d.stickerWebpUrl ?? d.stickerUrl ?? undefined,
    }));
    console.log(`[stickers] OK — ${stickers.length} stickers`);
    res.json({ ok: true, stickers });
  } catch (err) {
    console.error(`[stickers] 500 — error for keyword=${keyword}: ${err?.message}`);
    res.status(500).json({ error: err.message });
  }
}
router.get('/stickers', stickersHandler);
router.post('/stickers', stickersHandler);

// POST /messages/send-video — gửi video qua Zalo cá nhân.
// body { accountId, threadId, threadType?, fileUrl, thumbUrl?, caption?, duration?, width?, height? }
// zca-js v2.1.2 signature THẬT (node_modules/zca-js/dist/apis/sendVideo.js):
//   api.sendVideo(options: { videoUrl: string, thumbnailUrl: string, msg?, duration?,
//       width?, height?, ttl? }, threadId: string, type: ThreadType = User) -> { msgId: number }.
// CÁCH NHẬN NGUỒN: videoUrl là URL TRỰC TIẾP — lib tự gọi HEAD videoUrl để lấy content-length.
//   → KHÔNG downloadToTmp; truyền THẲNG fileUrl làm videoUrl (URL phải truy cập công khai được).
//   thumbnailUrl bắt buộc trong type nhưng runtime chỉ nhét vào JSON → fallback '' nếu thiếu.
//   width/height mặc định 1280x720 nếu upstream không gửi. Retry transient (HEAD/upload chập chờn).
router.post('/send-video', async (req, res) => {
  const { accountId, threadId, threadType = 'User', fileUrl, thumbUrl, caption, duration, width, height } = req.body;

  console.log(`[send-video] accountId=${accountId} threadId=${threadId} threadType=${threadType} fileUrl=${fileUrl?.substring(0, 80)} thumbUrl=${thumbUrl ? 'yes' : 'no'}`);

  if (!accountId || !threadId || !fileUrl) {
    console.warn('[send-video] 400 — missing required fields');
    return res.status(400).json({ error: 'accountId, threadId, fileUrl required' });
  }

  const session = resolveSession(res, 'send-video', accountId);
  if (!session) return;

  try {
    const options = {
      videoUrl: String(fileUrl),
      thumbnailUrl: thumbUrl ? String(thumbUrl) : '',
    };
    if (caption != null) options.msg = String(caption);
    if (duration != null) options.duration = Number(duration);
    if (width != null) options.width = Number(width);
    if (height != null) options.height = Number(height);
    const result = await withRetry(
      () => session.api.sendVideo(options, String(threadId), mapThreadType(threadType)),
      'send-video-zalo'
    );
    const messageId = result?.msgId != null ? String(result.msgId) : undefined;
    console.log(`[send-video] OK — messageId=${messageId ?? '-'}`);
    res.json(messageId ? { ok: true, messageId } : { ok: true });
  } catch (err) {
    console.error(`[send-video] 500 — error for threadId=${threadId}: ${err?.message}`);
    console.error(err?.stack);
    // Timeout → 504 để upstream phân loại TRANSIENT (ghi outbox + retry), còn lại giữ 500.
    res.status(err?.isTimeout ? 504 : 500).json({ error: humanizeSendError(err), code: err?.name });
  }
});

// POST /messages/send-voice — gửi tin thoại (voice note) qua Zalo cá nhân.
// body { accountId, threadId, threadType?, fileUrl }
// zca-js v2.1.2 signature THẬT (node_modules/zca-js/dist/apis/sendVoice.js):
//   api.sendVoice(options: { voiceUrl: string, ttl? }, threadId: string,
//       type: ThreadType = User) -> { msgId: string }.
// CÁCH NHẬN NGUỒN: voiceUrl là URL TRỰC TIẾP — lib tự gọi HEAD voiceUrl để lấy fileSize.
//   → KHÔNG downloadToTmp; truyền THẲNG fileUrl làm voiceUrl (nên là .m4a, URL công khai).
//   Retry transient (HEAD/upload chập chờn) giống send-image.
router.post('/send-voice', async (req, res) => {
  const { accountId, threadId, threadType = 'User', fileUrl } = req.body;

  console.log(`[send-voice] accountId=${accountId} threadId=${threadId} threadType=${threadType} fileUrl=${fileUrl?.substring(0, 80)}`);

  if (!accountId || !threadId || !fileUrl) {
    console.warn('[send-voice] 400 — missing required fields');
    return res.status(400).json({ error: 'accountId, threadId, fileUrl required' });
  }

  const session = resolveSession(res, 'send-voice', accountId);
  if (!session) return;

  try {
    const result = await withRetry(
      () => session.api.sendVoice({ voiceUrl: String(fileUrl) }, String(threadId), mapThreadType(threadType)),
      'send-voice-zalo'
    );
    const messageId = result?.msgId != null ? String(result.msgId) : undefined;
    console.log(`[send-voice] OK — messageId=${messageId ?? '-'}`);
    res.json(messageId ? { ok: true, messageId } : { ok: true });
  } catch (err) {
    console.error(`[send-voice] 500 — error for threadId=${threadId}: ${err?.message}`);
    console.error(err?.stack);
    // Timeout → 504 để upstream phân loại TRANSIENT (ghi outbox + retry), còn lại giữ 500.
    res.status(err?.isTimeout ? 504 : 500).json({ error: humanizeSendError(err), code: err?.name });
  }
});

export default router;
