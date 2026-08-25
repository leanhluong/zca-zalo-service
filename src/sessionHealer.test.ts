import test from 'node:test';
import assert from 'node:assert/strict';
import type { HealerFn } from './sessionHealer.js';
import { setHealer, healAccount, cancelHealing } from './sessionHealer.js';

const ACC = '198202235016560549';

/** Chờ tới khi cond() đúng hoặc hết hạn — healer chạy trong setTimeout nên phải đợi. */
async function until(cond: () => boolean, timeoutMs = 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

test.beforeEach(() => cancelHealing(ACC));

test('không có healer thì không lên lịch (không ném)', () => {
  setHealer(null as unknown as HealerFn);
  assert.equal(healAccount(ACC, { code: 1006 }), false);
});

test('cạn lượt sau 3 lần đăng nhập lại thất bại — không quay vòng vô hạn', async () => {
  let calls = 0;
  setHealer(async () => { calls++; return false; });   // cookies chết: lần nào cũng thất bại

  for (let i = 1; i <= 3; i++) {
    assert.equal(healAccount(ACC, { code: 1006, delayMsOverride: 1 }), true, `lần ${i} phải được lên lịch`);
    assert.ok(await until(() => calls === i), `lần ${i} phải chạy xong`);
  }

  // Lần 4: đã dùng hết MAX_ATTEMPTS → từ chối. Đây là chốt chặn quan trọng nhất của file này:
  // phiên bị Zalo đá thì cookies không bao giờ dùng lại được, thử mãi chỉ đốt CPU và log.
  assert.equal(healAccount(ACC, { code: 1006, delayMsOverride: 1 }), false, 'lần 4 phải bị chặn');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 3, 'không được gọi thêm lần nào');
});

test('đăng nhập lại thành công thì reset bộ đếm', async () => {
  let calls = 0;
  setHealer(async () => { calls++; return true; });

  healAccount(ACC, { code: 1006, delayMsOverride: 1 });
  assert.ok(await until(() => calls === 1));

  // Sống lại → lượt được trả về đầy đủ, lần chết sau vẫn còn đủ 3 lần tự chữa.
  assert.equal(healAccount(ACC, { code: 1006, delayMsOverride: 1 }), true);
  assert.ok(await until(() => calls === 2));
});

test('đang có lượt chờ thì không lên lịch chồng', () => {
  setHealer(async () => true);

  assert.equal(healAccount(ACC, { code: 1006, delayMsOverride: 5000 }), true);
  // WS có thể phát 'closed' nhiều lần liên tiếp — không được biến thành N lần login song song.
  assert.equal(healAccount(ACC, { code: 1006, delayMsOverride: 5000 }), false);
  cancelHealing(ACC);
});

test('healer ném lỗi cũng không làm sập tiến trình', async () => {
  let calls = 0;
  setHealer(async () => { calls++; throw new Error('login failed'); });

  healAccount(ACC, { code: 3000, delayMsOverride: 1 });
  assert.ok(await until(() => calls === 1));
  // Tới được đây nghĩa là lỗi đã bị nuốt đúng chỗ (unhandled rejection sẽ giết tiến trình test).
});
