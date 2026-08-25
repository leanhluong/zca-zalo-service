// Helper trích content + attachments từ message zca-js.
//
// Tin văn bản: msg.data.content là STRING → giữ nguyên làm content, attachments = [].
// Tin media (ảnh/sticker/file/voice/video): msg.data.content là OBJECT
//   { title, href, thumb, ... , type } → phát hiện url → trả attachments,
//   content để '' (upstream tự tạo attachment từ mảng attachments).
//
// Upstream nhận payload.attachments = [{ type, url, fileName, mimeType }].

import type {
  Attachment,
  AttachmentType,
  ContactCard,
  GeoLocation,
  Mention,
  ParsedContent,
  Quote,
  ZaloMessage,
  ZaloRaw,
} from './types.js';

/** Kết quả bóc nhật ký cuộc gọi — xem extractCallInfo. */
interface CallInfo {
  isCall: boolean;
  video: boolean | null;
  seconds: number | null;
  missed: boolean | null;
}

/** Sản phẩm được share qua catalog Zalo — xem extractSharedProduct. */
interface SharedProduct {
  name: string | null;
  link: string | null;
  thumb: string | null;
  price: string | null;
}

// Suy mimeType từ đuôi tên file (best-effort).
function mimeFromFileName(fileName: unknown): string {
  const ext = String(fileName ?? '').split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp',
    mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo', mkv: 'video/x-matroska',
    m4a: 'audio/mp4', mp3: 'audio/mpeg', aac: 'audio/aac', ogg: 'audio/ogg', wav: 'audio/wav',
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    zip: 'application/zip', rar: 'application/vnd.rar', txt: 'text/plain', csv: 'text/csv',
  };
  return map[ext] ?? 'application/octet-stream';
}

// CDN ảnh sticker Zalo — CÔNG KHAI, không cần cookie/token, có `access-control-allow-origin: *`
// nên FE load thẳng được. Đây đúng là URL mà `api.getStickersDetail(id)` trả về ở field
// `stickerUrl`, nên dựng chuỗi từ `id` thay vì gọi API: giữ parser THUẦN + ĐỒNG BỘ (cả 3 đường
// ingest — live listener, session restore, /sync — dùng chung hàm này).
const STICKER_CDN_URL = 'https://zalo-api.zadn.vn/api/emoticon/sticker/webpc';
function stickerImageUrl(stickerId: string | number): string {
  return `${STICKER_CDN_URL}?eid=${stickerId}`;
}

// Map msgType của zca-js → { type, fileName, mimeType } mặc định cho media.
// type ∈ image | file | audio | video.
function mediaMetaFromMsgType(msgType: string, raw: ZaloRaw): { type: AttachmentType; fileName: string; mimeType: string } {
  switch (msgType) {
    case 'chat.photo':
    case 'chat.photo.reply':
      return { type: 'image', fileName: 'photo.jpg', mimeType: 'image/jpeg' };
    case 'chat.sticker':
      return { type: 'image', fileName: 'sticker.webp', mimeType: 'image/webp' };
    // Ảnh động gửi từ tab GIF của Zalo. Có `href` (zgif-v2.zdn.vn/….gif) nên vào được nhánh
    // media, nhưng thiếu case này thì rơi xuống `default` → type 'file' → upstream suy ra
    // MessageType.File, inbox hiện nút tải về thay vì ảnh động. Zalo gửi `title: ""` nên
    // default còn cho ra fileName rỗng + mime application/octet-stream (đo trên sandbox
    // 2026-08-01: file thật là GIF89a 461×498, dù CDN khai content-type: image/jpeg).
    case 'chat.gif':
      return { type: 'image', fileName: 'animation.gif', mimeType: 'image/gif' };
    case 'share.file': {
      const fileName = raw?.title ?? 'file';
      return { type: 'file', fileName, mimeType: mimeFromFileName(fileName) };
    }
    case 'chat.voice':
      return { type: 'audio', fileName: 'voice.m4a', mimeType: 'audio/mp4' };
    case 'chat.video.msg':
      return { type: 'video', fileName: 'video.mp4', mimeType: 'video/mp4' };
    default:
      // Media không xác định nhưng có url → coi như file.
      return { type: 'file', fileName: raw?.title ?? 'file', mimeType: mimeFromFileName(raw?.title) };
  }
}

