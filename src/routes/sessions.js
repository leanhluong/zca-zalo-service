import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Zalo, LoginQRCallbackEventType, ThreadType, Reactions } from 'zca-js';
import { createSession, getSession, updateSession, getSessionByAccountId, deleteSession, listSessions, adoptSession } from '../sessionStore.js';
import { getCliMsgId } from '../msgIdCache.js';
import { getGroupInfoCached, listAllGroups, listGroupMembers } from '../groupInfo.js';
import { imageMetadataGetter } from '../imageMeta.js';
import { registerListener } from '../listener.js';

// Tập giá trị code reaction hợp lệ (enum value của Reactions IS code string)
const REACTION_CODES = new Set(Object.values(Reactions));

const router = express.Router();

// POST /sessions/init-qr
router.post('/init-qr', async (req, res) => {
  try {
    const { tempAccountId } = req.body;
    const qrToken = uuidv4().replace(/-/g, '');
    const zalo = new Zalo({ selfListen: true, imageMetadataGetter });
    // Use a Promise that resolves when QR code is ready
    const qrReadyPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('QR timeout: no QR code received within 30s')), 30000);

      // loginQR with callback — fires async events as QR progresses
      zalo.loginQR({}, (event) => {
        try {
          if (event.type === LoginQRCallbackEventType.QRCodeGenerated) {
            clearTimeout(timeout);
            resolve(event.data);
          } else if (event.type === LoginQRCallbackEventType.GotLoginInfo) {
            // Login succeeded — store cookies + imei + userAgent để restore sau này
            const cookiesEncrypted = Buffer.from(
              JSON.stringify(event.data.cookie)
            ).toString('base64');
            // Lưu cookies + imei + userAgent, KHÔNG set status ở đây
            // Status sẽ được set thành 'confirmed' trong .then(api) sau khi loginCookie thành công
            updateSession(qrToken, {
              cookiesEncrypted,
              imei: event.data.imei ?? null,
              userAgent: event.data.userAgent ?? null,
            });
          } else if (event.type === LoginQRCallbackEventType.QRCodeScanned) {
            // User scanned — update displayName/avatar if we have it
            updateSession(qrToken, {
              displayName: event.data.display_name ?? null,
              avatarUrl: event.data.avatar ?? null,
            });
          } else if (event.type === LoginQRCallbackEventType.QRCodeExpired) {
            updateSession(qrToken, { status: 'expired' });
          }
        } catch (err) {
          console.error('loginQR callback error:', err?.message);
          updateSession(qrToken, { status: 'failed' });
        }
      })
        .then(async (api) => {
          // loginQR resolves with API object after full login + loginCookie complete
          if (!api) return;
          const selfInfo = api.getOwnId?.();
          const resolvedAccountId = selfInfo ?? qrToken;

          // Lấy phone của account — cần cho phone whitelist check phía upstream
          let phone = null;
          try {
            const accountInfo = await api.fetchAccountInfo();
            phone = accountInfo?.profile?.phoneNumber ?? null;
            // Che số điện thoại trong log — chỉ giữ 4 số cuối để đối chiếu khi cần.
            console.log(`[login] fetchAccountInfo phone=${phone ? `***${String(phone).slice(-4)}` : 'null'} for account ${resolvedAccountId}`);
          } catch (err) {
            console.warn('[login] fetchAccountInfo failed (best-effort):', err?.message);
          }

          updateSession(qrToken, {
            api,
            status: 'confirmed',
            accountId: resolvedAccountId,
            phone,
          });

          // Phiên vừa đăng nhập là phiên DUY NHẤT hợp lệ của account này (Zalo chỉ giữ 1 phiên
          // PC/web — đăng nhập mới đá phiên cũ). Dọn mọi entry cũ cùng accountId, nếu không
          // getSessionByAccountId/send-text vẫn bám phiên chết và trả "zpw_sek bị thiếu hoặc
          // không đúng" trong khi listener mới vẫn nhận tin ⇒ inbound chạy, outbound chết.
          adoptSession(qrToken, resolvedAccountId);

          // Listener + đường push về upstream dùng CHUNG với sessionRestore.js (listener.js).
          registerListener(api, resolvedAccountId, { tag: 'qr' });
        })
        .catch((err) => {
          console.error('loginQR final error:', err?.message ?? err);
          updateSession(qrToken, { status: 'error' });
        });
    });

    const qrData = await qrReadyPromise;

    // Store session early (api will be attached after login completes)
    createSession(qrToken, zalo, tempAccountId);

    // qrData.image is a base64 PNG data URL or raw base64 string
    const qrImageUrl = qrData.image?.startsWith('data:')
      ? qrData.image
      : `data:image/png;base64,${qrData.image}`;

    console.log(`[init-qr] QR ready — qrToken=${qrToken} expiresIn=600`);
    res.json({ qrImageUrl, qrToken, expiresIn: 600 });
  } catch (err) {
    console.error('[init-qr] error:', err?.message ?? err);
    res.status(500).json({ error: err.message });
  }
});

