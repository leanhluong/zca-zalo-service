import crypto from 'crypto';
import { FriendEventType } from 'zca-js';
import { rememberMsgId } from './msgIdCache.js';
import { rememberInboundMsg } from './inboundMsgCache.js';
import { parseContentAndAttachments, extractQuote, extractMentions } from './msgContent.js';
import { logDiag } from './diagLog.js';
import { getGroupInfoCached, listGroupMembers } from './groupInfo.js';
import { extractUserProfile } from './userProfile.js';
import { markWsState, touchSession } from './sessionStore.js';
import { healAccount, cancelHealing } from './sessionHealer.js';

// ─────────────────────────────────────────────────────────────────────────────
// Listener Zalo dùng CHUNG cho cả hai đường vào phiên:
//   * sessionRestore.js — khôi phục từ cookies khi bridge khởi động
//   * routes/sessions.js — vừa quét QR đăng nhập
//
// Trước đây mỗi đường tự chép một bản. Hai bản trôi khác nhau và mỗi bản thiếu một thứ:
//   - đường QR thiếu 5/9 listener (typing, delivered, seen, group_event, friend_event)
//     ⇒ tài khoản vừa quét QR mất trạng thái đang nhập, tick đã nhận/đã xem, sự kiện nhóm và
//       kết bạn — cho tới khi bridge restart mới có (triệu chứng "lúc chạy lúc không");
//   - đường QR thiếu lưới đỡ avatar thành viên nhóm ⇒ cùng một người, tin qua phiên restore thì
//     có avatar, tin qua phiên QR thì senderAvatarUrl=null;
//   - đường restore thiếu getUserInfo fallback cho tin 1-1 ⇒ tên/avatar khách lạ bị rỗng.
// File này là HỢP của cả hai. Thêm listener mới thì chỉ sửa ở đây.
// ─────────────────────────────────────────────────────────────────────────────

const UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL ?? 'http://localhost:5000';
// Đường webhook phía upstream. Để ở env để cắm service này vào hệ thống khác mà KHÔNG phải sửa mã
// — chỉ cần hệ đó expose một endpoint nhận POST cùng payload.
const WEBHOOK_PATH = process.env.UPSTREAM_WEBHOOK_PATH ?? '/api/v1/webhook/zalo-personal';

