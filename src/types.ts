import type { API, Zalo } from 'zca-js';

// ─────────────────────────────────────────────────────────────────────────────
// Ranh giới dữ liệu Zalo
//
// Mọi thứ đi ra từ zca-js được khai `any`/`unknown` TƯỜNG MINH, không phải vì
// lười: Zalo đổi shape payload không báo trước (xem các comment "shape THẬT
// zca-js@2.1.2" rải trong msgContent.ts). Mô hình hoá cứng ở đây sẽ tạo cảm giác
// an toàn giả — code compile xanh trong khi runtime nhận field khác hẳn.
//
// Ranh giới đúng là: `any` khi NHẬN từ Zalo, kiểu chặt khi GỬI đi upstream.
// Vì vậy các *Payload bên dưới (thứ ta tự dựng) đều được khai đầy đủ.
// ─────────────────────────────────────────────────────────────────────────────

/** Payload thô từ zca-js — không tin được shape, luôn phải đọc phòng thủ. */
export type ZaloRaw = any;

/** Tin nhắn từ zca-js. Chỉ khai những field code này thực sự đọc. */
export interface ZaloMessage {
  msgId?: string | number;
  cliMsgId?: string | number;
  threadId?: string | number;
  fromId?: string | number;
  toId?: string | number;
  isSelf?: boolean;
  /** 0 = User, 1 = Group. Có thể vắng ở old_messages. */
  type?: number;
  serverTime?: number;
  content?: unknown;
  data?: ZaloRaw;
}

/** Đối tượng API sau khi ĐÃ đăng nhập — thứ mọi route thao tác. */
export type ZaloApi = API;

/**
 * Client zca-js TRƯỚC khi đăng nhập xong (kết quả `new Zalo(...)`).
 *
 * Khác `ZaloApi`: chưa có `listener`, chưa gửi tin được. Bản JS cũ nhét nó vào cùng
 * field `api` rồi ghi đè bằng API thật sau khi login — nên trong khoảng giữa, `session.api`
 * mang một đối tượng KHÔNG có method nào mà call site trông đợi. Tách field cho rõ.
 */
export type ZaloClient = Zalo;

// ── Nội dung tin đã bóc tách ────────────────────────────────────────────────

export type AttachmentType = 'image' | 'file' | 'video' | 'audio';

export interface Attachment {
  type: AttachmentType;
  url: string;
  fileName: string;
  mimeType: string;
}

/** Trích dẫn / trả lời. Các field này nằm PHẲNG trong payload webhook. */
export interface Quote {
  replyToMsgId: string;
  replyToSnippet: string | null;
  replyToSenderName: string | null;
}

export interface Mention {
  uid: string;
  offset: number;
  length: number;
  name?: string;
}

export interface ContactCard {
  name: string | null;
  phone: string | null;
  avatarUrl?: string | null;
}

export interface GeoLocation {
  lat: number | null;
  lng: number | null;
  address?: string | null;
}

export interface ParsedContent {
  content: string;
  attachments: Attachment[];
  contactCard?: ContactCard;
  location?: GeoLocation;
}

// ── Nhóm ────────────────────────────────────────────────────────────────────

export interface GroupFields {
  name: string | null;
  avatar: string | null;
  memberCount: number | null;
}

export interface GroupMember {
  uid: string;
  name: string | null;
  avatar: string | null;
}

export interface GroupSummary {
  groupId: string;
  name: string | null;
  avatar: string | null;
  memberCount: number | null;
}

// ── Hồ sơ người dùng ────────────────────────────────────────────────────────

export interface UserProfile {
  displayName: string | null;
  avatarUrl: string | null;
}

// ── Phiên ───────────────────────────────────────────────────────────────────

export type SessionStatus = 'waiting' | 'confirmed' | 'expired' | 'failed' | 'error';

export interface SessionRecord {
  /** Chỉ có sau khi đăng nhập xong (status = 'confirmed'). */
  api: ZaloApi | null;
  /** Client trước đăng nhập — giữ để không rơi vào GC, KHÔNG gọi API qua nó. */
  client: ZaloClient | null;
  tempAccountId: string | null;
  status: SessionStatus;
  accountId: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  cookiesEncrypted: string | null;
  createdAt: number;
  imei?: string | null;
  userAgent?: string | null;
  phone?: string | null;
  // Trạng thái WebSocket — xem markWsState
  wsAlive: boolean;
  lastEventAt: number | null;
  lastConnectedAt: number | null;
  lastClosedAt: number | null;
  lastCloseCode: number | null;
  lastCloseReason: string | null;
}

export interface WsState {
  wsAlive?: boolean;
  lastEventAt?: number;
  lastConnectedAt?: number;
  lastClosedAt?: number;
  lastCloseCode?: number | null;
  lastCloseReason?: string | null;
}

export interface SessionSummary {
  accountId: string | null;
  status: SessionStatus;
  displayName: string | null;
}

/**
 * Một phiên do upstream trả về để khôi phục.
 * Khớp chính xác `ZaloPersonalSessionDto` mà NextX Comm trả ở
 * `GET /api/v1/comm/channels/zalo-personal/internal/sessions`.
 */
export interface UpstreamSession {
  externalId: string;
  displayName: string;
  cookiesBase64: string;
  imei?: string | null;
  userAgent?: string | null;
}

// ── Payload đẩy về upstream (ta tự dựng ⇒ khai chặt) ────────────────────────

export type Direction = 'In' | 'Out';

/** Tin đến — POST vào đường gốc của webhook. */
export interface InboundPayload {
  accountId: string;
  /** Chat 1-1: userId đối phương. Chat NHÓM: groupId (KHÔNG phải người gửi). */
  senderId: string;
  content: string;
  attachments: Attachment[];
  msgId: string;
  direction: Direction;
  timestamp: number;
  senderName?: string | null;
  senderAvatar?: string | null;
  threadType?: 'Group';
  /** Chỉ có ở tin nhóm — người thật sự gửi. */
  memberSenderId?: string;
  memberSenderName?: string | null;
  memberSenderAvatar?: string | null;
  replyToMsgId?: string;
  replyToSnippet?: string | null;
  replyToSenderName?: string | null;
  mentions?: Mention[];
  contactCard?: ContactCard;
  location?: GeoLocation;
}

export interface ReactionPayload {
  accountId: string;
  threadId: string | number | undefined;
  reactedMsgId: string;
  reactionType: string | undefined;
  reactorId: string | null;
  isSelf: boolean | undefined;
}

export interface RecallPayload {
  accountId: string;
  recalledMsgId: string;
  threadId: string | null;
}

export interface TypingPayload {
  accountId: string;
  threadId: string;
  threadType: number;
  isTyping: boolean;
}

export interface ReceiptPayload {
  accountId: string;
  threadId: string;
  threadType: number;
  kind: 'delivered' | 'seen';
  msgIds: string[];
  ts: number;
}

export interface GroupEventPayload {
  accountId: string;
  groupId: string;
  type: string | null;
  subType: number | null;
  act: string | null;
  actorId: string | null;
  targetIds: string[];
  groupName: string | null;
  isSelf: boolean;
  raw: ZaloRaw;
  timestamp: number;
}

export interface FriendEventPayload {
  accountId: string;
  type: string;
  userId: string | null;
  message?: string;
  isSelf: boolean;
  raw: ZaloRaw;
  timestamp: number;
}

// ── Tiện ích ────────────────────────────────────────────────────────────────

/** Lỗi kèm cờ timeout do withTimeout() ném ra. */
export interface TimeoutFlagged extends Error {
  isTimeout?: boolean;
}