// GET /sessions/:qrToken/status
router.get('/:qrToken/status', (req, res) => {
  const session = getSession(req.params.qrToken);
  if (!session) {
    console.warn(`[qr-status] 404 — qrToken=${req.params.qrToken} not found`);
    return res.status(404).json({ error: 'Session not found or expired' });
  }
  console.log(`[qr-status] qrToken=${req.params.qrToken} status=${session.status} accountId=${session.accountId ?? 'null'}`);
  res.json({
    status: session.status,
    accountId: session.accountId,
    displayName: session.displayName,
    avatarUrl: session.avatarUrl,
    cookiesEncrypted: session.cookiesEncrypted,
    imei: session.imei ?? null,
    userAgent: session.userAgent ?? null,
    phone: session.phone ?? null,
  });
});

// Thời gian tối đa chờ Zalo trả lời lệnh thăm dò liveness.
const PROBE_TIMEOUT_MS = 6000;

/**
 * GET /sessions/:accountId/health
 *
 * Trả lời "phiên này có thực sự nhận được tin không". Bản cũ chỉ đọc hai biến trong RAM
 * (`status === 'confirmed'` và `api.listener != null`) — cả hai đều đúng vĩnh viễn sau khi
 * login, kể cả khi WebSocket đã đóng từ lâu. Đo prod 20/08/2026: một tài khoản chết câm 1h53
 * và mất 3 tin của khách, trong khi endpoint này vẫn trả healthy=true.
 *
 * Giờ có hai tầng bằng chứng:
 *   1. `wsAlive` + `lastEventAt` — trạng thái đường WebSocket do listener.js ghi lại.
 *   2. `probe` — gọi thật `keepAlive()` lên Zalo. Đây là thứ phát hiện được phiên bị Zalo ĐÁ
 *      (khách đăng nhập Zalo PC nơi khác): cookies chết thì lệnh này lỗi, dù WebSocket có thể
 *      chưa kịp đóng.
 *
 * Field `healthy` giữ nguyên ý nghĩa cũ cho upstream đang gọi; các field còn lại là thông tin thêm.
 */
router.get('/:accountId/health', async (req, res) => {
  const accountId = req.params.accountId;
  const session = getSessionByAccountId(accountId);
  const hasListener = session?.api?.listener != null;
  const registered = session !== null && session.status === 'confirmed' && hasListener;

  if (!registered) {
    console.log(`[health] accountId=${accountId} healthy=false status=${session?.status ?? 'no session'} hasListener=${hasListener}`);
    return res.json({
      healthy: false,
      registered: false,
      wsAlive: false,
      reason: session === null ? 'no_session' : `status=${session.status}`,
    });
  }

  // Thăm dò thật — keepAlive là lệnh nhẹ nhất zca-js có (chỉ trả config version).
  let probeOk = false;
  let probeError = null;
  try {
    const probe = typeof session.api.keepAlive === 'function'
      ? session.api.keepAlive()
      : session.api.fetchAccountInfo();
    await Promise.race([
      probe,
      new Promise((_, reject) => setTimeout(() => reject(new Error('probe timeout')), PROBE_TIMEOUT_MS)),
    ]);
    probeOk = true;
  } catch (err) {
    probeError = err?.message ?? String(err);
  }

  const lastEventAt = session.lastEventAt ?? null;
  const body = {
    healthy: probeOk,
    registered: true,
    wsAlive: session.wsAlive === true,
    lastEventAt,
    secondsSinceLastEvent: lastEventAt ? Math.round((Date.now() - lastEventAt) / 1000) : null,
    lastCloseCode: session.lastCloseCode ?? null,
    lastCloseReason: session.lastCloseReason ?? null,
    probeError,
  };
  console.log(
    `[health] accountId=${accountId} healthy=${body.healthy} wsAlive=${body.wsAlive} ` +
    `sinceLastEvent=${body.secondsSinceLastEvent ?? '-'}s closeCode=${body.lastCloseCode ?? '-'}` +
    (probeError ? ` probeError="${probeError}"` : ''));
  res.json(body);
});

