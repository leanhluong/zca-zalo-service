import crypto from 'crypto';
import { Zalo } from 'zca-js';
import { createSession, updateSession, adoptSession } from './sessionStore.js';
import { registerListener } from './listener.js';
import { imageMetadataGetter } from './imageMeta.js';

// Replicate zca-js generateZaloUUID: randomUUID + MD5(userAgent)
function generateZaloUUID(userAgent) {
  return crypto.randomUUID() + '-' + crypto.createHash('md5').update(userAgent).digest('hex');
}

const UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL ?? 'http://localhost:5000';
// Endpoint upstream trả danh sách phiên cần khôi phục (kèm cookies). Đổi được bằng env.
const SESSIONS_PATH = process.env.UPSTREAM_SESSIONS_PATH ?? '/api/v1/channels/zalo-personal/internal/sessions';
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0";

// Toàn bộ listener + đường push về upstream nằm ở listener.js — dùng CHUNG với đường login QR
// (routes/sessions.js). Trước đây mỗi file giữ một bản chép riêng và hai bản trôi lệch nhau:
// bản QR thiếu 5/9 listener và thiếu lưới đỡ avatar thành viên nhóm, bản restore thiếu
// getUserInfo fallback cho tin 1-1.

async function restoreOneSession(session) {
  const { externalId, displayName, cookiesBase64, imei: storedImei, userAgent: storedUserAgent } = session;
  try {
    const cookies = JSON.parse(Buffer.from(cookiesBase64, 'base64').toString('utf8'));
    // Phải dùng đúng imei + userAgent từ lúc login QR — Zalo xác thực bằng imei
    const imei = storedImei ?? generateZaloUUID(USER_AGENT);
    const userAgent = storedUserAgent ?? USER_AGENT;
    const zalo = new Zalo({ selfListen: true, imageMetadataGetter });
    console.log(`[restore] Restoring session for ${displayName} (${externalId}) imei=${imei?.slice(0, 8)}...`);
    const api = await zalo.login({ cookie: cookies, imei, userAgent });

    // Dùng externalId làm qrToken key trong store
    const storeKey = `restored_${externalId}`;
    createSession(storeKey, zalo, externalId);
    updateSession(storeKey, { api, status: 'confirmed', accountId: externalId, displayName });
    // Phiên vừa restore là phiên hợp lệ duy nhất của account — dọn entry cũ nếu có (bình thường
    // Map rỗng lúc khởi động, nhưng restore có thể được gọi lại nên không được để tồn đọng).
    adoptSession(storeKey, externalId);

    registerListener(api, externalId, { tag: 'restore' });
    console.log(`[restore] ✅ Session restored: ${displayName} (${externalId})`);
    return true;
  } catch (err) {
    console.error(`[restore] ❌ Failed to restore ${displayName} (${externalId}):`, err?.message);
    return false;
  }
}

/** Đọc danh sách phiên cần khôi phục từ upstream. Trả mảng rỗng khi upstream không trả lời. */
async function fetchSessionsFromUpstream() {
  const url = `${UPSTREAM_BASE_URL}${SESSIONS_PATH}`;
  const resp = await fetch(url, {
    headers: { 'X-System-Key': process.env.SYSTEM_KEY ?? '' },
  });
  if (!resp.ok) {
    console.warn(`[restore] upstream returned ${resp.status}`);
    return [];
  }
  return await resp.json();
}

export async function restoreSessionsFromUpstream() {
  console.log(`[restore] Fetching sessions from ${UPSTREAM_BASE_URL}...`);
  try {
    const sessions = await fetchSessionsFromUpstream();
    console.log(`[restore] Got ${sessions.length} session(s) to restore`);
    for (const s of sessions) {
      await restoreOneSession(s);
    }
  } catch (err) {
    console.warn(`[restore] Cannot reach upstream (${err?.message}) — skip restore, wait for manual QR login`);
  }
}

/**
 * Đăng nhập lại ĐÚNG MỘT tài khoản bằng cookies đang lưu ở upstream — dùng cho tự chữa khi
 * WebSocket đóng hẳn (sessionHealer.js). Trả true nếu phiên đã sống lại.
 *
 * Cookies có thể đã bị Zalo vô hiệu (khách đăng nhập Zalo PC nơi khác = đá phiên này). Khi đó
 * `zalo.login` ném lỗi và hàm trả false — healer đếm lượt rồi dừng, không quay vòng vô ích.
 */
export async function restoreAccountById(externalId) {
  try {
    const sessions = await fetchSessionsFromUpstream();
    const target = sessions.find((s) => String(s.externalId) === String(externalId));
    if (!target) {
      console.warn(`[restore] Không tìm thấy cookies cho account ${externalId} ở upstream — không tự chữa được`);
      return false;
    }
    return await restoreOneSession(target);
  } catch (err) {
    console.warn(`[restore] restoreAccountById(${externalId}) lỗi:`, err?.message);
    return false;
  }
}
