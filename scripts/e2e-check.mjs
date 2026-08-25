// Kiểm end-to-end: dựng upstream giả (đúng contract NextX Comm) + chạy service đã build,
// rồi đo hành vi thật qua HTTP. KHÔNG cần .NET, không cần tài khoản Zalo.
//
// Cái này kiểm được, và cái này KHÔNG:
//   ✔ service gọi đúng endpoint sessions của upstream, kèm đúng header X-System-Key
//   ✔ service đọc được DTO phiên của comm (externalId/displayName/cookiesBase64/imei/userAgent)
//   ✔ upstream chết/401 thì service vẫn khởi động, không sập
//   ✔ mã trạng thái của các route khi chưa có phiên nào
//   ✘ luồng tin thật (cần người quét QR bằng app Zalo) — không giả được
//
// Chạy: node scripts/e2e-check.mjs

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SYSTEM_KEY = 'test-key';
const MOCK_PORT = 5099;
const SVC_PORT = 3199;
const BASE = `http://127.0.0.1:${SVC_PORT}`;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// Một phiên giả đúng shape ZaloPersonalSessionDto của comm. cookiesBase64 là base64 của một
// mảng JSON hợp lệ nhưng KHÔNG phải cookies Zalo thật → login sẽ thất bại, và đó chính là
// điều cần đo: service phải chịu được thất bại đó mà không sập.
const fakeSession = {
  externalId: '198202235016560549',
  displayName: 'Tài khoản kiểm thử',
  cookiesBase64: Buffer.from(JSON.stringify([{ name: 'zpsid', value: 'khong-phai-that' }])).toString('base64'),
  imei: '00000000-0000-4000-8000-000000000000-abcdef',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TestAgent/1.0',
};

const mockLog = [];
const svcLog = [];
let mock, svc;

const sessionsFile = join(tmpdir(), `zca-e2e-sessions-${process.pid}.json`);
writeFileSync(sessionsFile, JSON.stringify([fakeSession]), 'utf8');