// GET /sessions/:accountId/groups
// Liệt kê tất cả nhóm của account → [{ groupId, name, avatar, memberCount }]
// Dữ liệu để upstream cleanup tên nhóm + phase sau (danh sách nhóm/thành viên).
router.get('/:accountId/groups', async (req, res) => {
  const { accountId } = req.params;
  const session = getSessionByAccountId(accountId);
  if (!session) {
    const active = listSessions();
    console.warn(`[groups] 404 — session not found for accountId=${accountId}`);
    console.warn(`[groups] active sessions: [${active.map(s => `${s.accountId}(${s.status})`).join(', ') || 'none'}]`);
    return res.status(404).json({ error: 'Session not found or not logged in' });
  }
  if (session.status !== 'confirmed' || !session.api) {
    console.warn(`[groups] 503 — session not ready for accountId=${accountId} status=${session.status}`);
    return res.status(503).json({ error: 'Session not ready' });
  }

  try {
    const groups = await listAllGroups(session.api);
    console.log(`[groups] accountId=${accountId} → ${groups.length} group(s)`);
    res.json({ groups });
  } catch (err) {
    console.error(`[groups] 500 — error listing groups for accountId=${accountId}:`, err?.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /sessions/:accountId/groups/:groupId/members
// Liệt kê thành viên 1 nhóm với tên + avatar → { members: [{ uid, name, avatar }] }
// Luồng: getGroupInfo → ưu tiên currentMems (kèm avatar), fallback memberIds/memVerList
// → getGroupMembersInfo. upstream dùng members[].avatar để dựng collage avatar nhóm.
router.get('/:accountId/groups/:groupId/members', async (req, res) => {
  const { accountId, groupId } = req.params;
  const session = getSessionByAccountId(accountId);
  if (!session) {
    const active = listSessions();
    console.warn(`[members] 404 — session not found for accountId=${accountId}`);
    console.warn(`[members] active sessions: [${active.map(s => `${s.accountId}(${s.status})`).join(', ') || 'none'}]`);
    return res.status(404).json({ error: 'Session not found or not logged in' });
  }
  if (session.status !== 'confirmed' || !session.api) {
    console.warn(`[members] 503 — session not ready for accountId=${accountId} status=${session.status}`);
    return res.status(503).json({ error: 'Session not ready' });
  }

  try {
    const members = await listGroupMembers(session.api, groupId);
    // getGroupInfo trả totalMember (số thành viên) + avatar nhóm ngay cả khi memberIds rỗng
    // (zca-js@2.1.2 hay KHÔNG trả memberIds → members = []). Đính kèm để upstream có số thành viên
    // dựng badge + avatar nhóm dù không ghép được collage.
    const gInfo = await getGroupInfoCached(session.api, groupId);
    const memberCount = gInfo?.memberCount ?? members.length;
    const groupAvatar = gInfo?.avatar || null;
    const groupName = gInfo?.name || null;
    console.log(`[members] accountId=${accountId} groupId=${groupId} → ${members.length} member(s), totalMember=${memberCount}, name=${groupName}`);
    res.json({ members, memberCount, groupAvatar, groupName });
  } catch (err) {
    console.error(`[members] 500 — error listing members for accountId=${accountId} groupId=${groupId}:`, err?.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /sessions/:accountId/reaction
// body { threadId, msgId, reactionType }  (reactionType = Zalo code string, vd "/-heart")
router.post('/:accountId/reaction', async (req, res) => {
  const { accountId } = req.params;
  const { threadId, msgId, reactionType } = req.body;

  console.log(`[reaction] accountId=${accountId} threadId=${threadId} msgId=${msgId} reactionType=${reactionType}`);

  if (!threadId || !msgId || !reactionType) {
    console.warn('[reaction] 400 — missing required fields');
    return res.status(400).json({ error: 'threadId, msgId, reactionType required' });
  }

  const session = getSessionByAccountId(accountId);
  if (!session) {
    const active = listSessions();
    console.warn(`[reaction] 404 — session not found for accountId=${accountId}`);
    console.warn(`[reaction] active sessions: [${active.map(s => `${s.accountId}(${s.status})`).join(', ') || 'none'}]`);
    return res.status(404).json({ error: 'Session not found or not logged in' });
  }

  if (session.status !== 'confirmed') {
    console.warn(`[reaction] 404 — session status=${session.status} (not confirmed) for accountId=${accountId}`);
    return res.status(404).json({ error: 'Session not found or not logged in' });
  }

  if (!session.api) {
    console.warn(`[reaction] 503 — api not ready for accountId=${accountId}`);
    return res.status(503).json({ error: 'API not ready yet — login still in progress' });
  }

  // reactionType (code string) → Reactions enum value (enum value IS the code string)
  if (!REACTION_CODES.has(reactionType)) {
    console.warn(`[reaction] 400 — unknown reactionType=${reactionType}`);
    return res.status(400).json({ error: `Unknown reactionType: ${reactionType}` });
  }
  const reaction = reactionType; // hợp lệ ⇒ chính là Reactions enum value

  // addReaction cần cliMsgId; upstream chỉ gửi msgId (gMsgID) → tra cache, fallback = msgId
  let cliMsgId = getCliMsgId(msgId);
  if (cliMsgId == null) {
    console.warn(`[reaction] cliMsgId not found in cache for msgId=${msgId} — fallback cliMsgId=msgId (best-effort)`);
    cliMsgId = String(msgId);
  }

  try {
    const result = await session.api.addReaction(reaction, {
      data: { msgId: String(msgId), cliMsgId: String(cliMsgId) },
      threadId: String(threadId),
      type: ThreadType.User,
    });
    const reactionId = result?.msgIds?.[0]?.toString() ?? null;
    console.log(`[reaction] OK — reactionId=${reactionId}`);
    res.json({ reactionId });
  } catch (err) {
    console.error(`[reaction] 500 — error reacting on msgId=${msgId}:`, err?.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /sessions/:accountId
router.delete('/:accountId', (req, res) => {
  console.log(`[delete-session] accountId=${req.params.accountId}`);
  deleteSession(req.params.accountId);
  res.status(204).send();
});

export default router;
