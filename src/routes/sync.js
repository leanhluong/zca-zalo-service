import express from 'express';
import { ThreadType } from 'zca-js';
import { getSessionByAccountId, listSessions } from '../sessionStore.js';
import { parseContentAndAttachments, extractQuote, extractMentions } from '../msgContent.js';
import { getGroupInfoCached, listGroupMembers } from '../groupInfo.js';

const UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL ?? 'http://localhost:5000';
const WEBHOOK_PATH = process.env.UPSTREAM_WEBHOOK_PATH ?? '/api/v1/webhook/zalo-personal';
const SYNC_TIMEOUT_MS = 15000;  // 15s timeout chờ Zalo trả lời

const router = express.Router();

async function pushMessageToUpstream(accountId, msg, threadType = ThreadType.User, api = null) {
  try {
    // Debug: log raw fields để tìm đúng field chứa content
    const dataKeys = msg.data ? Object.keys(msg.data) : [];
    console.log(`[sync] raw msg fields: type=${msg.type} isSelf=${msg.isSelf} threadId=${msg.threadId} msgId=${msg.msgId ?? msg.data?.msgId} dataKeys=[${dataKeys.join(',')}] content=${JSON.stringify(msg.data?.content ?? msg.content)?.substring(0,100)}`);

    const { content, attachments, contactCard, location } = parseContentAndAttachments(msg);
    const msgId = String(msg.msgId ?? msg.data?.msgId ?? `zp_${Date.now()}_${Math.random()}`);
    const direction = msg.isSelf ? 'Out' : 'In';
    const quote = extractQuote(msg);
    const mentions = extractMentions(msg);

    // ── Detect nhóm PER-MESSAGE (giống live listener sessions.js: msg.type === 1 = ThreadType.Group) ──
    // KHÔNG dựa threadType cấp-REQUEST: history có thể trộn tin nhóm + 1-1, nếu ép theo request
    // thì tin nhóm bị coi là 1-1 → mất tên người gửi trong nhóm.
    //   1) Tín hiệu chính: msg.type === 1 (giống live listener).
    //   2) old_messages có thể KHÔNG kèm msg.type → suy từ group info: nếu resolve được tên nhóm
    //      cho threadId thì coi là nhóm (best-effort, cache theo threadId nên không gọi lặp).
    //   3) Fallback cuối: request-level threadType (giữ tương thích khi caller chỉ định Group).
    let isGroup = msg.type === 1;
    if (!isGroup && msg.type == null && api && msg.threadId) {
      const probe = await getGroupInfoCached(api, String(msg.threadId));
      if (probe?.name) isGroup = true;
    }
    if (!isGroup && threadType === ThreadType.Group) isGroup = true;

    let payload;
    if (isGroup) {
      // ── Tin nhóm — payload kèm field nhóm giống live listener (sessions.js) ──
      const groupId = String(msg.threadId ?? '');
      if (!groupId || (!content && attachments.length === 0)) {
        console.warn(`[sync] SKIP group — groupId="${groupId}" content="${content}" attachments=${attachments.length} (empty)`);
        return false;
      }
      const memberSenderId     = String(msg.data?.uidFrom ?? '');
      let   memberSenderName   = msg.data?.dName ?? null;
      const memberSenderAvatar = msg.data?.avatar ?? msg.data?.avatarSm ?? null;

      // Lấy tên nhóm — best-effort qua getGroupInfo (cache theo groupId)
      const gInfo = api ? await getGroupInfoCached(api, groupId) : null;
      const groupName = gInfo?.name ?? null;

      // Fallback tên người gửi: dName rỗng → tra thành viên nhóm theo uid (giống live listener helper)
      if (!memberSenderName && api && memberSenderId) {
        try {
          const members = await listGroupMembers(api, groupId);
          const found = members.find((m) => String(m.uid) === memberSenderId);
          memberSenderName = found?.name ?? null;
        } catch (e) {
          console.warn(`[sync] listGroupMembers fallback error groupId=${groupId}:`, e?.message);
        }
      }

      console.log(`[sync] parsed group: groupId=${groupId} groupName=${groupName} from=${memberSenderName}(${memberSenderId}) msgId=${msgId} direction=${direction}`);
      payload = {
        accountId,
        senderId: groupId,
        content,
        attachments,
        msgId,
        direction,
        senderName: groupName,
        threadType: 'Group',
        memberSenderId,
        memberSenderName,
        memberSenderAvatar,
        ...(quote ?? {}),
        ...(mentions ? { mentions } : {}),
        ...(contactCard ? { contactCard } : {}),
        ...(location ? { location } : {}),
        timestamp: msg.data?.ts ?? Date.now(),
      };
    } else {
      // ── Tin 1-1 (User) — payload giữ nguyên như cũ ──
      const senderId = msg.isSelf
        ? String(msg.threadId ?? msg.data?.idTo ?? '')
        : String(msg.threadId ?? msg.fromId ?? msg.data?.uidFrom ?? '');

      console.log(`[sync] parsed: senderId=${senderId} content="${content.substring(0,50)}" msgId=${msgId} direction=${direction}`);

      if (!senderId || (!content && attachments.length === 0)) {
        console.warn(`[sync] SKIP — senderId="${senderId}" content="${content}" attachments=${attachments.length} (empty)`);
        return false;
      }
      payload = { accountId, senderId, content, attachments, msgId, direction, ...(quote ?? {}), ...(mentions ? { mentions } : {}), ...(contactCard ? { contactCard } : {}), ...(location ? { location } : {}), timestamp: msg.data?.ts ?? Date.now() };
    }

    const resp = await fetch(`${UPSTREAM_BASE_URL}${WEBHOOK_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-System-Key': process.env.SYSTEM_KEY ?? '' },
      body: JSON.stringify(payload),
    });
    return resp.ok;
  } catch (err) {
    console.error(`[sync] push error:`, err?.message);
    return false;
  }
}

// POST /sync/:accountId?lastMsgId=xxx
// Lấy lịch sử tin nhắn DM user — dùng WebSocket requestOldMessages
router.post('/:accountId', async (req, res) => {
  const { accountId } = req.params;
  const { lastMsgId = null, threadType = 'User' } = req.body;

  // Map threadType từ body → ThreadType enum ('Group' → Group, còn lại → User)
  const mappedThreadType = threadType === 'Group' ? ThreadType.Group : ThreadType.User;

  console.log(`[sync] POST accountId=${accountId} lastMsgId=${lastMsgId ?? 'null (first page)'} threadType=${threadType}`);

  const session = getSessionByAccountId(accountId);
  if (!session) {
    console.warn(`[sync] 404 — no session for ${accountId}`);
    console.warn(`[sync] active: [${listSessions().map(s=>`${s.accountId}(${s.status})`).join(', ')||'none'}]`);
    return res.status(404).json({ error: 'Session not found or not logged in' });
  }

  if (session.status !== 'confirmed' || !session.api) {
    return res.status(503).json({ error: 'Session not ready' });
  }

  try {
    // Chờ Zalo trả old_messages qua WebSocket
    const messages = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.warn(`[sync] timeout waiting for old_messages`);
        resolve([]);
      }, SYNC_TIMEOUT_MS);

      // One-time listener — chỉ lắng nghe 1 response rồi tháo ra
      const handler = (msgs, respThreadType) => {
        if (respThreadType !== mappedThreadType) return;
        clearTimeout(timeout);
        session.api.listener.off('old_messages', handler);
        console.log(`[sync] received ${msgs.length} old messages`);
        resolve(msgs);
      };

      session.api.listener.on('old_messages', handler);
      session.api.listener.requestOldMessages(mappedThreadType, lastMsgId);
    });

    if (messages.length === 0) {
      return res.json({ synced: 0, lastMsgId: null, hasMore: false });
    }

    // Push từng message về upstream (tái dùng webhook job → dedup tự động)
    let pushed = 0;
    for (const msg of messages) {
      const ok = await pushMessageToUpstream(accountId, msg, mappedThreadType, session.api);
      if (ok) pushed++;
    }

    // lastMsgId để gọi trang tiếp theo (message cũ nhất trong batch)
    const oldestMsg = messages[messages.length - 1];
    const nextLastMsgId = String(oldestMsg?.msgId ?? oldestMsg?.data?.msgId ?? '');

    console.log(`[sync] pushed ${pushed}/${messages.length} messages. nextLastMsgId=${nextLastMsgId}`);

    res.json({
      synced: pushed,
      total: messages.length,
      lastMsgId: nextLastMsgId || null,
      hasMore: messages.length > 0,  // còn trang tiếp nếu có message
    });
  } catch (err) {
    console.error(`[sync] error:`, err?.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /sync/:accountId/group/:groupId  body { count }
//
// Đồng bộ lịch sử của ĐÚNG MỘT nhóm bằng `getGroupChatHistory` — API đọc lịch sử thật, khác hẳn
// `requestOldMessages` ở route trên.
//
// `requestOldMessages` là HÀNG ĐỢI TIN TỒN ĐỌNG chưa nhận, không phải lịch sử hội thoại: phiên
// vừa đăng nhập đã nuốt hết hàng đợi thì nó trả 0 mãi mãi. Đo prod 20/08/2026 trên tài khoản
// 198202235016560549, hai lần bấm Đồng bộ liên tiếp: threadType=User trả 0 msgs cả hai lần,
// threadType=Group trả 38. Vì vậy nút Đồng bộ không bao giờ lấp được tin 1-1 đã mất.
//
// GIỚI HẠN CÒN LẠI (nói thẳng, đừng để người sau tưởng đã xong): zca-js 2.1.2 KHÔNG có API đọc
// lịch sử chat 1-1 (`getGroupChatHistory` chỉ nhận groupId; danh sách API đầy đủ không có
// getUserChatHistory hay tương đương). Tin 1-1 mất trong lúc phiên chết là mất thật — cách duy
// nhất là ĐỪNG ĐỂ MẤT, tức phần retryOnClose + tự chữa ở listener.js/sessionHealer.js.
router.post('/:accountId/group/:groupId', async (req, res) => {
  const { accountId, groupId } = req.params;
  const count = Number(req.body?.count) > 0 ? Math.min(Number(req.body.count), 500) : 50;

  const session = getSessionByAccountId(accountId);
  if (!session) return res.status(404).json({ error: 'Session not found or not logged in' });
  if (session.status !== 'confirmed' || !session.api) return res.status(503).json({ error: 'Session not ready' });

  console.log(`[sync-group] POST accountId=${accountId} groupId=${groupId} count=${count}`);

  try {
    const history = await session.api.getGroupChatHistory(groupId, count);
    const msgs = history?.groupMsgs ?? [];
    console.log(`[sync-group] got ${msgs.length} message(s) for group ${groupId}`);

    let pushed = 0;
    for (const msg of msgs) {
      const ok = await pushMessageToUpstream(accountId, msg, ThreadType.Group, session.api);
      if (ok) pushed++;
    }

    console.log(`[sync-group] pushed ${pushed}/${msgs.length} for group ${groupId}`);
    res.json({ synced: pushed, total: msgs.length, hasMore: (history?.more ?? 0) > 0 });
  } catch (err) {
    console.error(`[sync-group] error groupId=${groupId}:`, err?.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
