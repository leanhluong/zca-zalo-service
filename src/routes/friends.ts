import express from 'express';
import { getSessionByAccountId, listSessions } from '../sessionStore.js';
import { fetchAllAliases } from '../aliasList.js';
import { errMsg } from '../errors.js';
import type { Response } from 'express';
import type { SessionRecord, ZaloApi, ZaloRaw } from '../types.js';

const router = express.Router();

// ── zca-js v2.1.2 signatures THẬT (đọc node_modules/zca-js/dist/apis/) ────────
//   getAllFriends(count?: number, page?: number, avatarSize?: AvatarSize)
//       → Promise<User[]>                (getAllFriends.d.ts)
//   sendFriendRequest(msg: string, userId: string) → Promise<"">
//       LƯU Ý thứ tự: msg TRƯỚC, userId SAU  (sendFriendRequest.d.ts)
//   acceptFriendRequest(friendId: string) → Promise<"">   (acceptFriendRequest.d.ts)
//   getUserInfo(userId: string | string[], avatarSize?)
//       → Promise<{ changed_profiles: Record<userId, User>, unchanged_profiles, phonebook_version }>
//                                          (getUserInfo.d.ts)
//   getGroupMembersInfo(memberId: string | string[])
//       → Promise<{ profiles: Record<memberId, GroupMemberProfile>, unchangeds_profile }>
//                                          (getGroupMembersInfo.d.ts)
//   getAliasList(count?: number, page?: number)
//       → Promise<{ items: [{ userId, alias }], updateTime }>  (getAliasList.d.ts)
//   changeFriendAlias(alias: string, friendId: string) → Promise<"">
//       LƯU Ý thứ tự: alias TRƯỚC, friendId SAU  (changeFriendAlias.d.ts)
//       alias === "" ⇒ xoá biệt danh
//
//   User model (models/User.d.ts): { userId, username, displayName, zaloName,
//       avatar, phoneNumber, isFr, ... }
//   GroupMemberProfile (getGroupMembersInfo.d.ts): { displayName, zaloName, avatar,
//       accountStatus, type, globalId, id }

// Lookup + guard session (mirror messages.ts resolveSession). Trả session hoặc gửi lỗi qua res.
type ReadySession = SessionRecord & { api: ZaloApi };

function resolveSession(res: Response, tag: string, accountId: string): ReadySession | null {
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
  return session as ReadySession;
}

// Chuyển lỗi thô từ zca-js thành message dễ hiểu (mirror ý humanizeSendError của messages.ts).
// zca-js ném ZaloApiError với .message; một số case chỉ có mã số → bọc lại cho upstream đọc được.
function humanizeFriendError(err: unknown): string {
  const raw = errMsg(err) ?? String(err ?? 'unknown error');
  const lower = raw.toLowerCase();
  if (lower.includes('already') && lower.includes('friend')) return 'Đã là bạn bè';
  if (lower.includes('block')) return 'Người dùng đã chặn hoặc bị chặn';
  if (lower.includes('not found') || lower.includes('invalid user')) return 'Không tìm thấy người dùng';
  if (lower.includes('limit') || lower.includes('too many')) return 'Đã vượt giới hạn kết bạn của Zalo';
  return raw;
}

