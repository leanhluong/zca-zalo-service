# zca-zalo-service

Backend service cung cấp API cho **Zalo cá nhân** thông qua [zca-js](https://github.com/RFS-ADRENO/zca-js).

Service đứng giữa Zalo và hệ thống của bạn (gọi là *upstream*): giữ phiên đăng nhập, lắng nghe
sự kiện realtime từ Zalo rồi đẩy về upstream qua webhook, đồng thời expose REST API để upstream
gửi tin, thao tác nhóm, quản lý bạn bè.

```
Zalo  ⇄  zca-zalo-service  ⇄  upstream (hệ thống của bạn)
          ├── webhook out: tin đến, reaction, thu hồi, typing, seen, group/friend event
          └── REST in:     gửi tin, nhóm, bạn bè, đồng bộ lịch sử
```

## Yêu cầu

- Node.js 20+
- Tài khoản Zalo cá nhân (đăng nhập bằng QR)

## Chạy local

```bash
npm ci
cp .env.example .env      # rồi điền UPSTREAM_BASE_URL, SYSTEM_KEY
npm run dev               # hoặc: npm start
```

Service lắng nghe ở `http://localhost:3100`, health check tại `GET /health`.

## Docker

```bash
docker compose up -d --build
```

## Cấu hình

Xem đầy đủ ở [`.env.example`](.env.example).

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `3100` | Port service lắng nghe |
| `UPSTREAM_BASE_URL` | `http://localhost:5000` | Base URL hệ thống nhận inbound |
| `UPSTREAM_WEBHOOK_PATH` | `/api/v1/webhook/zalo-personal` | Đường webhook nhận tin đến |
| `UPSTREAM_SESSIONS_PATH` | `/api/v1/channels/zalo-personal/internal/sessions` | Endpoint trả phiên để khôi phục |
| `SYSTEM_KEY` | — | Gửi kèm header `X-System-Key` khi gọi upstream |

Ba biến `UPSTREAM_*` cho phép cắm service vào bất kỳ hệ thống nào mà không phải sửa mã — chỉ cần
hệ đó expose endpoint nhận POST cùng payload.

## API

📘 **[Tài liệu API đầy đủ → `docs/API.md`](docs/API.md)** — mọi endpoint kèm input, output,
mã lỗi, payload webhook và các bẫy đã biết.

| Nhóm | Prefix | Nội dung chính |
|---|---|---|
| Phiên | `/sessions` | Tạo QR đăng nhập, trạng thái phiên, sức khoẻ phiên, nhóm/thành viên, reaction |
| Tin nhắn | `/messages` | Gửi text, ảnh, file, video, voice, sticker; trích dẫn, mention, thu hồi, chuyển tiếp, typing, đã xem |
| Sticker | `/stickers` | Tìm sticker + bộ gợi ý |
| Đồng bộ | `/sync` | Kéo lịch sử tin nhắn 1-1 / nhóm rồi đẩy về upstream |
| Người dùng | `/users` | Thông tin một người dùng Zalo |
| Danh bạ | `/contacts` | Danh bạ bạn bè (phân trang) |
| Nhóm | `/groups` | Tạo nhóm, thêm/xoá thành viên, đổi tên, đổi avatar |
| Bạn bè | `/friends` | Danh sách bạn, lời mời kết bạn, biệt danh |

Chiều ngược lại — service đẩy tin đến và sự kiện về hệ thống của bạn qua webhook. Payload đầy đủ
ở [mục 13 của `docs/API.md`](docs/API.md#13-webhook-service-gửi-ra).

> **Service không xác thực request đến.** Ai gọi được cổng 3100 là gửi được tin dưới danh nghĩa
> tài khoản Zalo đó — đừng expose ra Internet. Xem [phần Bảo mật](docs/API.md#bảo-mật).

## Khôi phục phiên

Lúc khởi động, service gọi `GET {UPSTREAM_BASE_URL}{UPSTREAM_SESSIONS_PATH}` để lấy cookies đã
lưu và tự đăng nhập lại — không cần quét QR sau mỗi lần restart. Upstream không trả lời thì
service vẫn chạy bình thường và chờ đăng nhập QR thủ công.

Khi Zalo đá phiên, `sessionHealer` thử tự đăng nhập lại bằng cookies đang lưu. Cookies bị Zalo
thu hồi thì không cứu được bằng máy — cần người thật quét QR lại.

## Giới hạn đã biết

- Đường đẩy inbound là **fire-and-forget**: không hàng đợi, không retry. Upstream restart hoặc
  trả 5xx đúng khoảnh khắc đó là mất tin, vì Zalo không gửi lại như webhook chính thức.
- API Zalo cá nhân là API không chính thức — Zalo đổi là có thể gãy.

## Test

```bash
npm test
```

## Giấy phép

Private.