// Fire-and-forget push về upstream.
// LƯU Ý (nợ kỹ thuật đã biết — F3 trong audit 31/07): không hàng đợi, không retry. Upstream restart /
// deploy / 5xx đúng khoảnh khắc này = MẤT TIN VĨNH VIỄN vì Zalo không gửi lại như webhook
// Facebook/Zalo OA. Khi làm hàng đợi bền thì sửa DUY NHẤT ở hàm này.
async function push(path, accountId, payload, { tag, what, detail }) {
  try {
    const resp = await fetch(`${UPSTREAM_BASE_URL}${WEBHOOK_PATH}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-System-Key': process.env.SYSTEM_KEY ?? '' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      console.error(`[${tag}] ${what} HTTP error: ${resp.status} account=${accountId}`);
    } else {
      console.log(`[${tag}] ${what} OK [${resp.status}] account=${accountId}${detail ? ' ' + detail : ''}`);
    }
  } catch (err) {
    console.error(`[${tag}] ${what} error:`, err?.message);
  }
}

const pushInbound = (tag, accountId, p) =>
  push('', accountId, p, { tag, what: 'pushInbound', detail: `msgId=${p.msgId} from=${p.senderId}` });

const pushReaction = (tag, accountId, p) =>
  push('/reaction', accountId, p, { tag, what: 'pushReaction', detail: `reactedMsg=${p.reactedMsgId} icon=${p.reactionType}` });

const pushRecall = (tag, accountId, p) =>
  push('/recall', accountId, p, { tag, what: 'pushRecall', detail: `recalledMsg=${p.recalledMsgId} thread=${p.threadId}` });

const pushTyping = (tag, accountId, p) =>
  push('/typing', accountId, p, { tag, what: 'pushTyping', detail: `thread=${p.threadId}` });

const pushReceipt = (tag, accountId, p) =>
  push('/receipt', accountId, p, { tag, what: 'pushReceipt', detail: `kind=${p.kind} thread=${p.threadId} msgs=${p.msgIds?.length ?? 0}` });

const pushGroupEvent = (tag, accountId, p) =>
  push('/group-event', accountId, p, { tag, what: 'pushGroupEvent', detail: `group=${p.groupId} type=${p.type}` });

const pushFriendEvent = (tag, accountId, p) =>
  push('/friend-event', accountId, p, { tag, what: 'pushFriendEvent', detail: `type=${p.type} user=${p.userId}` });

/**
 * Đăng ký toàn bộ listener Zalo cho 1 phiên.
 * @param api  đối tượng API của zca-js (đã login)
 * @param accountId  own-id Zalo — khoá định danh phiên phía upstream
 * @param tag  nhãn log để phân biệt nguồn phiên: 'restore' (khôi phục) | 'qr' (vừa quét QR)
 */
export function registerListener(api, accountId, { tag = 'zp' } = {}) {
  const log = `${tag}-listener`;
  try {
    // ── Vòng đời WebSocket ────────────────────────────────────────────────────
    // PHẢI đăng ký TRƯỚC start(): start() mở WebSocket ngay, sự kiện 'connected' có thể bắn
    // trước khi dòng dưới chạy nếu đảo thứ tự.
    //
    // zca-js phát 3 sự kiện: 'connected' (mở), 'disconnected' (đóng — LUÔN bắn), 'closed'
    // (đóng và KHÔNG còn thử lại nữa). Trước 20/08 bridge không nghe cái nào, nên phiên chết
    // là chết câm: không log, không cảnh báo, không tự chữa — xem sessionHealer.js.
    api.listener.on('connected', () => {
      markWsState(accountId, { wsAlive: true, lastConnectedAt: Date.now(), lastEventAt: Date.now() });
      cancelHealing(accountId);
      console.log(`[${log}] WS connected — account=${accountId}`);
    });

    api.listener.on('disconnected', (code, reason) => {
      // Đóng nhưng zca-js CÓ THỂ đang tự nối lại (retryOnClose bên dưới) → chưa gọi healer.
      markWsState(accountId, { wsAlive: false, lastClosedAt: Date.now(), lastCloseCode: code ?? null, lastCloseReason: reason ?? null });
      console.warn(`[${log}] WS disconnected code=${code} reason="${reason ?? ''}" — account=${accountId}`);
    });

    api.listener.on('closed', (code, reason) => {
      // zca-js đã cạn lượt tự nối lại (hoặc mã đóng không nằm trong danh sách được retry).
      markWsState(accountId, { wsAlive: false, lastClosedAt: Date.now(), lastCloseCode: code ?? null, lastCloseReason: reason ?? null });
      console.error(`[${log}] WS CLOSED code=${code} reason="${reason ?? ''}" — account=${accountId}`);
      healAccount(accountId, { code, reason });
    });

    api.listener.on('error', (err) => {
      console.error(`[${log}] WS error — account=${accountId}:`, err?.message ?? err);
    });

    // retryOnClose: true — mặc định của zca-js là FALSE, tức WebSocket rớt một lần là listener
    // ngừng hẳn. Đây là gốc của sự cố mất tin ngày 20/08 (chi tiết ở sessionHealer.js).
    api.listener.start({ retryOnClose: true });
    markWsState(accountId, { wsAlive: true, lastConnectedAt: Date.now() });

    // Đóng dấu "phiên còn thở" ở MỘT chỗ duy nhất thay vì rải touchSession() vào 9 handler:
    // gói `emit` để mọi sự kiện Zalo đẩy lên (message, typing, delivered, seen, reaction, undo,
    // group_event, friend_event… kể cả sự kiện zca-js thêm sau này) đều cập nhật lastEventAt.
    // Ba sự kiện vòng đời không tính là "thở" — chúng có handler riêng ở trên.
    const emit = api.listener.emit.bind(api.listener);
    api.listener.emit = (event, ...args) => {
      if (event !== 'connected' && event !== 'disconnected' && event !== 'closed' && event !== 'error') {
        touchSession(accountId);
      }
      return emit(event, ...args);
    };

    api.listener.on('message', async (msg) => {
      if (!msg) return;
      console.log(`[${log}] raw: isSelf=${msg.isSelf} type=${msg.type} threadId=${msg.threadId} fromId=${msg.fromId} toId=${msg.toId}`);
      // ── Chẩn đoán loại tin (spec pha 1) ────────────────────────────
      logDiag(msg);

      const { content, attachments, contactCard, location } = parseContentAndAttachments(msg);
      const msgId = String(msg.msgId ?? msg.data?.msgId ?? `zp_${crypto.randomUUID()}`);
      // Trích quote (reply/trích dẫn tin cũ) — null nếu không có
      const quote = extractQuote(msg);
      // Trích @mention (chủ yếu tin nhóm) — null nếu không có
      const mentions = extractMentions(msg);

      // Lưu cặp gMsgID→cliMsgId cho route reaction tra cứu
      rememberMsgId(msg.msgId ?? msg.data?.msgId, msg.cliMsgId ?? msg.data?.cliMsgId);
      // Lưu tin raw để dựng quote (reply) + thu hồi (undo) sau này
      rememberInboundMsg(msg);

      const isGroup = msg.type === 1; // ThreadType.Group = 1

      if (isGroup) {
        // ── Tin NHÓM ──
        // senderId = groupId (contact). Tên/avatar THÀNH VIÊN gửi đi kèm để upstream
        // (ProcessZaloPersonalInboundJob) hiện nhãn tên người gửi trong bong bóng nhóm.
        const groupId = String(msg.threadId ?? '');
        if (!groupId) return;
        const memberSenderId = String(msg.data?.uidFrom ?? '');
        // dName của event = tên hiển thị THÀNH VIÊN thực sự gửi tin.
        let memberSenderName   = msg.data?.dName ?? null;
        let memberSenderAvatar = msg.data?.avatar ?? msg.data?.avatarSm ?? null;
        // Zalo KHÔNG phải lúc nào cũng nhúng dName/avatar vào payload từng tin (vd thành viên mới).
        // Thiếu thì resolve từ danh sách thành viên nhóm theo uidFrom. Best-effort: API lỗi →
        // để null, upstream tự bỏ nhãn — không được chặn tin.
        if ((!memberSenderName || !memberSenderAvatar) && memberSenderId) {
          try {
            const members = await listGroupMembers(api, groupId);
            const m = members.find((x) => String(x.uid) === memberSenderId);
            if (m) {
              memberSenderName   ??= m.name ?? null;
              memberSenderAvatar ??= m.avatar ?? null;
            }
          } catch (e) { /* best-effort */ }
        }

        // Tên/avatar NHÓM cho contact — best-effort, cache theo groupId.
        const gInfo = await getGroupInfoCached(api, groupId);
        const groupName   = gInfo?.name ?? null;
        const groupAvatar = gInfo?.avatar ?? null;

        console.log(`[${log}] group msg → groupId=${groupId} groupName=${groupName} from=${memberSenderName}(${memberSenderId}) isSelf=${msg.isSelf}`);
        pushInbound(tag, accountId, {
          accountId,
          senderId: groupId,        // group ID là "contact"
          content,
          attachments,
          msgId,
          direction: msg.isSelf ? 'Out' : 'In',
          senderName: groupName,    // tên nhóm → đặt tên contact
          senderAvatar: groupAvatar,
          threadType: 'Group',
          memberSenderId,           // ai trong nhóm gửi
          memberSenderName,         // tên người gửi trong nhóm (→ nhãn bong bóng)
          memberSenderAvatar,       // avatar người gửi trong nhóm
          ...(quote ?? {}),
          ...(mentions ? { mentions } : {}),
          ...(contactCard ? { contactCard } : {}),
          ...(location ? { location } : {}),
          timestamp: msg.serverTime ?? Date.now(),
        });

      } else if (msg.isSelf) {
        // ── Tin cá nhân — tự gửi từ điện thoại ──
        const recipientId = String(msg.threadId ?? msg.toId ?? '');
        if (!recipientId) return;

        // Cách 1: thử lấy tên người nhận từ msg.data (Zalo đôi khi nhúng sẵn)
        let recipientName   = msg.data?.toD ?? msg.data?.toName ?? null;
        let recipientAvatar = msg.data?.toAvatar ?? null;

        // Cách 2: nếu không có → gọi getUserInfo (hoạt động với bạn bè).
        // Zalo KHÔNG gửi kèm tên người nhận khi chính mình gửi đi (`toD`/`toName` rỗng) — nó cho
        // rằng mình đã biết mình nhắn cho ai — nên nhánh này là nguồn tên DUY NHẤT ở chiều gửi ra.
        // Trước 01/08 nó đọc `info.data` như mảng, mà getUserInfo trả object có khoá, nên luôn ra
        // null và mọi liên hệ tạo từ tin gửi đi đều mang tên "Zalo 189727...". Xem src/userProfile.js.
        if (!recipientName) {
          try {
            const info = await api.getUserInfo([recipientId]);
            const p = extractUserProfile(info, recipientId);
            recipientName   = p.displayName;
            recipientAvatar = p.avatarUrl;
          } catch (e) {
            console.warn(`[${log}] getUserInfo for recipient ${recipientId} failed:`, e?.message);
          }
        }

        console.log(`[${log}] isSelf msg → recipientId=${recipientId} recipientName=${recipientName} msgId=${msgId}`);
        pushInbound(tag, accountId, {
          accountId,
          senderId: recipientId,
          content,
          attachments,
          msgId,
          direction: 'Out',
          senderName: recipientName,      // tên người nhận → lưu vào contact
          senderAvatar: recipientAvatar,
          ...(quote ?? {}),
          ...(mentions ? { mentions } : {}),
          ...(contactCard ? { contactCard } : {}),
          ...(location ? { location } : {}),
          timestamp: msg.serverTime ?? Date.now(),
        });

      } else {
        // ── Tin cá nhân — người khác gửi đến ──
        const senderId = String(msg.threadId ?? msg.fromId ?? '');
        if (!senderId) return;

        let resolvedName   = msg.data?.dName ?? msg.data?.fullName ?? msg.data?.fromD ?? null;
        let resolvedAvatar = msg.data?.avatar ?? msg.data?.avatarSm ?? null;
        // Thiếu → thử getUserInfo (chỉ hoạt động với bạn bè Zalo).
        // Chiều này ít lộ lỗi parse hơn vì Zalo đã nhúng sẵn `dName` trong payload tin đến, nên
        // nhánh dự phòng hiếm khi chạy tới. Vẫn sửa cho khớp — xem src/userProfile.js.
        if (!resolvedAvatar || !resolvedName) {
          try {
            const info = await api.getUserInfo([senderId]);
            const p = extractUserProfile(info, senderId);
            resolvedAvatar ??= p.avatarUrl;
            resolvedName   ??= p.displayName;
          } catch (e) { /* best-effort, ignore */ }
        }

        console.log(`[${log}] inbound msg → senderId=${senderId} senderName=${resolvedName} hasAvatar=${!!resolvedAvatar} msgId=${msgId}`);
        pushInbound(tag, accountId, {
          accountId,
          senderId,
          content,
          attachments,
          msgId,
          direction: 'In',
          senderName: resolvedName,
          senderAvatar: resolvedAvatar,
          ...(quote ?? {}),
          ...(mentions ? { mentions } : {}),
          ...(contactCard ? { contactCard } : {}),
          ...(location ? { location } : {}),
          timestamp: msg.serverTime ?? Date.now(),
        });
      }
    });

    // Catch-up: lấy messages cũ gần nhất khi listener vừa start — gồm cả tin đã gửi từ điện thoại.
    // Xử lý qua cùng đường push, dedup bằng msgId ở upstream.
    api.listener.on('old_messages', (msgs, threadType) => {
      // 0 = ThreadType.User, 1 = ThreadType.Group — xử lý cả hai
      console.log(`[${log}] old_messages: ${msgs.length} msgs threadType=${threadType} for account ${accountId}`);
      msgs.forEach(msg => {
        if (!msg) return;
        logDiag(msg);
        const { content, attachments, contactCard, location } = parseContentAndAttachments(msg);
        if (!content && attachments.length === 0) return;
        const msgId = String(msg.msgId ?? msg.data?.msgId ?? `zp_${crypto.randomUUID()}`);
        const quote = extractQuote(msg);
        const mentions = extractMentions(msg);
        // Lưu tin cũ vào cache để có thể quote lại khi send-text
        rememberInboundMsg(msg);
        const common = { accountId, content, attachments, msgId, ...(quote ?? {}), ...(mentions ? { mentions } : {}), ...(contactCard ? { contactCard } : {}), ...(location ? { location } : {}), timestamp: msg.data?.ts ?? Date.now() };
        const threadIdStr = String(msg.threadId ?? '');
        if (!threadIdStr) return;
        pushInbound(tag, accountId, { ...common, senderId: threadIdStr, direction: msg.isSelf ? 'Out' : 'In' });
      });
    });

    // Reaction đến từ Zalo → forward về upstream
    api.listener.on('reaction', (r) => {
      try {
        if (!r) return;
        const reactedMsgId = r.data?.content?.rMsg?.[0]?.gMsgID;
        if (reactedMsgId == null) {
          console.warn(`[${log}] inbound reaction missing reactedMsgId — raw:`, JSON.stringify(r));
          return;
        }
        const reactionType = r.data?.content?.rIcon;
        const reactorId = r.data?.uidFrom;
        console.log(`[${log}] inbound reaction → reactor=${reactorId} reactedMsg=${reactedMsgId} icon=${reactionType} isSelf=${r.isSelf}`);
        pushReaction(tag, accountId, {
          accountId,
          threadId: r.threadId,
          reactedMsgId: String(reactedMsgId),
          reactionType,
          reactorId: reactorId != null ? String(reactorId) : null,
          isSelf: r.isSelf,
        });
      } catch (err) {
        console.error(`[${log}] reaction handler error:`, err?.message);
      }
    });

    // Thu hồi tin (recall/undo) đến từ Zalo → forward về upstream
    api.listener.on('undo', (u) => {
      try {
        if (!u) return;
        // globalMsgId của tin BỊ thu hồi (u.data.msgId là msgId của chính action undo)
        const recalledMsgId = u.data?.content?.globalMsgId;
        if (recalledMsgId == null) {
          console.warn(`[${log}] inbound undo missing recalledMsgId — raw:`, JSON.stringify(u));
          return;
        }
        console.log(`[${log}] inbound undo → recalledMsg=${recalledMsgId} thread=${u.threadId} isSelf=${u.isSelf}`);
        pushRecall(tag, accountId, {
          accountId,
          recalledMsgId: String(recalledMsgId),
          threadId: u.threadId != null ? String(u.threadId) : null,
        });
      } catch (err) {
        console.error(`[${log}] undo handler error:`, err?.message);
      }
    });

    // Typing indicator (khách đang soạn tin) → forward về upstream.
    // zca-js v2.1.2 UserTyping shape: { type, isSelf, threadId, data:{ uid, ts, isPC } }
    //   → threadId = data.uid (User) hoặc data.gid (Group). type: 0=User 1=Group.
    api.listener.on('typing', (t) => {
      try {
        if (!t) return;
        const threadId = t.threadId ?? t.data?.uid ?? t.data?.gid;
        if (threadId == null) {
          console.warn(`[${log}] typing missing threadId — raw:`, JSON.stringify(t));
          return;
        }
        pushTyping(tag, accountId, {
          accountId,
          threadId: String(threadId),
          threadType: t.type ?? 0,
          isTyping: true,
        });
      } catch (err) {
        console.error(`[${log}] typing handler error:`, err?.message);
      }
    });

    // Đã nhận (delivered) → forward về upstream.
    // zca-js v2.1.2 emit ARRAY của UserDeliveredMessage:
    //   { type, isSelf, threadId(=data.deliveredUids[0]), data:{ msgId, deliveredUids, seenUids, realMsgId, mSTs } }
    api.listener.on('delivered_messages', (list) => {
      try {
        const arr = Array.isArray(list) ? list : [list];
        if (arr.length === 0) return;
        // Cùng 1 batch thường cùng thread → gom msgIds theo threadId.
        const byThread = new Map();
        for (const d of arr) {
          if (!d) continue;
          const threadId = d.threadId ?? d.data?.deliveredUids?.[0] ?? d.data?.groupId;
          const msgId = d.data?.msgId ?? d.data?.realMsgId;
          if (threadId == null || msgId == null) continue;
          const key = `${threadId}|${d.type ?? 0}`;
          if (!byThread.has(key)) byThread.set(key, { threadId: String(threadId), threadType: d.type ?? 0, msgIds: [] });
          byThread.get(key).msgIds.push(String(msgId));
        }
        for (const g of byThread.values()) {
          pushReceipt(tag, accountId, {
            accountId,
            threadId: g.threadId,
            threadType: g.threadType,
            kind: 'delivered',
            msgIds: g.msgIds,
            ts: Date.now(),
          });
        }
      } catch (err) {
        console.error(`[${log}] delivered_messages handler error:`, err?.message);
      }
    });

    // Đã xem (seen) → forward về upstream.
    // zca-js v2.1.2 emit ARRAY của UserSeenMessage:
    //   { type, isSelf, threadId(=data.idTo), data:{ idTo, msgId, realMsgId } }
    api.listener.on('seen_messages', (list) => {
      try {
        const arr = Array.isArray(list) ? list : [list];
        if (arr.length === 0) return;
        const byThread = new Map();
        for (const s of arr) {
          if (!s) continue;
          const threadId = s.threadId ?? s.data?.idTo ?? s.data?.groupId;
          const msgId = s.data?.msgId ?? s.data?.realMsgId;
          if (threadId == null || msgId == null) continue;
          const key = `${threadId}|${s.type ?? 0}`;
          if (!byThread.has(key)) byThread.set(key, { threadId: String(threadId), threadType: s.type ?? 0, msgIds: [] });
          byThread.get(key).msgIds.push(String(msgId));
        }
        for (const g of byThread.values()) {
          pushReceipt(tag, accountId, {
            accountId,
            threadId: g.threadId,
            threadType: g.threadType,
            kind: 'seen',
            msgIds: g.msgIds,
            ts: Date.now(),
          });
        }
      } catch (err) {
        console.error(`[${log}] seen_messages handler error:`, err?.message);
      }
    });

    // Group event (thêm/xoá TV, đổi tên, đổi avatar, owner, admin…) → forward về upstream.
    // zca-js v2.1.2 GroupEvent shape THẬT (models/GroupEvent.d.ts):
    //   { type: GroupEventType (chuỗi enum: "join","leave","remove_member","block_member",
    //           "update"(đổi tên/info),"update_avatar","add_admin","remove_admin",
    //           "update_setting","new_link","join_request", pin/topic/remind…),
    //     act: string (act thô từ Zalo), data: TGroupEvent, threadId: string, isSelf: boolean }
    //   data (nhánh TGroupEventBase): { subType, groupId, creatorId, groupName, sourceId(=actor),
    //     updateMembers: [{ id, dName, avatar, type }], avt/fullAvt, info, extraData, time, ... }
    //   Nhánh khác: join_request → data.uids[].
    // Best-effort: shape lệch (pin/topic/remind không có groupId) → log + bỏ qua.
    api.listener.on('group_event', (ev) => {
      try {
        if (!ev) return;
        const data = ev.data ?? {};
        const groupId = data.groupId ?? data.group_id ?? ev.threadId;
        if (groupId == null) {
          console.warn(`[${log}] group_event missing groupId — raw:`, JSON.stringify(ev));
          return;
        }
        // Người thực hiện thao tác (actor).
        const actorId = data.sourceId ?? data.creatorId ?? data.actorId ?? data.editorId ?? null;
        // Thành viên liên quan (được thêm/xoá/nâng quyền…). updateMembers là mảng object {id,...}.
        let targetIds = [];
        if (Array.isArray(data.updateMembers)) {
          targetIds = data.updateMembers
            .map((m) => (m && m.id != null ? String(m.id) : (typeof m === 'string' ? m : null)))
            .filter((x) => x != null);
        } else if (Array.isArray(data.uids)) {
          // join_request: danh sách uid xin vào nhóm.
          targetIds = data.uids.map((u) => String(u)).filter((x) => x != null && x !== '');
        }
        pushGroupEvent(tag, accountId, {
          accountId,
          groupId: String(groupId),
          type: ev.type ?? null,       // chuỗi enum GroupEventType (loại event)
          subType: data.subType ?? null,
          act: ev.act ?? null,          // act thô từ Zalo (best-effort thêm cho upstream)
          actorId: actorId != null ? String(actorId) : null,
          targetIds,
          groupName: data.groupName ?? null,
          isSelf: ev.isSelf ?? false,
          raw: ev.data ?? null,
          timestamp: Date.now(),
        });
      } catch (err) {
        console.error(`[${log}] group_event handler error:`, err?.message);
      }
    });

    // Sự kiện bạn bè (kết bạn/hủy kết bạn/lời mời/chặn…) → forward về upstream.
    // Shape THẬT (zca-js models/FriendEvent.d.ts): { type: FriendEventType(0..12), data, threadId, isSelf }
    //   type=REQUEST(2):  data = { toUid, fromUid, src, message }  → người GỬI lời mời = fromUid
    //   type=REJECT_REQUEST(4)/UNDO_REQUEST(3): data = { toUid, fromUid }
    //   type=ADD(0)/REMOVE(1)/BLOCK(6)/UNBLOCK(7)/BLOCK_CALL(8)/UNBLOCK_CALL(9):
    //           data là STRING (uid) và threadId cũng = uid đó
    //   type=SEEN_FRIEND_REQUEST(5): data = string[] (danh sách uid đã xem)
    //   type=PIN_*(10,11)/UNKNOWN(12): shape khác — chỉ forward raw.
    api.listener.on('friend_event', (ev) => {
      try {
        if (!ev) return;
        const typeName = FriendEventType[ev.type] ?? String(ev.type ?? 'UNKNOWN');
        const data = ev.data;

        // Lấy userId đối tác tùy shape.
        let userId = null;
        let message = null;
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          // REQUEST / REJECT / UNDO — object có fromUid/toUid.
          userId = data.fromUid ?? data.toUid ?? null;
          message = data.message ?? null;
        } else if (typeof data === 'string') {
          // ADD/REMOVE/BLOCK… — data là uid dạng string.
          userId = data;
        }
        // Fallback về threadId (với ADD/REMOVE… threadId === uid).
        if (!userId && ev.threadId != null) userId = ev.threadId;

        console.log(`[${log}] friend_event → type=${typeName} user=${userId} isSelf=${ev.isSelf}`);
        pushFriendEvent(tag, accountId, {
          accountId,
          type: typeName,
          userId: userId != null ? String(userId) : null,
          ...(message != null ? { message } : {}),
          isSelf: ev.isSelf ?? false,
          raw: ev.data ?? null,
          timestamp: Date.now(),
        });
      } catch (err) {
        console.error(`[${log}] friend_event handler error:`, err?.message);
      }
    });

    // Request old messages ngay sau khi listener ready
    setTimeout(() => {
      try { api.listener.requestOldMessages(0, null); } // 0 = ThreadType.User
      catch (e) { console.error(`[${log}] requestOldMessages error:`, e?.message); }
    }, 1000).unref?.();

    console.log(`[${tag}] Listener started for account ${accountId}`);
  } catch (err) {
    console.error(`[${tag}] listener.start error for ${accountId}:`, err?.message);
  }
}
