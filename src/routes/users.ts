import express from 'express';
import { getSessionByAccountId } from '../sessionStore.js';
import { extractUserProfile } from '../userProfile.js';
import { errMsg } from '../errors.js';

const router = express.Router();

// GET /users/:accountId/profile/:userId — lấy thông tin user từ Zalo
router.get('/:accountId/profile/:userId', async (req, res) => {
  const { accountId, userId } = req.params;
  console.log(`[users] GET profile accountId=${accountId} userId=${userId}`);

  const session = getSessionByAccountId(accountId);
  if (!session || session.status !== 'confirmed' || !session.api) {
    return res.status(404).json({ error: 'Session not found or not ready' });
  }

  try {
    const result = await session.api.getUserInfo([userId]);

    // getUserInfo trả object có khoá theo userId, KHÔNG phải mảng — đọc `result.data` như mảng
    // là luôn ra rỗng (xem src/userProfile.ts). Cùng lỗi từng làm mọi tin gửi đi mất tên người nhận.
    const { displayName, avatarUrl } = extractUserProfile(result, userId);

    if (!displayName && !avatarUrl) {
      console.warn(`[users] không tra được profile cho ${userId} — có thể không phải bạn bè`);
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ userId: String(userId), displayName, avatarUrl });
  } catch (err) {
    console.error(`[users] getUserInfo error:`, errMsg(err));
    res.status(500).json({ error: errMsg(err) });
  }
});

export default router;
