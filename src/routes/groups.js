import express from 'express';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { getSessionByAccountId, listSessions } from '../sessionStore.js';

const router = express.Router();

// Lookup + guard session (mirror messages.js resolveSession). Trả session hoặc gửi lỗi qua res.
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

// Chuẩn hoá message lỗi zca-js → thông điệp RÕ cho upstream/FE (mirror messages.js humanizeSendError).
function humanizeSendError(err) {
  const msg = err?.message ?? 'Unknown error';
  if (/Missing `imageMetadataGetter`/i.test(msg)) {
    return 'Bridge chưa cấu hình đọc metadata ảnh (imageMetadataGetter)';
  }
  if (/extension .* is not allowed/i.test(msg)) {
    return 'Định dạng tệp không được Zalo cho phép';
  }
  return msg;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retry ngắn cho lỗi transient (mạng/upload chập chờn) — mirror messages.js withRetry.
async function withRetry(fn, tag, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts) {
        console.warn(`[${tag}] attempt ${i}/${attempts} failed: ${err?.message} — retrying...`);
        await delay(300 * i);
      }
    }
  }
  throw lastErr;
}

// Tải fileUrl về file tạm trong os.tmpdir(). Trả tmpPath.
// changeGroupAvatar nhận avatarSource là ĐƯỜNG DẪN FILE LOCAL (string) → nó fs.readFileSync +
// getImageMetaData(path). Vì vậy avatar phải download về tmp trước (giống send-image).
async function downloadToTmp(fileUrl, tag = 'download') {
  return withRetry(async () => {
    const resp = await fetch(fileUrl);
    if (!resp.ok) throw new Error(`Failed to download file (HTTP ${resp.status})`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    const contentType = resp.headers.get('content-type') ?? '';
    const ctExt = {
      'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
      'image/webp': '.webp', 'image/gif': '.gif',
    }[contentType.split(';')[0].trim().toLowerCase()] ?? '';
    let ext = path.extname(new URL(fileUrl).pathname) || ctExt || '.jpg';
    const tmpPath = path.join(os.tmpdir(), `zbridge_group_${crypto.randomUUID()}${ext}`);
    await fs.writeFile(tmpPath, buffer);
    return tmpPath;
  }, tag);
}

// Chuẩn hoá memberIds body → mảng string không rỗng.
function normalizeMemberIds(memberIds) {
  if (memberIds == null) return [];
  const arr = Array.isArray(memberIds) ? memberIds : [memberIds];
  return arr.map((m) => (m != null ? String(m) : null)).filter((m) => m != null && m !== '');
}

// POST /groups/add-member — thêm thành viên vào nhóm.
// body { accountId, groupId, memberIds:[] }
// zca-js v2.1.2 signature THẬT (apis/addUserToGroup.d.ts):
//   api.addUserToGroup(memberId: string | string[], groupId: string)
//     -> { errorMembers: string[], error_data: Record<string,string[]> }
// LƯU Ý thứ tự tham số: (memberId, groupId) — member TRƯỚC, group SAU.
router.post('/add-member', async (req, res) => {
  const { accountId, groupId, memberIds } = req.body;
  const members = normalizeMemberIds(memberIds);

  console.log(`[groups/add-member] accountId=${accountId} groupId=${groupId} members=${members.length}`);

  if (!accountId || !groupId || members.length === 0) {
    console.warn('[groups/add-member] 400 — missing required fields');
    return res.status(400).json({ error: 'accountId, groupId, memberIds[] required' });
  }

  const session = resolveSession(res, 'groups/add-member', accountId);
  if (!session) return;

  try {
    const result = await withRetry(
      () => session.api.addUserToGroup(members, String(groupId)),
      'groups/add-member-zalo'
    );
    const errorMembers = Array.isArray(result?.errorMembers) ? result.errorMembers : [];
    console.log(`[groups/add-member] OK — groupId=${groupId} errorMembers=${errorMembers.length}`);
    res.json({ ok: true, errorMembers });
  } catch (err) {
    console.error(`[groups/add-member] 500 — groupId=${groupId}: ${err?.message}`);
    res.status(500).json({ error: humanizeSendError(err), code: err?.name });
  }
});

// POST /groups/remove-member — xoá thành viên khỏi nhóm.
// body { accountId, groupId, memberIds:[] }
// zca-js v2.1.2 signature THẬT (apis/removeUserFromGroup.d.ts):
//   api.removeUserFromGroup(memberId: string | string[], groupId: string)
//     -> { errorMembers: string[] }
// Thứ tự tham số: (memberId, groupId).
router.post('/remove-member', async (req, res) => {
  const { accountId, groupId, memberIds } = req.body;
  const members = normalizeMemberIds(memberIds);

  console.log(`[groups/remove-member] accountId=${accountId} groupId=${groupId} members=${members.length}`);

  if (!accountId || !groupId || members.length === 0) {
    console.warn('[groups/remove-member] 400 — missing required fields');
    return res.status(400).json({ error: 'accountId, groupId, memberIds[] required' });
  }

  const session = resolveSession(res, 'groups/remove-member', accountId);
  if (!session) return;

  try {
    const result = await withRetry(
      () => session.api.removeUserFromGroup(members, String(groupId)),
      'groups/remove-member-zalo'
    );
    const errorMembers = Array.isArray(result?.errorMembers) ? result.errorMembers : [];
    console.log(`[groups/remove-member] OK — groupId=${groupId} errorMembers=${errorMembers.length}`);
    res.json({ ok: true, errorMembers });
  } catch (err) {
    console.error(`[groups/remove-member] 500 — groupId=${groupId}: ${err?.message}`);
    res.status(500).json({ error: humanizeSendError(err), code: err?.name });
  }
});

// POST /groups/rename — đổi tên nhóm.
// body { accountId, groupId, name }
// zca-js v2.1.2 signature THẬT (apis/changeGroupName.d.ts):
//   api.changeGroupName(name: string, groupId: string) -> { status: number }
// Thứ tự tham số: (name, groupId) — TÊN TRƯỚC, group SAU.
router.post('/rename', async (req, res) => {
  const { accountId, groupId, name } = req.body;

  console.log(`[groups/rename] accountId=${accountId} groupId=${groupId} name=${name}`);

  if (!accountId || !groupId || name == null || name === '') {
    console.warn('[groups/rename] 400 — missing required fields');
    return res.status(400).json({ error: 'accountId, groupId, name required' });
  }

  const session = resolveSession(res, 'groups/rename', accountId);
  if (!session) return;

  try {
    const result = await withRetry(
      () => session.api.changeGroupName(String(name), String(groupId)),
      'groups/rename-zalo'
    );
    console.log(`[groups/rename] OK — groupId=${groupId} status=${result?.status ?? '-'}`);
    res.json({ ok: true, status: result?.status });
  } catch (err) {
    console.error(`[groups/rename] 500 — groupId=${groupId}: ${err?.message}`);
    res.status(500).json({ error: humanizeSendError(err), code: err?.name });
  }
});

// POST /groups/avatar — đổi ảnh đại diện nhóm.
// body { accountId, groupId, avatarUrl }
// zca-js v2.1.2 signature THẬT (apis/changeGroupAvatar.js):
//   api.changeGroupAvatar(avatarSource: AttachmentSource, groupId: string) -> ""
//   avatarSource là ĐƯỜNG DẪN FILE LOCAL (string) → lib fs.readFileSync + getImageMetaData(path)
//   (cần imageMetadataGetter, đã cấu hình trong Zalo ctor). VÌ VẬY: download avatarUrl về tmp
//   rồi truyền tmpPath (giống /messages/send-image). Thứ tự tham số: (avatarSource, groupId).
router.post('/avatar', async (req, res) => {
  const { accountId, groupId, avatarUrl } = req.body;

  console.log(`[groups/avatar] accountId=${accountId} groupId=${groupId} avatarUrl=${avatarUrl?.substring(0, 80)}`);

  if (!accountId || !groupId || !avatarUrl) {
    console.warn('[groups/avatar] 400 — missing required fields');
    return res.status(400).json({ error: 'accountId, groupId, avatarUrl required' });
  }

  const session = resolveSession(res, 'groups/avatar', accountId);
  if (!session) return;

  let tmpPath = null;
  try {
    tmpPath = await downloadToTmp(avatarUrl, 'groups/avatar');
    console.log(`[groups/avatar] downloaded → ${tmpPath}, changing avatar groupId=${groupId}...`);
    await withRetry(
      () => session.api.changeGroupAvatar(tmpPath, String(groupId)),
      'groups/avatar-zalo'
    );
    console.log(`[groups/avatar] OK — groupId=${groupId}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[groups/avatar] 500 — groupId=${groupId}: ${err?.message}`);
    res.status(500).json({ error: humanizeSendError(err), code: err?.name });
  } finally {
    if (tmpPath) {
      try { await fs.unlink(tmpPath); } catch (e) { /* best-effort cleanup */ }
    }
  }
});

// POST /groups/create — tạo nhóm mới.
// body { accountId, name, memberIds:[] }
// zca-js v2.1.2 signature THẬT (apis/createGroup.d.ts):
//   api.createGroup(options: { name?: string, members: string[], avatarSource?: AttachmentSource })
//     -> { groupType, sucessMembers: string[], groupId: string, errorMembers: string[], error_data }
//   `members` BẮT BUỘC (không rỗng); `name` tuỳ chọn. Trả groupId mới.
router.post('/create', async (req, res) => {
  const { accountId, name, memberIds } = req.body;
  const members = normalizeMemberIds(memberIds);

  console.log(`[groups/create] accountId=${accountId} name=${name ?? '-'} members=${members.length}`);

  if (!accountId || members.length === 0) {
    console.warn('[groups/create] 400 — missing required fields');
    return res.status(400).json({ error: 'accountId, memberIds[] required' });
  }

  const session = resolveSession(res, 'groups/create', accountId);
  if (!session) return;

  try {
    const options = { members };
    if (name != null && name !== '') options.name = String(name);
    const result = await withRetry(
      () => session.api.createGroup(options),
      'groups/create-zalo'
    );
    const newGroupId = result?.groupId != null ? String(result.groupId) : undefined;
    const errorMembers = Array.isArray(result?.errorMembers) ? result.errorMembers : [];
    console.log(`[groups/create] OK — groupId=${newGroupId ?? '-'} errorMembers=${errorMembers.length}`);
    res.json({ ok: true, groupId: newGroupId, errorMembers });
  } catch (err) {
    console.error(`[groups/create] 500 — ${err?.message}`);
    res.status(500).json({ error: humanizeSendError(err), code: err?.name });
  }
});

export default router;