// GET /friends?accountId=&keyword=&count=&page=
// Trả { ok, friends: [{ userId, displayName, avatarUrl, phone? }] }
router.get('/', async (req, res) => {
  const accountId = req.query.accountId as string | undefined;
  const keyword = (req.query.keyword ?? '').toString().trim().toLowerCase();
  const count = parseInt(String(req.query.count ?? '1000'), 10);
  const page = parseInt(String(req.query.page ?? '1'), 10);

  console.log(`[friends] GET accountId=${accountId} keyword="${keyword}" count=${count} page=${page}`);

  if (!accountId) {
    console.warn('[friends] 400 — missing accountId');
    return res.status(400).json({ error: 'accountId required' });
  }

  const session = resolveSession(res, 'friends', accountId);
  if (!session) return;

  try {
    // getAllFriends(count, page) → User[]
    const result: ZaloRaw = await session.api.getAllFriends(count, page);
    // utils.resolve thường trả array trực tiếp; phòng shape {data:[...]}.
    let raw: ZaloRaw[] = [];
    if (Array.isArray(result)) raw = result;
    else if (Array.isArray(result?.data)) raw = result.data;
    else if (Array.isArray(result?.friends)) raw = result.friends;
    else console.warn(`[friends] unexpected response structure: ${JSON.stringify(result ?? null).substring(0, 300)}`);

    let friends = raw
      .map((f: ZaloRaw) => ({
        userId: String(f.userId ?? f.uid ?? f.user_id ?? ''),
        displayName: f.zaloName ?? f.displayName ?? f.dName ?? f.alias ?? f.name ?? null,
        avatarUrl: f.avatar ?? f.avatarSm ?? f.avt ?? f.avatarUrl ?? null,
        phone: f.phoneNumber ?? f.phone ?? null,
      }))
      .filter((c) => c.userId);

    // Lọc keyword theo tên hoặc số điện thoại (client-side, không có API search bạn bè).
    if (keyword) {
      friends = friends.filter((c) =>
        (c.displayName ?? '').toLowerCase().includes(keyword) ||
        (c.phone ?? '').toLowerCase().includes(keyword),
      );
    }

    // Bổ sung tên/avatar còn thiếu qua getUserInfo (best-effort, batch 1 call).
    const missing = friends.filter((c) => !c.displayName || !c.avatarUrl).map((c) => c.userId);
    if (missing.length > 0) {
      try {
        const info = await session.api.getUserInfo(missing);
        const profiles = info?.changed_profiles ?? {};
        for (const c of friends) {
          const p = profiles[c.userId];
          if (!p) continue;
          if (!c.displayName) c.displayName = p.zaloName ?? p.displayName ?? null;
          if (!c.avatarUrl) c.avatarUrl = p.avatar ?? null;
          if (!c.phone) c.phone = p.phoneNumber ?? null;
        }
      } catch (e) {
        console.warn(`[friends] getUserInfo enrich failed: ${errMsg(e)}`);
      }
    }

    console.log(`[friends] OK — ${friends.length} friends for account ${accountId}`);
    res.json({ ok: true, friends });
  } catch (err) {
    console.error(`[friends] 500 — getAllFriends error:`, errMsg(err));
    res.status(500).json({ ok: false, error: humanizeFriendError(err) });
  }
});

// POST /friends/request  { accountId, userId, message? }
// Gửi lời mời kết bạn. zca-js: sendFriendRequest(msg, userId) — msg TRƯỚC, userId SAU.
router.post('/request', async (req, res) => {
  const { accountId, userId, message } = req.body;

  console.log(`[friends/request] accountId=${accountId} userId=${userId} messageLen=${message?.length ?? 0}`);

  if (!accountId || !userId) {
    console.warn('[friends/request] 400 — missing required fields');
    return res.status(400).json({ error: 'accountId, userId required' });
  }

  const session = resolveSession(res, 'friends/request', accountId);
  if (!session) return;

  try {
    // Zalo bắt buộc có lời nhắn kèm lời mời — default nếu upstream không truyền.
    const msg = (message ?? '').toString() || 'Xin chào, kết bạn với mình nhé!';
    await session.api.sendFriendRequest(msg, String(userId));
    console.log(`[friends/request] OK — userId=${userId}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[friends/request] 500 — error for userId=${userId}:`, errMsg(err));
    res.status(500).json({ ok: false, error: humanizeFriendError(err) });
  }
});