// Độ dài tối đa cho snippet tin gốc được quote.
const QUOTE_SNIPPET_MAX = 200;

// Tên handler nội bộ của client Zalo bị nhét vào field `title` của tin "bubble" hệ thống
// (nhật ký cuộc gọi, thông báo…). KHÔNG phải chữ để hiển thị — lọt ra inbox là lộ kỹ thuật
// ("[Danh thiếp] sendBubbleMessage" mà khách đã gặp).
const ZALO_INTERNAL_LABELS = new Set(['sendbubblemessage', 'sendbubble', 'recommened', 'recommended']);
function isZaloInternalLabel(v: unknown): boolean {
  return typeof v === 'string' && ZALO_INTERNAL_LABELS.has(v.trim().toLowerCase());
}

/**
 * Trích DANH THIẾP (contact card) từ content object của tin zca-js.
 *
 * Shape THẬT (npm pack zca-js@2.1.2):
 *   - msg.data.msgType === 'chat.recommended'  (utils.js getClientMessageType → 38)
 *   - Content object KHÔNG được lib parse; field name suy từ send-side sendCard.js
 *     (msgInfo = { contactUid, qrCodeUrl, phone }) + log thực tế:
 *       { "phone": "0389754831", "caption": "...", "qrCodeUrl": "...",
 *         "action": "recommened.user" }   (typo "recommened" là của Zalo)
 *   Các field khả dĩ: name/caption/title (tên), phone, qrCodeUrl, avatar/thumb.
 *
 * Best-effort: cần ÍT NHẤT name hoặc phone mới coi là danh thiếp hợp lệ.
 *
 * @returns {{ name: string|null, phone: string|null, avatarUrl?: string } | null}
 */
function extractContactCard(raw: ZaloRaw): ContactCard | null {
  if (!raw || typeof raw !== 'object') return null;

  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 && !isZaloInternalLabel(v) ? v : null;

  const name = str(raw.name) ?? str(raw.caption) ?? str(raw.title) ?? str(raw.dName) ?? null;
  const phone = str(raw.phone) ?? str(raw.phoneNumber) ?? str(raw.number) ?? null;
  const avatarUrl = str(raw.avatar) ?? str(raw.avatarUrl) ?? str(raw.thumb) ?? str(raw.qrCodeUrl) ?? null;

  // Không có định danh nào → không phải danh thiếp mình hiểu được.
  if (!name && !phone) return null;

  const card: ContactCard = { name, phone };
  if (avatarUrl) card.avatarUrl = avatarUrl;
  return card;
}

/**
 * NHẬT KÝ CUỘC GỌI (call log) — tin "bubble" hệ thống của Zalo.
 *
 * Zalo nhét cả cuộc gọi lẫn danh thiếp vào CÙNG msgType `chat.recommended`. Tin cuộc gọi
 * KHÔNG có phone/qrCodeUrl mà mang `title: "sendBubbleMessage"` (tên handler phía client
 * Zalo, không phải tiêu đề hiển thị) + `params` là CHUỖI JSON chứa metadata cuộc gọi.
 * Trước đây `extractContactCard` vơ luôn `title` làm tên → inbox hiện
 * "[Danh thiếp] sendBubbleMessage", agent không biết cuộc gọi thành công hay nhỡ.
 *
 * Zalo KHÔNG công bố schema `params` và tên field đổi giữa các bản client, nên hàm này
 * dò theo NHIỀU alias và chỉ khẳng định điều gì khi thật sự đọc được:
 *   - đọc được thời lượng > 0        → cuộc gọi có kết nối, kèm thời lượng
 *   - thời lượng = 0 / status "miss" → cuộc gọi nhỡ (gọi đến) hoặc không trả lời (gọi đi)
 *   - không đọc được gì             → chỉ "[Cuộc gọi]", KHÔNG đoán bừa nhỡ/thành công
 *
 * @returns {{ isCall: boolean, video: boolean|null, seconds: number|null, missed: boolean|null }|null}
 */
