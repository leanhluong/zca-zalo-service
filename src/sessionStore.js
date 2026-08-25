// In-memory store: qrToken → { api, tempAccountId, status, accountId, displayName, avatarUrl, cookiesEncrypted }
const store = new Map();

export function createSession(qrToken, api, tempAccountId) {
  store.set(qrToken, {
    api,
    tempAccountId: tempAccountId ?? null,
    status: 'waiting',
    accountId: null,
    displayName: null,
    avatarUrl: null,
    cookiesEncrypted: null,
    createdAt: Date.now(),
    // ── Trạng thái WebSocket (xem markWsState) ──
    // Trước 20/08 store KHÔNG giữ gì về đường truyền thật: /health chỉ đọc `status` +
    // `api.listener != null`, cả hai đều đúng vĩnh viễn kể cả khi WebSocket đã đóng.
    wsAlive: false,
    lastEventAt: null,      // lần cuối Zalo đẩy BẤT KỲ sự kiện nào qua WS
    lastConnectedAt: null,
    lastClosedAt: null,
    lastCloseCode: null,
    lastCloseReason: null,
  });
}

export function getSession(qrToken) {
  return store.get(qrToken) ?? null;
}

export function updateSession(qrToken, patch) {
  const s = store.get(qrToken);
  if (s) store.set(qrToken, { ...s, ...patch });
}

// Dừng listener của 1 session — best-effort, không được ném ra ngoài.
function stopListener(session, tag) {
  try {
    session?.api?.listener?.stop();
  } catch (err) {
    console.warn(`[sessionStore] ${tag}: listener.stop() failed:`, err?.message);
  }
}

// Trả session MỚI NHẤT của accountId.
//
// Một accountId có thể có NHIỀU entry: restore lúc bridge khởi động dùng key `restored_{id}`,
// mỗi lần quét QR lại thêm 1 entry key theo qrToken. Trước đây hàm này trả entry ĐẦU TIÊN
// (cũ nhất) → sau khi quét QR lại, mọi lời gọi API vẫn đi qua phiên cũ đã bị Zalo vô hiệu hoá
// ("zpw_sek bị thiếu hoặc không đúng") trong khi listener của phiên mới vẫn nhận tin bình thường
// ⇒ inbound chạy, outbound chết, quét QR lại bao nhiêu lần cũng không cứu được.
// Zalo chỉ giữ 1 phiên PC/web nên phiên mới nhất mới là phiên hợp lệ.
export function getSessionByAccountId(accountId) {
  let latest = null;
  for (const s of store.values()) {
    if (s.accountId !== accountId) continue;
    if (latest === null || (s.createdAt ?? 0) > (latest.createdAt ?? 0)) latest = s;
  }
  return latest;
}

// Key của session MỚI NHẤT của accountId — cần khi muốn updateSession theo accountId
// (listener chỉ biết accountId, không biết qrToken/storeKey).
function latestKeyOf(accountId) {
  let latestKey = null;
  let latestAt = -1;
  for (const [k, s] of store.entries()) {
    if (s.accountId !== accountId) continue;
    const at = s.createdAt ?? 0;
    if (at > latestAt) { latestAt = at; latestKey = k; }
  }
  return latestKey;
}

/**
 * Ghi trạng thái đường truyền WebSocket cho phiên mới nhất của accountId.
 *
 * Đây là NGUỒN SỰ THẬT DUY NHẤT để /health trả lời "phiên còn sống không". Trước đây không có
 * gì tương đương: WebSocket của một tài khoản chết lúc 14:49 ngày 20/08 và im tới 16:41 (đo trên
 * prod, tài khoản 198202235016560549) mà /health vẫn trả healthy=true suốt, vì nó chỉ nhìn hai
 * thứ không bao giờ đổi sau khi login: `status === 'confirmed'` và `api.listener != null`.
 */
export function markWsState(accountId, patch) {
  const key = latestKeyOf(accountId);
  if (!key) return false;
  store.set(key, { ...store.get(key), ...patch });
  return true;
}

/** Đóng dấu "vừa nhận sự kiện từ Zalo" — mọi listener gọi để /health biết phiên còn thở. */
export function touchSession(accountId) {
  return markWsState(accountId, { lastEventAt: Date.now(), wsAlive: true });
}

// Xoá TẤT CẢ entry của accountId (trước đây chỉ xoá cái đầu tiên → còn sót entry chết trong Map).
export function deleteSession(accountId) {
  for (const [k, s] of store.entries()) {
    if (s.accountId !== accountId) continue;
    stopListener(s, `deleteSession(${accountId})`);
    store.delete(k);
  }
}

// Gọi ngay sau khi login QR xong: phiên `keepQrToken` trở thành phiên duy nhất của accountId,
// mọi phiên cũ bị dừng listener + xoá khỏi Map. Không có bước này thì Map phình theo số lần
// quét QR và mỗi phiên cũ vẫn giữ 1 WebSocket sống (đẩy tin trùng, tốn kết nối).
export function adoptSession(keepQrToken, accountId) {
  let dropped = 0;
  for (const [k, s] of store.entries()) {
    if (k === keepQrToken || s.accountId !== accountId) continue;
    stopListener(s, `adoptSession(${accountId})`);
    store.delete(k);
    dropped++;
  }
  if (dropped > 0) {
    console.log(`[sessionStore] adoptSession: dropped ${dropped} stale session(s) for account ${accountId}`);
  }
  return dropped;
}

export function listSessions() {
  return Array.from(store.values()).map(s => ({
    accountId: s.accountId,
    status: s.status,
    displayName: s.displayName,
  }));
}

// Cleanup sessions older than 10 minutes that are still 'waiting'
// unref(): timer dọn rác không được giữ event loop sống — nếu không, mọi tiến trình import module
// này (vd `node --test`) sẽ treo vĩnh viễn thay vì thoát khi xong việc.
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of store.entries()) {
    if (s.status === 'waiting' && now - s.createdAt > 10 * 60 * 1000) {
      store.delete(k);
    }
  }
}, 60 * 1000).unref();
