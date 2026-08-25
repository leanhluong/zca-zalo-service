import express from 'express';
import { getSessionByAccountId, listSessions } from '../sessionStore.js';

const router = express.Router();

// GET /contacts/:accountId?page=1&limit=100
// Lấy danh sách bạn bè Zalo của account — dùng để agent chủ động tạo conversation
router.get('/:accountId', async (req, res) => {
  const { accountId } = req.params;
  const limit = parseInt(req.query.limit ?? '200', 10);
  const page  = parseInt(req.query.page  ?? '1',   10);

  console.log(`[contacts] GET accountId=${accountId} page=${page} limit=${limit}`);

  const session = getSessionByAccountId(accountId);
  if (!session) {
    console.warn(`[contacts] 404 — no session for ${accountId}`);
    console.warn(`[contacts] active: [${listSessions().map(s=>`${s.accountId}(${s.status})`).join(', ')||'none'}]`);
    return res.status(404).json({ error: 'Session not found or not logged in' });
  }

  if (session.status !== 'confirmed' || !session.api) {
    return res.status(503).json({ error: 'Session not ready' });
  }

  try {
    const result = await session.api.getAllFriends(limit, page);

    // Log raw để debug cấu trúc response thực tế
    const rawStr = JSON.stringify(result ?? null);
    console.log(`[contacts] raw result type=${Array.isArray(result)?'array':typeof result} keys=${Object.keys(result??{}).join(',')} preview=${rawStr.substring(0, 200)}`);

    // utils.resolve có thể trả về array trực tiếp hoặc {data: [...]}
    let friends = [];
    if (Array.isArray(result)) {
      friends = result;
    } else if (Array.isArray(result?.data)) {
      friends = result.data;
    } else if (Array.isArray(result?.friends)) {
      friends = result.friends;
    } else {
      console.warn(`[contacts] unexpected response structure:`, rawStr.substring(0, 300));
    }

    const contacts = friends
      .map(f => ({
        userId:      String(f.uid ?? f.userId ?? f.user_id ?? ''),
        displayName: f.zaloName ?? f.displayName ?? f.dName ?? f.alias ?? f.name ?? null,
        avatarUrl:   f.avatar ?? f.avt ?? f.avatarUrl ?? null,
        phone:       f.phone ?? f.phoneNumber ?? null,
      }))
      .filter(c => c.userId);

    console.log(`[contacts] OK — ${contacts.length} friends for account ${accountId}`);
    res.json({ contacts, total: contacts.length, page, limit });
  } catch (err) {
    console.error(`[contacts] error:`, err?.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