function extractCallInfo(raw: ZaloRaw): CallInfo | null {
  if (!raw || typeof raw !== 'object') return null;

  // `params` thường là CHUỖI JSON; vài bản trả sẵn object.
  let params = null;
  if (raw.params && typeof raw.params === 'object') params = raw.params;
  else if (typeof raw.params === 'string' && raw.params.trim().startsWith('{')) {
    try { params = JSON.parse(raw.params); } catch { params = null; }
  }

  // Gộp field cấp ngoài + trong params để dò 1 lần (params ưu tiên vì cụ thể hơn).
  const bag = { ...(raw || {}), ...(params || {}) };
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bag)) lower[String(k).toLowerCase()] = v;

  const pick = (...keys: string[]): unknown => {
    for (const k of keys) {
      const v = lower[k];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return null;
  };
  const num = (v: unknown): number | null => {
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  // ── Có phải tin cuộc gọi không? ──
  // Tín hiệu: action/title/params nhắc tới call, hoặc có hẳn key callId/callType.
  const signalText = [raw.action, raw.title, raw.description, typeof raw.params === 'string' ? raw.params : '']
    .filter((v) => typeof v === 'string')
    .join(' ');
  const hasCallKey =
    pick('callid', 'call_id') !== null ||
    pick('calltype', 'call_type') !== null ||
    pick('callstatus', 'call_status') !== null;
  if (!hasCallKey && !/call|cuộc gọi/i.test(signalText)) return null;

  // ── Thời lượng: giây hay mili-giây tuỳ bản → >86400 coi là ms ──
  let seconds = num(pick('duration', 'callduration', 'call_duration', 'talktime', 'talk_time', 'calltime'));
  if (seconds !== null && seconds > 86400) seconds = Math.round(seconds / 1000);
  if (seconds !== null && seconds < 0) seconds = null;

  // ── Thoại hay video ──
  const rawType = pick('calltype', 'call_type', 'isvideo', 'is_video', 'videocall', 'video');
  let video = null;
  if (rawType !== null) {
    const s = String(rawType).toLowerCase();
    if (/video/.test(s) || s === '2' || s === 'true') video = true;
    else if (/voice|audio/.test(s) || s === '1' || s === '0' || s === 'false') video = false;
  }
  if (video === null && /video/i.test(signalText)) video = true;

  // ── Nhỡ / không trả lời ──
  const statusText = String(pick('callstatus', 'call_status', 'status', 'state', 'result', 'reason') ?? '')
    .toLowerCase();
  let missed = null;
  if (/miss|nhỡ|reject|decline|cancel|busy|noanswer|no_answer|timeout/.test(statusText)) missed = true;
  else if (/answer|connect|end|success|finish|complete/.test(statusText)) missed = false;
  if (missed === null && seconds !== null) missed = seconds <= 0;

  return { isCall: true, video, seconds, missed };
}

// "1 phút 5 giây" / "5 giây" / "1 giờ 2 phút" — bỏ đơn vị bằng 0 cho gọn.
function formatCallDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h} giờ`);
  if (m > 0) parts.push(`${m} phút`);
  if (s > 0 || parts.length === 0) parts.push(`${s} giây`);
  return parts.join(' ');
}

/**
 * Dựng chuỗi hiển thị cho nhật ký cuộc gọi.
 * `isSelf = true` → chính tài khoản mình gọi đi (nhỡ = đối phương không bắt máy).
 */
function buildCallContent(info: CallInfo, isSelf: boolean): string {
  const label = info.video === true ? '[Cuộc gọi video]' : info.video === false ? '[Cuộc gọi thoại]' : '[Cuộc gọi]';
  const direction = isSelf ? 'Gọi đi' : 'Gọi đến';

  if (info.missed === true) {
    return `${label} ${isSelf ? 'Gọi đi · không trả lời' : 'Cuộc gọi nhỡ'}`;
  }
  if (info.seconds !== null && info.seconds > 0) {
    // Zalo không nói rõ `duration` là giây hay mili-giây (chỉ quy đổi được khi số quá lớn,
    // xem extractCallInfo). Vùng nhập nhằng còn lại: nếu ra thời lượng phi lý (> 4 giờ) thì
    // KHÔNG in con số sai bét — vẫn khẳng định được điều quan trọng nhất là cuộc gọi có kết nối.
    const shown = info.seconds <= 14400 ? formatCallDuration(info.seconds) : 'đã kết nối';
    return `${label} ${direction} · ${shown}`;
  }
  // Không đọc được thời lượng lẫn trạng thái → chỉ nói có cuộc gọi, không đoán kết quả.
  return `${label} ${direction}`;
}

/**
 * Trích VỊ TRÍ (location) từ content object của tin zca-js.
 *
 * Shape THẬT (npm pack zca-js@2.1.2):
 *   - msg.data.msgType === 'chat.location.new'  (utils.js getClientMessageType → 43)
 *   - Content object KHÔNG được lib parse. Zalo gửi toạ độ; field name không cố định
 *     giữa các version → chấp nhận cả lat/lng và latitude/longitude, address/title/desc.
 *
 * Best-effort: cần lat & lng số hợp lệ mới coi là vị trí.
 *
 * @returns {{ lat: number, lng: number, address?: string } | null}
 */
function extractLocation(raw: ZaloRaw): GeoLocation | null {
  if (!raw || typeof raw !== 'object') return null;

  const num = (v: unknown): number | null => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

  const lat = num(raw.lat) ?? num(raw.latitude);
  const lng = num(raw.lng) ?? num(raw.lon) ?? num(raw.long) ?? num(raw.longitude);
  if (lat == null || lng == null) return null;

  const address = str(raw.address) ?? str(raw.desc) ?? str(raw.title) ?? str(raw.name) ?? null;

  const loc: GeoLocation = { lat, lng };
  if (address) loc.address = address;
  return loc;
}

/**
 * Trích thông tin SẢN PHẨM được share (product/catalog Zalo).
 *
 * zca-js@2.1.2 KHÔNG parse tin share sản phẩm — content về ở dạng thô. Shape gần nhất
 * mà lib định nghĩa là TAttachmentContent (models/Message.d.ts):
 *   { title, description, href, thumb, childnumber, action, params, type }
 *   → `params` là CHUỖI JSON có thể chứa chi tiết sản phẩm nằm sâu.
 * Field sản phẩm (từ models/ProductCatalog.d.ts ProductCatalogItem):
 *   { product_name, price, description, path, product_id, currency_unit,
 *     product_photos[], catalog_id }
 *   → URL sản phẩm build từ path: `https://catalog.zalo.me/${path}`.
 *
 * Vì shape tin ĐẾN không được lib parse (không chắc 100%), hàm quét best-effort cả
 * `raw` lẫn `raw.params` (parse nếu là JSON string) cho: tên, link, ảnh, giá.
 *
 * @returns {{ name: string|null, link: string|null, thumb: string|null, price: string|null } | null}
 */