function startMock() {
  return new Promise((resolve) => {
    mock = spawn(process.execPath, ['scripts/mock-upstream.mjs', String(MOCK_PORT)], {
      env: { ...process.env, SYSTEM_KEY, MOCK_SESSIONS: sessionsFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    mock.stdout.on('data', (d) => {
      const s = d.toString();
      mockLog.push(s);
      if (s.includes('đang chạy ở')) resolve();
    });
    mock.stderr.on('data', (d) => mockLog.push(d.toString()));
  });
}

function startService() {
  return new Promise((resolve) => {
    svc = spawn(process.execPath, ['dist/index.js'], {
      env: {
        ...process.env,
        PORT: String(SVC_PORT),
        SYSTEM_KEY,
        UPSTREAM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
        // Trỏ đúng đường của NextX Comm để chứng minh phần cấu hình hoạt động.
        UPSTREAM_WEBHOOK_PATH: '/api/v1/comm/webhook/zalo-personal',
        UPSTREAM_SESSIONS_PATH: '/api/v1/comm/channels/zalo-personal/internal/sessions',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    svc.stdout.on('data', (d) => {
      const s = d.toString();
      svcLog.push(s);
      if (s.includes('running on')) resolve();
    });
    svc.stderr.on('data', (d) => svcLog.push(d.toString()));
  });
}

async function req(method, path, body) {
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await resp.json();
  } catch { /* có route trả 204 rỗng */ }
  return { status: resp.status, json };
}

try {
  console.log('\n── Dựng upstream giả + service ──────────────────────────────');
  await startMock();
  await startService();

  // Đợi vòng khôi phục chạy xong. index.ts hoãn 2s rồi mới gọi, và zca-js còn phải đi tới
  // Zalo thật để nhận lỗi cookies — chờ theo ĐIỀU KIỆN chứ không phải một mốc thời gian đoán.
  const restoreDone = await (async () => {
    for (let i = 0; i < 60; i++) {
      const t = svcLog.join('');
      if (t.includes('Session restored') || t.includes('Failed to restore')) return true;
      await sleep(500);
    }
    return false;
  })();
  if (!restoreDone) console.log('  (cảnh báo: vòng khôi phục chưa kết thúc trong 30s)');

  console.log('\n── Contract với upstream ────────────────────────────────────');
  const mockText = mockLog.join('');
  check(
    'service gọi ĐÚNG endpoint sessions của comm',
    mockText.includes('GET sessions'),
    mockText.includes('GET sessions') ? '' : 'mock không nhận được request nào',
  );
  check(
    'gửi kèm X-System-Key hợp lệ (không bị 401)',
    !mockText.includes('401 sessions'),
    mockText.includes('401 sessions') ? 'upstream từ chối — thiếu/sai key' : '',
  );
  const svcText = svcLog.join('');
  check(
    'đọc được DTO phiên của comm (externalId + displayName)',
    svcText.includes('Got 1 session(s)') && svcText.includes(fakeSession.displayName),
    svcText.includes('Got 1 session(s)') ? '' : 'service không parse được danh sách phiên',
  );
  const stillAlive = (await req('GET', '/health')).status === 200;
  check(
    'cookies sai thì thất bại GỌN, service không sập',
    svcText.includes('Failed to restore') && stillAlive,
    svcText.includes('Failed to restore') ? '' : 'không thấy log thất bại khôi phục',
  );

  console.log('\n── Health ───────────────────────────────────────────────────');
  const health = await req('GET', '/health');
  check('GET /health → 200 {status:ok}', health.status === 200 && health.json?.status === 'ok');

  console.log('\n── Mã trạng thái khi CHƯA có phiên ──────────────────────────');
  const cases = [
    ['GET /contacts/:id (không có phiên)', 'GET', '/contacts/khong-co-that', null, 404],
    ['GET /sessions/:id/health (không có phiên)', 'GET', '/sessions/khong-co-that/health', null, 200],
    ['GET /sessions/:token/status (token lạ)', 'GET', '/sessions/token-la/status', null, 404],
    ['POST /messages/send-text thiếu field', 'POST', '/messages/send-text', { accountId: 'x' }, 400],
    ['POST /messages/send-text không có phiên', 'POST', '/messages/send-text', { accountId: 'x', recipientId: 'y', content: 'hi' }, 404],
    ['GET /friends thiếu accountId', 'GET', '/friends', null, 400],
    ['GET /friends/aliases không có phiên (best-effort)', 'GET', '/friends/aliases?accountId=x', null, 200],
    ['POST /groups/create thiếu memberIds', 'POST', '/groups/create', { accountId: 'x' }, 400],
    ['DELETE /sessions/:id luôn 204', 'DELETE', '/sessions/khong-co-that', null, 204],
    ['GET /stickers thiếu accountId', 'GET', '/stickers', null, 400],
  ];
  for (const [name, method, path, body, want] of cases) {
    const r = await req(method, path, body);
    check(`${name} → ${want}`, r.status === want, r.status === want ? '' : `nhận ${r.status}`);
  }

  console.log('\n── /sessions/:id/health khi không có phiên ─────────────────');
  const h = await req('GET', '/sessions/khong-co-that/health');
  check(
    'trả healthy=false + reason=no_session',
    h.json?.healthy === false && h.json?.reason === 'no_session',
    JSON.stringify(h.json),
  );

  console.log('\n── Best-effort: /friends/aliases KHÔNG BAO GIỜ lỗi ─────────');
  const al = await req('GET', '/friends/aliases?accountId=khong-co-that');
  check('trả { items: [] } thay vì 404/503', Array.isArray(al.json?.items) && al.json.items.length === 0);
} finally {
  svc?.kill();
  mock?.kill();
  await sleep(300);
  try { rmSync(sessionsFile, { force: true }); } catch { /* best-effort */ }
}

const failed = results.filter((r) => !r.ok);
console.log('\n────────────────────────────────────────────────────────────');
console.log(`KẾT QUẢ: ${results.length - failed.length}/${results.length} đạt`);
if (failed.length > 0) {
  console.log('\nKHÔNG ĐẠT:');
  for (const f of failed) console.log(`  ✘ ${f.name} ${f.detail}`);
  process.exit(1);
}
