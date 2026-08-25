// ─────────────────────────────────────────────────────────────────────────────
// Tự khôi phục phiên Zalo khi WebSocket đóng hẳn.
//
// VÌ SAO CẦN: zca-js `listener.start()` mặc định `retryOnClose = false`. Bridge gọi đúng dạng
// không tham số đó, nên WebSocket đóng (kể cả 1006 rớt mạng) là listener CHẾT LUÔN — chỉ phát
// sự kiện `closed` mà không ai lắng nghe. Đo prod 20/08/2026: tài khoản 198202235016560549 nhận
// tin cuối lúc 14:49, im tuyệt đối 1h53 (không một dòng log, không lỗi) cho tới khi nhân viên tự
// ngắt kênh và quét QR lại lúc 16:41. Ba tin khách trong cửa sổ đó mất vĩnh viễn — Zalo KHÔNG
// gửi lại như webhook Facebook, và `requestOldMessages` chiều 1-1 luôn trả 0 nên không cứu được.
//
// Lớp phòng thủ 1 (rẻ nhất) là `retryOnClose: true` — zca-js tự nối lại theo bảng retry của nó.
// File này là lớp 2: khi zca-js đã cạn lượt retry và phát `closed`, đăng nhập LẠI bằng cookies
// đang lưu ở upstream. Cookies có thể đã bị Zalo thu hồi (đá phiên) — khi đó không cứu được bằng máy,
// nên số lần thử bị chặn cứng để không quay vòng vô ích; hết lượt thì /health trả wsAlive=false
// để upstream tự báo động cho người thật vào quét QR.
// ─────────────────────────────────────────────────────────────────────────────

/** Số lần tự đăng nhập lại tối đa cho MỘT lần chết. Hết lượt → chờ người quét QR. */
const MAX_ATTEMPTS = 3;

/** Giãn cách giữa các lần thử (ms) — thử nhanh trước, rồi lùi dần. */
const BACKOFF_MS = [30_000, 120_000, 300_000];

/** Sau khoảng này không có lần chết nào thì bộ đếm lần thử được reset. */
const RESET_AFTER_MS = 30 * 60 * 1000;

// accountId → { attempts, lastAttemptAt, running, timer }
const state = new Map();

/** Hàm đăng nhập lại thật sự — sessionRestore.js nạp vào lúc khởi động (tránh vòng import). */
let healer = null;

export function setHealer(fn) {
  healer = fn;
}

function stateOf(accountId) {
  const now = Date.now();
  let s = state.get(accountId);
  if (!s || now - (s.lastAttemptAt ?? 0) > RESET_AFTER_MS) {
    s = { attempts: 0, lastAttemptAt: 0, running: false, timer: null };
    state.set(accountId, s);
  }
  return s;
}

/** Xoá lịch tự chữa đang chờ + reset bộ đếm — gọi khi phiên đã sống lại bằng đường khác (quét QR). */
export function cancelHealing(accountId) {
  const s = state.get(accountId);
  if (!s) return;
  if (s.timer) clearTimeout(s.timer);
  state.delete(accountId);
}

/**
 * Lên lịch đăng nhập lại cho accountId. Không ném lỗi, không chặn caller.
 * Trả về true nếu đã lên lịch, false nếu hết lượt / đang chạy / chưa có healer.
 */
export function healAccount(accountId, { code = null, reason = '', delayMsOverride = null } = {}) {
  if (!accountId) return false;
  if (!healer) {
    console.warn(`[healer] chưa nạp healer — bỏ qua account=${accountId}`);
    return false;
  }

  const s = stateOf(accountId);
  if (s.running || s.timer) {
    console.log(`[healer] account=${accountId} đã có lượt tự chữa đang chờ — bỏ qua`);
    return false;
  }
  if (s.attempts >= MAX_ATTEMPTS) {
    console.error(
      `[healer] account=${accountId} ĐÃ CẠN ${MAX_ATTEMPTS} lần tự đăng nhập lại ` +
      `(code=${code} reason="${reason}") — cần người quét QR lại`);
    return false;
  }

  // delayMsOverride: chỉ dùng trong test để khỏi phải chờ 30 giây thật.
  const delay = delayMsOverride ?? BACKOFF_MS[Math.min(s.attempts, BACKOFF_MS.length - 1)];
  s.attempts++;
  s.lastAttemptAt = Date.now();
  console.warn(
    `[healer] account=${accountId} WS đóng (code=${code} reason="${reason}") — ` +
    `tự đăng nhập lại sau ${delay / 1000}s (lần ${s.attempts}/${MAX_ATTEMPTS})`);

  s.timer = setTimeout(async () => {
    s.timer = null;
    s.running = true;
    try {
      const ok = await healer(accountId);
      if (ok) {
        console.log(`[healer] account=${accountId} ✅ đăng nhập lại THÀNH CÔNG (lần ${s.attempts})`);
        state.delete(accountId);
      } else {
        console.error(`[healer] account=${accountId} ❌ đăng nhập lại thất bại (lần ${s.attempts}/${MAX_ATTEMPTS})`);
      }
    } catch (err) {
      console.error(`[healer] account=${accountId} lỗi khi đăng nhập lại:`, err?.message);
    } finally {
      s.running = false;
    }
  }, delay);
  s.timer.unref?.();
  return true;
}