function extractSharedProduct(raw: ZaloRaw): SharedProduct | null {
  if (!raw || typeof raw !== 'object') return null;

  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);
  const isUrl = (v: unknown): v is string => typeof v === 'string' && /^https?:\/\//i.test(v.trim());
  const urlStr = (v: unknown): string | null => (isUrl(v) ? v.trim() : null);
  const firstPhoto = (v: unknown): string | null =>
    Array.isArray(v) ? (v.map(str).find(Boolean) ?? null) : null;

  // `params` có thể là object hoặc chuỗi JSON → parse để tìm field nằm sâu.
  let params = null;
  if (raw.params && typeof raw.params === 'object') {
    params = raw.params;
  } else if (typeof raw.params === 'string') {
    const t = raw.params.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        params = JSON.parse(t);
      } catch {
        params = null;
      }
    }
  }
  const P = params && typeof params === 'object' ? params : {};

  // Tên sản phẩm — quét cả raw lẫn params.
  const name =
    str(raw.product_name) ?? str(raw.productName) ?? str(raw.name) ??
    str(raw.title) ?? str(raw.caption) ?? str(raw.description) ?? str(raw.desc) ??
    str(P.product_name) ?? str(P.productName) ?? str(P.name) ??
    str(P.title) ?? str(P.caption) ?? str(P.description) ?? str(P.desc) ?? null;

  // Link — href/url/link/action (nếu là URL), hoặc build từ `path` (catalog URL).
  const path = str(raw.path) ?? str(P.path);
  const link =
    urlStr(raw.href) ?? urlStr(raw.url) ?? urlStr(raw.link) ?? urlStr(raw.action) ??
    urlStr(P.href) ?? urlStr(P.url) ?? urlStr(P.link) ?? urlStr(P.action) ??
    (path ? `https://catalog.zalo.me/${path.replace(/^\/+/, '')}` : null);

  // Ảnh sản phẩm — thumb/photo/image hoặc product_photos[0].
  const thumb =
    urlStr(raw.thumb) ?? urlStr(raw.thumbnail) ?? urlStr(raw.photo) ?? urlStr(raw.image) ??
    firstPhoto(raw.product_photos) ??
    urlStr(P.thumb) ?? urlStr(P.thumbnail) ?? urlStr(P.photo) ?? urlStr(P.image) ??
    firstPhoto(P.product_photos) ?? null;

  // Giá — best-effort, chỉ để làm giàu content (kèm đơn vị nếu có).
  const rawPrice = raw.price ?? P.price;
  let price = null;
  if (rawPrice != null && String(rawPrice).trim().length > 0) {
    const unit = str(raw.currency_unit) ?? str(P.currency_unit);
    price = `${String(rawPrice).trim()}${unit ? ' ' + unit : ''}`;
  }

  // Không trích được gì hữu ích → để caller fallback + log.
  if (!name && !link && !thumb) return null;
  return { name, link, thumb, price };
}

