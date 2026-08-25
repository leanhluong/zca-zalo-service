import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllAliases } from './aliasList.js';

// API giả: trả `total` alias, chia trang theo count zca-js truyền vào.
// Ghi lại mọi (count, page) đã gọi để khẳng định có phân trang thật.
interface FakeCall {
  count: number;
  page: number;
}

function fakeApi(total: number, { failFromPage = null }: { failFromPage?: number | null } = {}) {
  const calls: FakeCall[] = [];
  return {
    calls,
    getAliasList: async (count: number, page: number) => {
      calls.push({ count, page });
      if (failFromPage !== null && page >= failFromPage) throw new Error('zalo rate limit');
      const start = (page - 1) * count;
      const items: Array<{ userId: string; alias: string }> = [];
      for (let i = start; i < Math.min(start + count, total); i += 1) {
        items.push({ userId: String(1000 + i), alias: `alias-${i}` });
      }
      return { items, updateTime: '0' };
    },
  };
}

const OPTS = { pageSize: 100, delayMs: 0 };

test('lấy hết alias khi vượt 1 trang (bug prod: chỉ được 100 đầu)', async () => {
  const api = fakeApi(356);
  const r = await fetchAllAliases(api, OPTS);

  assert.equal(r.items.length, 356);
  assert.equal(r.pagesRead, 4);
  assert.equal(r.stopReason, 'complete');
  assert.deepEqual(
    api.calls.map((c) => c.page),
    [1, 2, 3, 4],
  );
  // count PHẢI được truyền — gọi trần là rơi về mặc định 100 của zca-js
  assert.ok(api.calls.every((c) => c.count === 100));
});

test('dừng ngay khi trang đầu chưa đầy', async () => {
  const api = fakeApi(56);
  const r = await fetchAllAliases(api, OPTS);

  assert.equal(r.items.length, 56);
  assert.equal(r.pagesRead, 1);
  assert.equal(r.stopReason, 'complete');
});

test('trang cuối vừa đúng page size → không gọi thừa vô hạn', async () => {
  const api = fakeApi(200);
  const r = await fetchAllAliases(api, OPTS);

  assert.equal(r.items.length, 200);
  // trang 3 rỗng là điều kiện dừng (raw.length < pageSize)
  assert.equal(r.pagesRead, 3);
  assert.equal(r.stopReason, 'complete');
});

test('chạm trần số trang → báo page-cap, không loop vô tận', async () => {
  const api = fakeApi(10_000);
  const r = await fetchAllAliases(api, { ...OPTS, maxPages: 3 });

  assert.equal(r.items.length, 300);
  assert.equal(r.pagesRead, 3);
  assert.equal(r.stopReason, 'page-cap');
});

test('lỗi giữa chừng vẫn giữ các trang đã lấy', async () => {
  const api = fakeApi(500, { failFromPage: 3 });
  const r = await fetchAllAliases(api, OPTS);

  assert.equal(r.items.length, 200); // 2 trang đầu
  assert.equal(r.stopReason, 'page-error');
});

test('lỗi ngay trang đầu thì ném ra (caller tự best-effort)', async () => {
  const api = fakeApi(500, { failFromPage: 1 });
  await assert.rejects(() => fetchAllAliases(api, OPTS), /zalo rate limit/);
});

test('dedupe theo userId khi trang chồng nhau', async () => {
  const page = { items: [{ userId: '1', alias: 'A' }, { userId: '1', alias: 'B' }] };
  const r = await fetchAllAliases({ getAliasList: async () => page }, { pageSize: 2, delayMs: 0 });

  assert.deepEqual(r.items, [{ userId: '1', alias: 'A' }]); // bản đầu thắng
});

test('chấp nhận shape mảng trần và {data:[]}', async () => {
  const flat = await fetchAllAliases(
    { getAliasList: async () => [{ uid: '7', name: 'Bảy' }] },
    { pageSize: 100, delayMs: 0 },
  );
  assert.deepEqual(flat.items, [{ userId: '7', alias: 'Bảy' }]);

  const wrapped = await fetchAllAliases(
    { getAliasList: async () => ({ data: [{ user_id: '8', alias: 'Tám' }] }) },
    { pageSize: 100, delayMs: 0 },
  );
  assert.deepEqual(wrapped.items, [{ userId: '8', alias: 'Tám' }]);
});

test('bỏ qua bản ghi thiếu userId', async () => {
  const r = await fetchAllAliases(
    { getAliasList: async () => ({ items: [{ alias: 'mồ côi' }, { userId: '9', alias: 'Chín' }] }) },
    { pageSize: 100, delayMs: 0 },
  );
  assert.deepEqual(r.items, [{ userId: '9', alias: 'Chín' }]);
});