// POST /friends/accept  { accountId, userId }
// Chấp nhận lời mời kết bạn. zca-js: acceptFriendRequest(friendId).
router.post('/accept', async (req, res) => {
  const { accountId, userId } = req.body;

  console.log(`[friends/accept] accountId=${accountId} userId=${userId}`);

  if (!accountId || !userId) {
    console.warn('[friends/accept] 400 — missing required fields');
    return res.status(400).json({ error: 'accountId, userId required' });
  }

  const session = resolveSession(res, 'friends/accept', accountId);
  if (!session) return;

  try {
    await session.api.acceptFriendRequest(String(userId));
    console.log(`[friends/accept] OK — userId=${userId}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[friends/accept] 500 — error for userId=${userId}:`, errMsg(err));
    res.status(500).json({ ok: false, error: humanizeFriendError(err) });
  }
});

// GET /friends/aliases?accountId=
// Đọc danh sách biệt danh (alias) đã đặt cho bạn bè trên Zalo — duyệt HẾT các trang.
// zca-js: getAliasList(count, page) → { items: [{ userId, alias }], updateTime }.
// Best-effort cho upstream enrich: mọi lỗi (session chưa sẵn sàng / API lỗi) → { items: [] } + log,
// KHÔNG 500 để không làm gãy luồng đồng bộ contact của upstream.
router.get('/aliases', async (req, res) => {
  const accountId = req.query.accountId as string | undefined;

  console.log(`[friends/aliases] GET accountId=${accountId}`);

  if (!accountId) {
    console.warn('[friends/aliases] 400 — missing accountId');
    return res.status(400).json({ error: 'accountId required' });
  }

  // Best-effort: không dùng resolveSession (tránh 404/503) — session chưa sẵn sàng → items rỗng.
  const session = getSessionByAccountId(accountId);
  if (!session || session.status !== 'confirmed' || !session.api) {
    console.warn(`[friends/aliases] session not ready for accountId=${accountId} (status=${session?.status ?? 'no session'}) — returning empty`);
    return res.json({ items: [] });
  }

  try {
    // Duyệt HẾT các trang (xem src/aliasList.ts) — gọi getAliasList trần chỉ được 100 alias đầu.
    const { items, pagesRead, stopReason } = await fetchAllAliases(session.api, {
      log: (msg) => console.warn(`[friends/aliases] ${msg} (accountId=${accountId})`),
    });

    // stopReason ≠ complete ⇒ danh sách CÓ THỂ THIẾU; log rõ để không tưởng là đã lấy đủ.
    console.log(
      `[friends/aliases] OK — ${items.length} alias(es) for account ${accountId} ` +
        `(pages=${pagesRead}, stop=${stopReason})`,
    );
    res.json({ items });
  } catch (err) {
    // Best-effort — không ném 500, trả rỗng để upstream bỏ qua bước enrich alias.
    console.error(`[friends/aliases] getAliasList error for accountId=${accountId}:`, errMsg(err));
    res.json({ items: [] });
  }
});

// POST /friends/alias  { accountId, friendId, alias }
// Đặt/đổi biệt danh cho 1 người bạn Zalo. alias === "" ⇒ xoá biệt danh.
// zca-js: changeFriendAlias(alias, friendId) — alias TRƯỚC, friendId SAU.
// Ném HTTP như send-text (500 + { error }) để upstream map được lỗi.
router.post('/alias', async (req, res) => {
  const { accountId, friendId, alias } = req.body;

  console.log(`[friends/alias] accountId=${accountId} friendId=${friendId} aliasLen=${alias?.length ?? 0}`);

  if (!accountId || !friendId) {
    console.warn('[friends/alias] 400 — missing required fields');
    return res.status(400).json({ error: 'accountId, friendId required' });
  }

  const session = resolveSession(res, 'friends/alias', accountId);
  if (!session) return;

  try {
    // alias có thể là "" (xoá biệt danh) — chuẩn hoá về string, mặc định "".
    const aliasStr = (alias ?? '').toString();
    await session.api.changeFriendAlias(aliasStr, String(friendId));
    console.log(`[friends/alias] OK — friendId=${friendId} alias="${aliasStr}"`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[friends/alias] 500 — error for friendId=${friendId}:`, errMsg(err));
    res.status(500).json({ ok: false, error: humanizeFriendError(err) });
  }
});

export default router;