/**
 * Trích thông tin REPLY/QUOTE từ message zca-js.
 *
 * Khi khách Reply/Trích dẫn 1 tin cũ, zca-js gắn `msg.data.quote` (type TQuote):
 *   { ownerId: string, cliMsgId: number, globalMsgId: number, cliMsgType: number,
 *     ts: number, msg: string, attach: string, fromD: string, ttl: number }
 *   - globalMsgId → msgId của tin GỐC (khớp msgId bridge từng gửi)
 *   - msg        → text tin gốc
 *   - fromD      → tên người gửi tin gốc
 *
 * Best-effort: nếu shape lệch / thiếu globalMsgId → trả null (không đẩy field rác).
 *
 * @returns {{ replyToMsgId: string, replyToSnippet: string|null, replyToSenderName: string|null } | null}
 */
export function extractQuote(msg: ZaloMessage): Quote | null {
  try {
    const quote = msg?.data?.quote;
    if (!quote || typeof quote !== 'object') return null;

    // globalMsgId là định danh tin gốc — bắt buộc phải có mới khớp được.
    const gid = quote.globalMsgId;
    if (gid == null) return null;
    const replyToMsgId = String(gid);
    if (!replyToMsgId || replyToMsgId === 'undefined' || replyToMsgId === 'null') return null;

    // Text tin gốc — có thể là object (quote 1 media) → best-effort bỏ qua.
    let replyToSnippet: string | null = null;
    if (typeof quote.msg === 'string' && quote.msg.length > 0) {
      replyToSnippet = quote.msg.slice(0, QUOTE_SNIPPET_MAX);
    }

    const replyToSenderName =
      typeof quote.fromD === 'string' && quote.fromD.length > 0 ? quote.fromD : null;

    return { replyToMsgId, replyToSnippet, replyToSenderName };
  } catch {
    // Shape lệch → không được vỡ ingest.
    return null;
  }
}

