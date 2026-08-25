// Upstream giả — dựng đúng contract mà NextX Comm expose, để chạy thử service này
// end-to-end mà không cần .NET, Postgres, RabbitMQ hay tài khoản Zalo thật.
//
// Contract lấy từ mã nguồn comm (đọc ngày 25/08/2026):
//   - ZaloPersonalWebhookController.cs  → 7 đường webhook nhận inbound
//   - ZaloPersonalController.cs         → GET internal/sessions cấp cookies để khôi phục
//   - GetZaloPersonalSessionsQuery.cs   → shape ZaloPersonalSessionDto
//
// Xác thực: comm fail-closed bằng X-System-Key — thiếu/sai key trả 401. Mock làm đúng như vậy,
// đó chính là thứ cần kiểm: service có gửi kèm key không.
//
// Chạy:  node scripts/mock-upstream.mjs [port]
// Env:   SYSTEM_KEY (mặc định 'test-key'), MOCK_SESSIONS=path/to/sessions.json

import http from 'node:http';
import { readFileSync } from 'node:fs';

const PORT = Number(process.argv[2] ?? process.env.MOCK_PORT ?? 5000);
const SYSTEM_KEY = process.env.SYSTEM_KEY ?? 'test-key';

// Đường comm thật dùng; service trỏ vào bằng UPSTREAM_WEBHOOK_PATH / UPSTREAM_SESSIONS_PATH.
const WEBHOOK_BASE = '/api/v1/comm/webhook/zalo-personal';
const SESSIONS_PATH = '/api/v1/comm/channels/zalo-personal/internal/sessions';

/** Phiên trả cho service khôi phục. Mặc định rỗng — không có cookies Zalo thật để dựng. */
const sessions = process.env.MOCK_SESSIONS
  ? JSON.parse(readFileSync(process.env.MOCK_SESSIONS, 'utf8'))
  : [];

/** Mọi request nhận được, để test khẳng định đường đi + payload. */
export const received = [];

function authOk(req) {
  return req.headers['x-system-key'] === SYSTEM_KEY;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // ── GET sessions để khôi phục ─────────────────────────────────────────────
  if (req.method === 'GET' && path === SESSIONS_PATH) {
    if (!authOk(req)) {
      console.log('[mock] 401 sessions — thiếu/sai X-System-Key');
      res.writeHead(401).end();
      return;
    }
    console.log(`[mock] GET sessions → ${sessions.length} phiên`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sessions));
    return;
  }

  // ── Webhook inbound ───────────────────────────────────────────────────────
  if (req.method === 'POST' && path.startsWith(WEBHOOK_BASE)) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (!authOk(req)) {
        console.log(`[mock] 401 ${path} — thiếu/sai X-System-Key`);
        res.writeHead(401).end();
        return;
      }
      const kind = path.slice(WEBHOOK_BASE.length) || '/(inbound)';
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        console.log(`[mock] ${kind} — body KHÔNG phải JSON hợp lệ`);
      }
      received.push({ kind, payload: parsed });
      // comm trả 200 ngay rồi xử lý async — mock làm giống để đo đúng hành vi service.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      console.log(`[mock] ${kind} ← ${JSON.stringify(parsed)?.slice(0, 160)}`);
    });
    return;
  }

  console.log(`[mock] 404 ${req.method} ${path}`);
  res.writeHead(404).end();
});

server.listen(PORT, () => {
  console.log(`[mock] upstream giả đang chạy ở :${PORT}`);
  console.log(`[mock]   webhook  ${WEBHOOK_BASE}[/reaction|/recall|/typing|/receipt|/group-event|/friend-event]`);
  console.log(`[mock]   sessions ${SESSIONS_PATH}`);
  console.log(`[mock]   SYSTEM_KEY=${SYSTEM_KEY}`);
});
