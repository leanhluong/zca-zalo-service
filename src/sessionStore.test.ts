import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSession, updateSession, getSession,
  getSessionByAccountId, deleteSession, adoptSession, listSessions,
  markWsState, touchSession,
} from './sessionStore.js';
import type { SessionRecord } from './types.js';

const ACC = '627753538911129647';

// Test gắn thêm `tag` để phân biệt các phiên trong cùng account — KHÔNG phải field của
// production. Listener giả cũng chỉ có `stop()`: đủ cho việc đang kiểm, nên ép kiểu ở đây
// thay vì dựng cả đối tượng Listener thật của zca-js.
type TaggedSession = SessionRecord & { tag?: string };

/** Lấy phiên và khẳng định nó tồn tại — test tự dựng nên null nghĩa là test sai. */
function must(s: SessionRecord | null): TaggedSession {
  assert.ok(s, 'phiên phải tồn tại');
  return s as TaggedSession;
}

// Dựng 1 entry giống hệt đường login QR / restore: createSession rồi updateSession gắn accountId.
function seed(
  key: string,
  accountId: string,
  { createdAt, tag }: { createdAt?: number; tag?: string } = {},
): string {
  createSession(key, null, null);
  updateSession(key, {
    api: { listener: { stop() { stopped.push(tag ?? key); } } },
    status: 'confirmed',
    accountId,
    tag,
  } as unknown as Partial<SessionRecord>);
  if (createdAt != null) updateSession(key, { createdAt });
  return key;
}

let stopped: string[] = [];
test.beforeEach(() => {
  // Dọn phiên sót của test trước RỒI mới reset `stopped` — deleteSession cũng gọi listener.stop().
  for (const s of listSessions()) if (s.accountId) deleteSession(s.accountId);
  stopped = [];
});

test('getSessionByAccountId trả phiên MỚI NHẤT, không phải phiên đầu tiên', () => {
  seed('restored_' + ACC, ACC, { createdAt: 1000, tag: 'cu' });
  seed('qr-moi',          ACC, { createdAt: 2000, tag: 'moi' });

  // Trước fix: hàm trả entry đầu tiên (phiên cũ đã bị Zalo vô hiệu hoá) → send-text 500
  // "zpw_sek bị thiếu hoặc không đúng" trong khi listener phiên mới vẫn nhận tin bình thường.
  assert.equal(must(getSessionByAccountId(ACC)).tag, 'moi');
});

test('deleteSession xoá TẤT CẢ phiên của account và dừng listener', () => {
  seed('a', ACC, { createdAt: 1000, tag: 'a' });
  seed('b', ACC, { createdAt: 2000, tag: 'b' });
  seed('khac', '999', { createdAt: 3000, tag: 'khac' });

  deleteSession(ACC);

  assert.equal(getSessionByAccountId(ACC), null);
  assert.deepEqual(stopped.sort(), ['a', 'b']);
  assert.equal(must(getSessionByAccountId('999')).tag, 'khac', 'không đụng account khác');
});

test('adoptSession giữ phiên vừa login, dọn mọi phiên cũ cùng account', () => {
  seed('cu-1',   ACC, { createdAt: 1000, tag: 'cu-1' });
  seed('cu-2',   ACC, { createdAt: 2000, tag: 'cu-2' });
  seed('vua-qr', ACC, { createdAt: 3000, tag: 'vua-qr' });

  const dropped = adoptSession('vua-qr', ACC);

  assert.equal(dropped, 2);
  assert.deepEqual(stopped.sort(), ['cu-1', 'cu-2']);
  assert.ok(getSession('vua-qr'), 'phiên vừa login phải còn');
  assert.equal(must(getSessionByAccountId(ACC)).tag, 'vua-qr');
});

test('adoptSession không đụng phiên của account khác', () => {
  seed('cua-toi', ACC,  { createdAt: 1000, tag: 'cua-toi' });
  seed('cua-nguoi-khac', '999', { createdAt: 1000, tag: 'khac' });

  adoptSession('cua-toi', ACC);

  assert.equal(must(getSessionByAccountId('999')).tag, 'khac');
  assert.deepEqual(stopped, []);
});

// ── Trạng thái WebSocket ────────────────────────────────────────────────────
// Sự cố 20/08/2026: WS của một tài khoản đóng lúc 14:49 và im 1h53 làm mất 3 tin của khách,
// nhưng /health vẫn trả healthy=true vì store không giữ gì về đường truyền thật.

test('phiên mới tạo mặc định wsAlive=false, chưa có lastEventAt', () => {
  seed('moi', ACC, { createdAt: 1000 });
  const s = must(getSessionByAccountId(ACC));
  assert.equal(s.wsAlive, false);
  assert.equal(s.lastEventAt, null);
});

test('markWsState ghi mã đóng vào ĐÚNG phiên mới nhất của account', () => {
  seed('cu',  ACC, { createdAt: 1000, tag: 'cu' });
  seed('moi', ACC, { createdAt: 2000, tag: 'moi' });

  markWsState(ACC, { wsAlive: false, lastCloseCode: 3000, lastCloseReason: 'DuplicateConnection' });

  assert.equal(must(getSessionByAccountId(ACC)).lastCloseCode, 3000);
  assert.equal(must(getSession('cu')).lastCloseCode, null, 'phiên cũ không bị ghi đè');
});

test('touchSession đánh dấu phiên còn thở', () => {
  seed('moi', ACC, { createdAt: 1000 });
  markWsState(ACC, { wsAlive: false });

  touchSession(ACC);

  const s = must(getSessionByAccountId(ACC));
  assert.equal(s.wsAlive, true);
  assert.ok((s.lastEventAt ?? 0) > 0, 'phải đóng dấu thời điểm nhận sự kiện');
});

test('markWsState với account không tồn tại trả false, không ném', () => {
  assert.equal(markWsState('khong-co-that', { wsAlive: true }), false);
});