/**
 * Trích danh sách @mention từ message zca-js.
 *
 * Shape THẬT zca-js@2.1.2 (models/Message.d.ts → TGroupMessage.mentions):
 *   msg.data.mentions = TMention[] | undefined
 *   TMention = { uid: string, pos: number, len: number, type: 0 | 1 }
 *   - pos → offset ký tự bắt đầu mention trong content
 *   - len → độ dài đoạn text mention
 *   Field `name` KHÔNG có sẵn trong mention (chỉ resolve được qua getGroupMembersInfo)
 *   → chỉ set `name` khi thực sự có, còn không thì bỏ field.
 *
 * mentions chỉ xuất hiện ở tin NHÓM, nhưng vẫn đọc best-effort cho mọi nhánh.
 *
 * @returns {Array<{uid: string, offset: number, length: number, name?: string}> | null}
 */
export function extractMentions(msg: ZaloMessage): Mention[] | null {
  try {
    const raw = msg?.data?.mentions;
    if (!Array.isArray(raw) || raw.length === 0) return null;

    const mentions: Mention[] = [];
    for (const m of raw) {
      if (!m || typeof m !== 'object') continue;
      const uid = m.uid != null ? String(m.uid) : null;
      if (!uid) continue;
      const offset = Number(m.pos);
      const length = Number(m.len);
      const entry: Mention = {
        uid,
        offset: Number.isFinite(offset) ? offset : 0,
        length: Number.isFinite(length) ? length : 0,
      };
      // name không có sẵn trong TMention — chỉ set nếu lib/caller nhúng thêm.
      if (typeof m.name === 'string' && m.name.length > 0) entry.name = m.name;
      mentions.push(entry);
    }

    return mentions.length > 0 ? mentions : null;
  } catch {
    // Shape lệch → không được vỡ ingest.
    return null;
  }
}

/**
 * Trích content text + attachments từ message zca-js.
 *
 * Ngoài text + media (ảnh/file/video/voice/sticker), còn nhận diện:
 *   - DANH THIẾP  (msgType 'chat.recommended') → { content: '[Danh thiếp] …', contactCard }
 *   - VỊ TRÍ      (msgType 'chat.location.new') → { content: '[Vị trí] …', location }
 * content luôn là chuỗi người-đọc-được (fallback nếu client không render structured).
 *
 * @returns {{ content: string, attachments: Array<{type,url,fileName,mimeType}>,
 *             contactCard?: {name,phone,avatarUrl?}, location?: {lat,lng,address?} }}
 */
