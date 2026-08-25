import express from 'express';
import sessionsRouter from './routes/sessions.js';
import messagesRouter, { stickersHandler } from './routes/messages.js';
import contactsRouter from './routes/contacts.js';
import syncRouter from './routes/sync.js';
import usersRouter from './routes/users.js';
import groupsRouter from './routes/groups.js';
import friendsRouter from './routes/friends.js';
import { restoreSessionsFromUpstream, restoreAccountById } from './sessionRestore.js';
import { setHealer } from './sessionHealer.js';

const app = express();
const PORT = process.env.PORT ?? 3100;

app.use(express.json());

// ── Request logger middleware ──────────────────────────────────────────────
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.get('/health', (_req, res) => {
  console.log('[health] OK');
  res.json({ status: 'ok' });
});

app.use('/sessions', sessionsRouter);
app.use('/messages', messagesRouter);
// Sticker picker: alias top-level /stickers (cùng handler với /messages/stickers).
app.get('/stickers', stickersHandler);
app.post('/stickers', stickersHandler);
app.use('/sync', syncRouter);
app.use('/users', usersRouter);
app.use('/contacts', contactsRouter);
app.use('/groups', groupsRouter);
app.use('/friends', friendsRouter);

// Nạp hàm tự đăng nhập lại cho sessionHealer — làm ở đây (điểm khởi động) để listener.js không
// phải import sessionRestore.js, tránh vòng import listener ↔ sessionRestore.
setHealer(restoreAccountById);

app.listen(PORT, () => {
  console.log(`ZCA Zalo Service running on :${PORT}`);
  console.log(`UPSTREAM_BASE_URL = ${process.env.UPSTREAM_BASE_URL ?? 'http://localhost:5000 (default)'}`);

  // Tự động restore sessions từ upstream sau khi server ready
  // Delay 2s để upstream kịp start (nếu chạy cùng lúc)
  setTimeout(() => restoreSessionsFromUpstream(), 2000);
});