export function parseContentAndAttachments(msg: ZaloMessage): ParsedContent {
  const raw = msg?.data?.content ?? msg?.content;
  const msgType = msg?.data?.msgType;

  // ── Nhật ký cuộc gọi (Zalo dùng CHUNG msgType 'chat.recommended' với danh thiếp) ──
  // Phải xét TRƯỚC danh thiếp: tin cuộc gọi có `title: "sendBubbleMessage"` nên nhánh
  // danh thiếp sẽ vơ nhầm title làm tên người → "[Danh thiếp] sendBubbleMessage".
  if (msgType === 'chat.recommended' && raw && typeof raw === 'object') {
    const callInfo = extractCallInfo(raw);
    if (callInfo) {
      // Zalo không công bố schema `params` → log để đối chiếu shape thật khi có bản client mới.
      // Chỉ là metadata cuộc gọi (id/thời lượng/loại), KHÔNG chứa nội dung tin nhắn.
      console.log(
        '[msgContent] call-log msgType=chat.recommended isSelf=%s parsed=%j',
        Boolean(msg?.isSelf), callInfo,
      );
      return { content: buildCallContent(callInfo, Boolean(msg?.isSelf)), attachments: [] };
    }
  }

  // ── Danh thiếp (contact card) ──
  if (msgType === 'chat.recommended' && raw && typeof raw === 'object') {
    const contactCard = extractContactCard(raw);
    if (contactCard) {
      const label = [contactCard.name, contactCard.phone].filter(Boolean).join(' ');
      return {
        content: `[Danh thiếp]${label ? ' ' + label : ''}`,
        attachments: [],
        contactCard,
      };
    }
    // Shape lệch → rơi xuống xử lý chung bên dưới (không vỡ ingest).
  }

  // ── Vị trí (location) ──
  if (msgType === 'chat.location.new' && raw && typeof raw === 'object') {
    const location = extractLocation(raw);
    if (location) {
      return {
        content: `[Vị trí]${location.address ? ' ' + location.address : ''}`,
        attachments: [],
        location,
      };
    }
    // Shape lệch → rơi xuống xử lý chung bên dưới (không vỡ ingest).
  }

  // Media: content là object (vd { title, href, thumb, type }).
  if (raw && typeof raw === 'object') {
    const url = raw.href ?? raw.thumb ?? null;
    if (url) {
      const meta = mediaMetaFromMsgType(msg?.data?.msgType, raw);
      return {
        content: '',
        attachments: [{
          type: meta.type,
          url: String(url),
          fileName: meta.fileName,
          mimeType: meta.mimeType,
        }],
      };
    }

    // ── Nhãn dán (sticker) ──
    // Payload thật đo trên sandbox (2026-08-01): { id: 1, catId: 0, type: 7 } — KHÔNG có
    // href/thumb nên không vào được nhánh media ở trên, rồi rơi xuống nhánh sản phẩm bên dưới
    // (catId != null bị coi là tín hiệu sản phẩm) → inbox hiện "[Sản phẩm]".
    // Đặt TRƯỚC nhánh sản phẩm để sticker không bao giờ đi qua hasProductSignal nữa.
    //
    // id phải là số nguyên dương — id lệch shape thì rơi tiếp xuống nhãn '[Nhãn dán]' bên dưới
    // thay vì dựng URL rác (bất biến: không nhánh nào được trả content rỗng + 0 attachment).
    const stickerId = raw.id != null ? Number(raw.id) : NaN;
    if (msgType === 'chat.sticker' && Number.isInteger(stickerId) && stickerId > 0) {
      return {
        content: '',
        attachments: [{
          type: 'image',
          url: stickerImageUrl(stickerId),
          // CDN trả PNG hoặc GIF tuỳ sticker (sticker động ra GIF) và không đoán được từ id nếu
          // không gọi API. Khai báo image/png vì client render theo magic bytes chứ không theo
          // mimeType — nhãn này chỉ ảnh hưởng tên file khi người dùng bấm tải về.
          fileName: `sticker-${stickerId}.png`,
          mimeType: 'image/png',
        }],
      };
    }

    // ── Share SẢN PHẨM / catalog Zalo ──
    // Nhận diện qua key sản phẩm (productId/product_name/product_photos…) hoặc action chứa
    // 'product'/'catalog'. Trích tên + link (+ ảnh) để hiện sản phẩm cụ thể thay vì trơ
    // "[Sản phẩm]" (mất tên/link/ảnh). Đặt TRƯỚC nhánh text để tin có `title` vẫn được làm
    // giàu link/ảnh thay vì chỉ hiện mỗi tên.
    //
    // `catId` CỐ Ý không nằm trong danh sách: sticker cũng mang đúng field đó, nên dùng nó làm
    // tín hiệu sản phẩm là nguồn của lỗi trên. Đánh đổi: share sản phẩm CHỈ có mỗi `catId`
    // (nếu dạng đó tồn tại) sẽ tụt xuống nhãn chung — log 'product share unresolved' bên dưới
    // giữ nguyên để theo dõi.
    const hasProductSignal =
      raw.catalogId != null || raw.catalog_id != null ||
      raw.productId != null || raw.product_id != null ||
      raw.product_name != null || raw.product_photos != null || raw.currency_unit != null ||
      (typeof raw.action === 'string' && /product|catalog/i.test(raw.action));
    if (hasProductSignal) {
      const product = extractSharedProduct(raw);
      if (product && (product.name || product.link || product.thumb)) {
        // content luôn là chuỗi người-đọc-được cho notification/preview.
        let desc = product.name ?? '';
        if (product.price) desc = desc ? `${desc} - ${product.price}` : product.price;
        const label = desc ? `[Sản phẩm] ${desc}` : '[Sản phẩm]';
        const content = product.link ? `${label} — ${product.link}` : label;
        // Có ảnh → kèm attachment image để khung chat hiện ảnh (giống nhánh media),
        // vẫn GIỮ content mô tả text ở trên.
        const attachments: Attachment[] = product.thumb
          ? [{ type: 'image', url: String(product.thumb), fileName: 'product.jpg', mimeType: 'image/jpeg' }]
          : [];
        return { content, attachments };
      }
      // Có tín hiệu sản phẩm nhưng KHÔNG trích được gì → log KEYS (không lộ dữ liệu) để
      // refine shape sau, rồi fallback nhãn chung như cũ.
      console.warn(
        '[msgContent] product share unresolved, keys=',
        Object.keys(raw || {}),
        'params=',
        typeof raw?.params,
      );
      return { content: '[Sản phẩm]', attachments: [] };
    }

    // Object nhưng không có url → không phải media/danh thiếp/vị trí ta hiểu.
    // KHÔNG dump JSON thô ra inbox (xấu + lộ dữ liệu). Nhận diện vài loại phổ biến,
    // ưu tiên field text người-đọc-được, còn lại nhãn chung.
    const text = [raw.title, raw.text, raw.description, raw.caption, raw.msg]
      .find((v) => typeof v === 'string' && v.length > 0 && !isZaloInternalLabel(v));
    if (text) return { content: text, attachments: [] };
    // Self-echo media: khi selfListen=true, tin ẢNH/FILE do CHÍNH mình gửi được
    // Zalo phát lại (echo) với content object ở dạng SEND-SIDE — KHÔNG có href/thumb
    // (chỉ có photoId/rawUrl/... nội bộ). Trước đây rơi vào "[Nội dung không hỗ trợ]".
    // Nhận diện theo msgType để gắn nhãn media đúng thay vì báo không hỗ trợ.
    const mediaLabelByType: Record<string, string> = {
      'chat.photo': '[Hình ảnh]',
      'chat.photo.reply': '[Hình ảnh]',
      'chat.sticker': '[Nhãn dán]',
      'chat.voice': '[Tin nhắn thoại]',
      'chat.video.msg': '[Video]',
      'share.file': '[Tệp tin]',
    };
    if (mediaLabelByType[msgType]) {
      return { content: mediaLabelByType[msgType], attachments: [] };
    }
    // Object media có dấu hiệu ảnh (photoId/rawUrl/oriUrl/normalUrl) nhưng msgType lạ.
    if (raw.photoId != null || raw.rawUrl != null || raw.oriUrl != null || raw.normalUrl != null)
      return { content: '[Hình ảnh]', attachments: [] };
    return { content: '[Nội dung không hỗ trợ]', attachments: [] };
  }

  // ── Tin hệ thống / action-list (nhắc hẹn, calendar event, thông báo…) ──
  // Zalo gửi content là CHUỖI JSON, vd:
  //   { "title": "… tạo nhắc hẹn mới … 14:15.", "action": "msginfo.actionlist",
  //     "params": {...}, "actionType": "action.open.calendar.event", ... }
  // KHÔNG dump JSON thô ra inbox — lấy title (đã là câu người-đọc-được) làm content.
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') && trimmed.includes('"action"')) {
      try {
        const obj = JSON.parse(trimmed);
        const text = [obj.title, obj.description].find(
          (v) => typeof v === 'string' && v.length > 0,
        );
        if (text) return { content: text, attachments: [] };
        return { content: '[Thông báo]', attachments: [] };
      } catch {
        // Parse lỗi → rơi xuống fallback text bên dưới (không vỡ ingest).
      }
    }
  }

  // Văn bản / kiểu khác.
  return { content: String(raw ?? ''), attachments: [] };
}
