# API Reference — zca-zalo-service

Tài liệu đầy đủ cho toàn bộ API của service. Mọi mô tả dưới đây đọc thẳng từ mã nguồn
(`src/routes/`, `src/listener.js`), không phải từ đặc tả mong muốn.

- **Base URL mặc định:** `http://localhost:3100`
- **Content-Type:** `application/json` cho mọi request có body
- **Xác thực vào service:** **không có**. Service không kiểm tra bất kỳ header nào của request
  đến. Xem [Bảo mật](#bảo-mật) trước khi mở ra ngoài mạng nội bộ.
- **Xác thực khi service gọi ra:** header `X-System-Key` lấy từ env `SYSTEM_KEY`.

---

## Mục lục

1. [Khái niệm cốt lõi](#1-khái-niệm-cốt-lõi)
2. [Vòng đời sử dụng](#2-vòng-đời-sử-dụng)
3. [Quy ước chung](#3-quy-ước-chung)
4. [Kiểu dữ liệu dùng lại](#4-kiểu-dữ-liệu-dùng-lại)
5. [Health](#5-health)
6. [Sessions — phiên đăng nhập](#6-sessions--phiên-đăng-nhập)
7. [Messages — gửi tin](#7-messages--gửi-tin)
8. [Stickers](#8-stickers)
9. [Sync — đồng bộ lịch sử](#9-sync--đồng-bộ-lịch-sử)
10. [Contacts & Users](#10-contacts--users)
11. [Friends — bạn bè](#11-friends--bạn-bè)
12. [Groups — nhóm](#12-groups--nhóm)
13. [Webhook service GỬI RA](#13-webhook-service-gửi-ra)
14. [Endpoint upstream PHẢI cung cấp](#14-endpoint-upstream-phải-cung-cấp)
15. [Giới hạn đã biết](#15-giới-hạn-đã-biết)
16. [Bảo mật](#bảo-mật)

---

## 1. Khái niệm cốt lõi

| Khái niệm | Nghĩa |
|---|---|
| `accountId` | **Own-ID Zalo** của tài khoản đã đăng nhập (`api.getOwnId()`). Đây là khoá định danh phiên trong mọi endpoint. KHÔNG phải số điện thoại. |
| `qrToken` | Mã tạm của một lượt quét QR. Chỉ dùng cho `/sessions/init-qr` và `/sessions/:qrToken/status`. Sau khi đăng nhập xong thì chuyển sang dùng `accountId`. |
| `threadId` | ID hội thoại: userId (chat 1-1) hoặc groupId (chat nhóm). |
| `threadType` | `"User"` (1-1, mặc định) hoặc `"Group"`. Truyền sai → tin đi nhầm loại hội thoại. |
| `msgId` | `gMsgID` — ID tin toàn cục của Zalo. |
| `cliMsgId` | ID phía client, Zalo bắt buộc phải có khi thu hồi / thả cảm xúc. Service cache lại từ tin đến; xem [409](#3-quy-ước-chung). |
| upstream | Hệ thống của bạn — nơi service đẩy tin đến về và nơi service lấy phiên để khôi phục. |

**Phiên nằm trong RAM.** Restart service là mất hết phiên đang giữ; service sẽ tự gọi upstream
lấy cookies để đăng nhập lại (xem [mục 14](#14-endpoint-upstream-phải-cung-cấp)). Nếu upstream
không cung cấp endpoint đó thì sau mỗi lần restart phải quét QR lại.

---

## 2. Vòng đời sử dụng

```
1. POST /sessions/init-qr              → nhận ảnh QR + qrToken
2. Người dùng quét QR bằng app Zalo
3. GET  /sessions/:qrToken/status      → poll đến khi status = "confirmed"
                                          ⇒ nhận accountId + cookiesEncrypted (LƯU LẠI!)
4. Dùng accountId cho mọi API còn lại
5. Tin đến tự chảy về upstream qua webhook (mục 13)
```

Bước 3 trả `cookiesEncrypted`, `imei`, `userAgent` — **upstream phải lưu bộ ba này**, đó là thứ
duy nhất cho phép khôi phục phiên sau restart mà không quét QR lại.

---

## 3. Quy ước chung

### Mã trạng thái

| Mã | Nghĩa | Nên làm gì |
|---|---|---|
| `200` | Thành công | — |
| `204` | Thành công, không có body (chỉ `DELETE /sessions/:accountId`) | — |
| `400` | Thiếu tham số bắt buộc hoặc giá trị không hợp lệ | Sửa request; retry vô ích |
| `404` | Không tìm thấy phiên, hoặc phiên chưa `confirmed` | Đăng nhập lại |
| `409` | Thiếu `cliMsgId` nên không thu hồi / thả cảm xúc được | Truyền `cliMsgId` trực tiếp |
| `422` | Request hợp lệ nhưng không thực hiện được (không có text để forward, không tra được sticker) | Đổi cách gọi |
| `500` | Lỗi từ Zalo hoặc lỗi nội bộ | Xem `error` |
| `503` | Phiên tồn tại nhưng `api` chưa sẵn sàng (đang đăng nhập dở) | Chờ rồi thử lại |
| `504` | **Timeout khi chờ Zalo.** Chỉ có ở nhóm `/messages` | Coi là TRANSIENT — ghi outbox + retry có backoff |

Phân biệt `500` và `504` là cố ý: `504` nghĩa là chưa biết tin đã đi hay chưa, đáng retry;
`500` thường là lỗi cố định.

### Hình dạng lỗi

Không đồng nhất giữa các nhóm — đây là thực tế của mã, không phải mô tả lý tưởng:

```jsonc
{ "error": "..." }                        // đa số
{ "error": "...", "code": "ZaloApiError" }// nhóm media + groups
{ "ok": false, "error": "..." }           // nhóm friends
{ "ok": false, "reason": "..." }          // send-typing, send-seen (kèm HTTP 200)
```

### Ba endpoint không bao giờ báo lỗi

Cố ý nuốt lỗi để không chặn luồng chat — phải kiểm `ok` trong body, không thể chỉ nhìn HTTP:

| Endpoint | Khi lỗi trả về |
|---|---|
| `POST /messages/send-typing` | `200 { ok: false, reason }` |
| `POST /messages/send-seen` | `200 { ok: false, reason }` |
| `GET /friends/aliases` | `200 { items: [] }` |

### Timeout

| Loại | Ngưỡng |
|---|---|
| Text / react / undo | 15s |
| Media (ảnh, file, video, voice, sticker) | 20s, retry tối đa 3 lần với backoff 300ms → 600ms |
| Đợi Zalo trả lịch sử (`/sync`) | 15s → trả `synced: 0` |
| Thăm dò sức khoẻ phiên | 6s |

Timeout **không** được retry ở tầng service (retry ngay cũng treo tiếp) — nó trả `504` để
upstream tự xếp hàng retry.

---

## 4. Kiểu dữ liệu dùng lại

### Attachment

Xuất hiện trong payload webhook inbound.

```jsonc
{
  "type": "image" | "file" | "video" | "audio",
  "url": "https://...",          // link Zalo CDN
  "fileName": "photo.jpg",
  "mimeType": "image/jpeg"
}
```

Sticker được quy về `type: "image"` với `fileName: "sticker-<id>.png"`.

### Quote (trả lời / trích dẫn)

Các field này nằm **phẳng** trong payload webhook, không lồng trong object con:

```jsonc
{
  "replyToMsgId": "123456789",
  "replyToSnippet": "nội dung tin gốc, cắt ngắn",  // null nếu tin gốc là media
  "replyToSenderName": "Nguyễn Văn A"              // null nếu Zalo không gửi kèm
}
```

### Mention

```jsonc
[{ "uid": "123", "offset": 0, "length": 5, "name": "Tên" }]
```

`offset`/`length` tính theo ký tự trong `content`. `name` **thường không có** — Zalo không gửi
kèm. Chỉ có hiệu lực với `threadType: "Group"`; Zalo bỏ qua mention trong chat 1-1.

### ContactCard / Location

```jsonc
{ "contactCard": { "name": "...", "phone": "...", "avatarUrl": "..." } }
{ "location":    { "lat": 10.77, "lng": 106.69, "address": "..." } }
```

### GroupMember

```jsonc
{ "uid": "123", "name": "Tên thành viên", "avatar": "https://..." }
```

---

## 5. Health

### `GET /health`

Kiểm tra process còn sống. **Không** phản ánh sức khoẻ phiên Zalo — muốn biết phiên có nhận
được tin không thì dùng [`GET /sessions/:accountId/health`](#get-sessionsaccountidhealth).

**Response `200`**

```json
{ "status": "ok" }
```

---

## 6. Sessions — phiên đăng nhập

### `POST /sessions/init-qr`

Sinh mã QR để đăng nhập. Chờ tối đa 30s để Zalo trả QR.

**Body**

| Field | Kiểu | Bắt buộc | Mô tả |
|---|---|---|---|
| `tempAccountId` | string | Không | Nhãn tạm của bạn để đối chiếu trước khi biết `accountId` thật |

**Response `200`**

```jsonc
{
  "qrImageUrl": "data:image/png;base64,iVBORw0...",  // nhúng thẳng vào <img src>
  "qrToken": "a1b2c3d4...",                          // dùng cho bước poll status
  "expiresIn": 600
}
```

**Lỗi:** `500` — Zalo không trả QR trong 30s.

> Việc đăng nhập chạy nền sau khi endpoint này trả về. Quét QR xong thì `status` mới chuyển
> `confirmed`; phải poll endpoint dưới.

---

### `GET /sessions/:qrToken/status`

Poll tiến trình đăng nhập. Nên gọi mỗi 2s.

**Response `200`**

```jsonc
{
  "status": "waiting" | "confirmed" | "expired" | "failed" | "error",
  "accountId": "1982022350165...",   // chỉ có khi confirmed
  "displayName": "Tên tài khoản",
  "avatarUrl": "https://...",
  "cookiesEncrypted": "eyJ...",      // base64 của JSON cookies — PHẢI LƯU
  "imei": "uuid-md5hash",            // PHẢI LƯU
  "userAgent": "Mozilla/5.0 ...",    // PHẢI LƯU
  "phone": "0912345678"              // best-effort, có thể null
}
```

| `status` | Nghĩa |
|---|---|
| `waiting` | Vừa tạo QR, chưa ai quét (trạng thái khởi tạo) |
| `confirmed` | Đăng nhập xong — `accountId` và cookies đã sẵn sàng |
| `expired` | Mã QR hết hạn |
| `failed` / `error` | Lỗi trong quá trình đăng nhập |

**Lỗi:** `404` — `qrToken` không tồn tại hoặc đã hết hạn.

> Phiên còn `waiting` quá **10 phút** bị dọn khỏi bộ nhớ, sau đó poll sẽ nhận `404`. Hết hạn thì
> gọi lại `/sessions/init-qr` để lấy QR mới.

> `cookiesEncrypted` chỉ là **base64, không mã hoá** dù tên gọi như vậy. Đối xử với nó như
> mật khẩu: ai có nó là đăng nhập được vào Zalo của người dùng.

---

### `GET /sessions/:accountId/health`

Trả lời câu hỏi "phiên này có **thực sự** nhận được tin không". Không chỉ đọc cờ trong RAM mà
gọi thật một lệnh nhẹ (`keepAlive`) lên Zalo — đây là cách duy nhất phát hiện phiên đã bị Zalo
đá (người dùng đăng nhập Zalo PC ở máy khác).

**Response `200` — phiên chưa đăng ký**

```json
{ "healthy": false, "registered": false, "wsAlive": false, "reason": "no_session" }
```

`reason` là `"no_session"` hoặc `"status=<trạng thái>"`.

**Response `200` — phiên đã đăng ký**

```jsonc
{
  "healthy": true,               // kết quả thăm dò THẬT lên Zalo
  "registered": true,
  "wsAlive": true,               // trạng thái WebSocket theo listener
  "lastEventAt": 1735689600000,  // epoch ms sự kiện Zalo gần nhất
  "secondsSinceLastEvent": 12,
  "lastCloseCode": null,
  "lastCloseReason": null,
  "probeError": null             // có nội dung khi healthy=false
}
```

> **Cách đọc:** `healthy=false` mà `wsAlive=true` ⇒ cookies đã chết dù WebSocket chưa kịp đóng
> — cần quét QR lại. `secondsSinceLastEvent` lớn bất thường ⇒ phiên có thể đang chết câm.

---

### `GET /sessions/:accountId/groups`

Liệt kê mọi nhóm của tài khoản.

**Response `200`**

```jsonc
{
  "groups": [
    { "groupId": "123", "name": "Nhóm A", "avatar": "https://...", "memberCount": 25 }
  ]
}
```

**Lỗi:** `404` không có phiên · `503` phiên chưa sẵn sàng · `500` lỗi Zalo.

> `name`, `avatar`, `memberCount` có thể là `null` khi Zalo không trả thông tin cho nhóm đó
> (service lấy id nhóm trước rồi mới enrich theo lô 50 — lô nào lỗi thì nhóm trong lô đó thiếu
> thông tin nhưng vẫn có mặt trong danh sách).

---

### `GET /sessions/:accountId/groups/:groupId/members`

Thành viên của một nhóm, kèm tên và avatar.

**Response `200`**

```jsonc
{
  "members": [{ "uid": "123", "name": "Tên", "avatar": "https://..." }],
  "memberCount": 25,             // số thành viên THẬT từ Zalo
  "groupAvatar": "https://...",
  "groupName": "Nhóm A"
}
```

> `members` có thể **rỗng trong khi `memberCount` > 0** — zca-js hay không trả `memberIds`.
> Dùng `memberCount` để hiển thị số lượng, đừng lấy `members.length`.

---

### `POST /sessions/:accountId/reaction`

Thả cảm xúc lên một tin.

> **Chỉ hoạt động cho chat 1-1** — endpoint này hardcode `ThreadType.User`. Với tin trong nhóm
> phải dùng [`POST /messages/react`](#post-messagesreact).

**Body**

| Field | Kiểu | Bắt buộc | Mô tả |
|---|---|---|---|
| `threadId` | string | ✅ | ID hội thoại |
| `msgId` | string | ✅ | Tin muốn thả cảm xúc |
| `reactionType` | string | ✅ | **Chỉ nhận mã Zalo thô**, ví dụ `"/-heart"`. Không nhận `"HEART"`. |

**Response `200`**

```json
{ "reactionId": "987654321" }
```

**Lỗi:** `400` thiếu field hoặc `reactionType` không hợp lệ · `404` · `503` · `500`.

---

### `DELETE /sessions/:accountId`

Xoá phiên khỏi bộ nhớ. **Luôn trả `204`**, kể cả khi phiên không tồn tại.

> Đây là xoá phía service, **không đăng xuất khỏi Zalo**. Cookies đã lưu ở upstream vẫn dùng
> lại được.

---

## 7. Messages — gửi tin

Mọi endpoint trong nhóm này đều nhận `threadType` (`"User"` mặc định, hoặc `"Group"`) và đều có
thể trả `504` khi Zalo không kịp trả lời.

### `POST /messages/send-text`

**Body**

| Field | Kiểu | Bắt buộc | Mô tả |
|---|---|---|---|
| `accountId` | string | ✅ | |
| `recipientId` | string | ✅ | userId hoặc groupId |
| `content` | string | ✅ | Không được rỗng |
| `threadType` | string | Không | `"User"` \| `"Group"` |
| `mentions` | array | Không | `[{ uid, offset, length }]` — chỉ có tác dụng với nhóm |
| `quoteMsgId` | string | Không | `msgId` tin muốn trả lời |

**Response `200`**

```json
{ "messageId": "123456789" }
```

> `quoteMsgId` là **best-effort**: tin gốc phải còn trong cache RAM. Cache miss (tin cũ, service
> vừa restart) thì tin vẫn được gửi nhưng **không có trích dẫn**, và không có lỗi nào báo cho
> bạn biết. Kiểm log dòng `quoteMsgId=... not in cache` nếu cần chắc chắn.

---

### `POST /messages/send-image`

Service tải `fileUrl` về file tạm rồi mới đẩy lên Zalo (Zalo yêu cầu đường dẫn file cục bộ).

**Body**

| Field | Kiểu | Bắt buộc | Mô tả |
|---|---|---|---|
| `accountId` | string | ✅ | |
| `recipientId` | string | ✅ | |
| `fileUrl` | string | ✅ | URL công khai truy cập được từ service |
| `caption` | string | Không | Chú thích kèm ảnh |
| `threadType` | string | Không | |

**Response `200`:** `{ "messageId": "..." }`

**Lỗi:** `504` timeout · `500` kèm `error` đã Việt hoá:
- `"Ảnh/tệp vượt giới hạn Zalo (tối đa N MB)"`
- `"Định dạng tệp không được Zalo cho phép"`

---

### `POST /messages/send-file`

Giống `send-image`, thêm `fileName` (tuỳ chọn) để giữ đúng đuôi file — Zalo phân loại
attachment theo đuôi nên sai đuôi có thể làm tệp hiển thị sai loại.

**Response `200`:** `{ "messageId": "..." }`

---

### `POST /messages/send-video`

> Khác `send-image`/`send-file`: **không tải file về**. `fileUrl` được đưa thẳng cho Zalo, nên
> URL bắt buộc phải công khai và cho phép request `HEAD`.

**Body**

| Field | Kiểu | Bắt buộc | Mặc định |
|---|---|---|---|
| `accountId`, `threadId`, `fileUrl` | string | ✅ | |
| `thumbUrl` | string | Không | `""` |
| `caption` | string | Không | |
| `duration` | number | Không | |
| `width` / `height` | number | Không | Zalo tự suy nếu thiếu |
| `threadType` | string | Không | `"User"` |

**Response `200`:** `{ "ok": true, "messageId": "..." }`

---

### `POST /messages/send-voice`

Cũng dùng URL trực tiếp. Nên là `.m4a`.

**Body:** `accountId` ✅, `threadId` ✅, `fileUrl` ✅, `threadType`

**Response `200`:** `{ "ok": true, "messageId": "..." }`

---

### `POST /messages/send-sticker`

**Body**

| Field | Kiểu | Bắt buộc | Mô tả |
|---|---|---|---|
| `accountId`, `threadId` | string | ✅ | |
| `stickerId` | number | ✅ | |
| `cateId` | number | Không | Thiếu → service tự tra qua Zalo |
| `type` | number | Không | Thiếu → service tự tra qua Zalo |
| `threadType` | string | Không | |

**Response `200`:** `{ "ok": true, "messageId": "..." }`

**Lỗi:** `422 { error, code: "STICKER_DETAIL_MISSING" }` — không tra được `cateId`/`type`.

---

### `POST /messages/undo`

Thu hồi tin **của chính mình**.

**Body**

| Field | Kiểu | Bắt buộc | Mô tả |
|---|---|---|---|
| `accountId` | string | ✅ | |
| `msgId` | string | ✅ | |
| `threadId` | string | ✅ | Chấp nhận cả tên cũ `recipientId` |
| `cliMsgId` | string | Khuyến nghị | Thiếu → tra cache RAM |
| `threadType` | string | Không | |

**Response `200`:** `{ "ok": true }`

**Lỗi:** `409 { error: "message not undoable (missing cliMsgId)" }` — không có `cliMsgId` ở cả
body lẫn cache.

> **Nên luôn truyền `cliMsgId`.** Cache nằm trong RAM nên restart là mất; sau đó mọi lệnh thu
> hồi tin cũ đều `409`. Nếu upstream lưu `cliMsgId` lúc nhận webhook thì không bao giờ gặp lỗi này.

---

### `POST /messages/react`

Thả / bỏ cảm xúc. Linh hoạt hơn `POST /sessions/:accountId/reaction` — hỗ trợ cả nhóm.

**Body**

| Field | Kiểu | Bắt buộc | Mô tả |
|---|---|---|---|
| `accountId`, `threadId`, `msgId` | string | ✅ | |
| `icon` | string | Không | Nhận **cả hai dạng**: tên (`"HEART"`, `"LIKE"`, không phân biệt hoa thường) hoặc mã thô (`"/-heart"`). Bỏ trống / `""` / `"NONE"` ⇒ **gỡ cảm xúc**. |
| `cliMsgId` | string | Khuyến nghị | Thiếu → tra cache |
| `threadType` | string | Không | |

**Response `200`:** `{ "ok": true, "messageId": "..." }` (`messageId` có thể vắng)

**Lỗi:** `400` icon không nhận diện được · `409` thiếu `cliMsgId`.

---

### `POST /messages/forward`

Chuyển tiếp **nội dung text** tới nhiều đích.

> **Chỉ forward được text.** Zalo không cho forward attachment theo `msgId`. Muốn chuyển tiếp
> ảnh/tệp thì gọi lại `/send-image` hoặc `/send-file` với URL của tệp đó.

**Body**

| Field | Kiểu | Bắt buộc | Mô tả |
|---|---|---|---|
| `accountId` | string | ✅ | |
| `targets` | array | ✅ | `[{ threadId, threadType? }]` — mỗi đích có thể khác loại |
| `content` | string | Không¹ | Nội dung muốn chuyển tiếp |
| `msgId` | string | Không¹ | Dùng để tra nội dung từ cache khi không truyền `content` |

¹ Phải có ít nhất một trong hai, và phải ra được text.

**Response `200`** (hoặc `500` nếu **mọi** đích đều lỗi — vẫn có body này):

```jsonc
{
  "ok": true,
  "results": [
    { "threadId": "123", "messageId": "456", "ok": true },
    { "threadId": "789", "ok": false, "error": "..." }
  ]
}
```

**Lỗi:** `422` không có text để forward · `400` `targets` rỗng hoặc thiếu `threadId`.

> `ok: true` chỉ nghĩa là **ít nhất một** đích thành công. Luôn phải duyệt `results`.

---

### `POST /messages/send-typing`

Báo "đang soạn tin".

**Body:** `accountId` ✅, `threadId` ✅, `threadType`
**Response:** `200 { ok: true }` — lỗi cũng trả `200 { ok: false, reason }`.

---

### `POST /messages/send-seen`

Đánh dấu đã xem.

**Body:** `accountId` ✅, `threadId` ✅, `msgIds` (mảng), `threadType`
**Response:** `200 { ok: true }`

Thiếu `msgIds` → `200 { ok: false, reason: "no msgIds provided" }`.

---

## 8. Stickers

Cùng một handler, mount ở bốn nơi cho tiện:

```
GET  /stickers          GET  /messages/stickers
POST /stickers          POST /messages/stickers
```

**Input** — nhận từ query (GET) hoặc body (POST):

| Field | Bắt buộc | Mô tả |
|---|---|---|
| `accountId` | ✅ | |
| `keyword` | Không | Bỏ trống ⇒ trả **bộ gợi ý** (service tự quét các từ khoá `hi`, `cảm ơn`, `ok`, `haha`, `yêu`, `buồn`, tối đa 48 sticker) |

**Response `200`**

```jsonc
{
  "ok": true,
  "stickers": [
    { "id": 123, "cateId": 45, "type": 1, "url": "https://.../sticker.webp" }
  ]
}
```

`url` ưu tiên bản webp động, fallback ảnh tĩnh. Ba field `id`/`cateId`/`type` chính là thứ cần
truyền cho `/messages/send-sticker`.

---

## 9. Sync — đồng bộ lịch sử

### `POST /sync/:accountId`

Kéo tin tồn đọng qua WebSocket rồi **tự đẩy về upstream** qua webhook (không trả tin trong
response).

**Body:** `lastMsgId` (string, phân trang), `threadType` (`"User"` \| `"Group"`)

**Response `200`**

```jsonc
{
  "synced": 12,           // số tin đẩy về upstream THÀNH CÔNG
  "total": 15,            // số tin Zalo trả về
  "lastMsgId": "123",     // truyền lại để lấy trang tiếp
  "hasMore": true
}
```

> **Đọc kỹ giới hạn này.** Endpoint dùng `requestOldMessages`, vốn là **hàng đợi tin chưa nhận**
> chứ không phải lịch sử hội thoại. Phiên vừa đăng nhập đã nuốt hết hàng đợi thì nó trả `0` mãi
> mãi. Đo thực tế: `threadType=User` trả 0 cả hai lần liên tiếp, `threadType=Group` trả 38.
> **Muốn lấy lịch sử nhóm thì dùng endpoint dưới.** Với chat 1-1 thì zca-js **không có** API đọc
> lịch sử — tin 1-1 mất trong lúc phiên chết là mất thật.

---

### `POST /sync/:accountId/group/:groupId`

Đọc lịch sử **thật** của một nhóm. Đây mới là endpoint nên dùng để backfill nhóm.

**Body:** `count` (number, mặc định `50`, **trần cứng 500**)

**Response `200`**

```json
{ "synced": 48, "total": 50, "hasMore": true }
```

---

## 10. Contacts & Users

### `GET /contacts/:accountId`

Danh bạ bạn bè.

**Query:** `page` (mặc định `1`), `limit` (mặc định `200`)

**Response `200`**

```jsonc
{
  "contacts": [
    { "userId": "123", "displayName": "Tên", "avatarUrl": "https://...", "phone": "09..." }
  ],
  "total": 150,     // = contacts.length của TRANG NÀY, không phải tổng toàn bộ
  "page": 1,
  "limit": 200
}
```

> `total` dễ gây hiểu nhầm: nó đếm số phần tử trang hiện tại, không phải tổng số bạn bè.

---

### `GET /users/:accountId/profile/:userId`

**Response `200`**

```json
{ "userId": "123", "displayName": "Tên", "avatarUrl": "https://..." }
```

**Lỗi:** `404` — không tra được. Thường vì **không phải bạn bè**, không phải vì user không tồn tại.

---

## 11. Friends — bạn bè

### `GET /friends`

Đầy đủ hơn `/contacts/:accountId`: có lọc từ khoá và tự bù tên/avatar còn thiếu.

**Query:** `accountId` ✅, `keyword` (lọc theo tên hoặc số điện thoại, phía service), `count`
(mặc định `1000`), `page` (mặc định `1`)

**Response `200`**

```jsonc
{
  "ok": true,
  "friends": [
    { "userId": "123", "displayName": "Tên", "avatarUrl": "https://...", "phone": "09..." }
  ]
}
```

**Lỗi:** `500 { ok: false, error }` với thông điệp đã Việt hoá: `"Đã là bạn bè"`,
`"Người dùng đã chặn hoặc bị chặn"`, `"Không tìm thấy người dùng"`,
`"Đã vượt giới hạn kết bạn của Zalo"`.

---

### `POST /friends/request`

**Body:** `accountId` ✅, `userId` ✅, `message` (mặc định `"Xin chào, kết bạn với mình nhé!"` —
Zalo bắt buộc phải có lời nhắn)

**Response `200`:** `{ "ok": true }`

---

### `POST /friends/accept`

**Body:** `accountId` ✅, `userId` ✅
**Response `200`:** `{ "ok": true }`

---

### `GET /friends/aliases`

Toàn bộ biệt danh đã đặt. Service **tự duyệt hết các trang** (gọi API trần chỉ được 100 alias đầu).

**Query:** `accountId` ✅

**Response `200`**

```json
{ "items": [{ "userId": "123", "alias": "Biệt danh" }] }
```

> **Không bao giờ trả lỗi.** Phiên chưa sẵn sàng hay Zalo lỗi đều ra `{ items: [] }` để không
> làm gãy luồng đồng bộ danh bạ. Danh sách rỗng **không** chứng minh là không có alias — muốn
> chắc phải đọc log dòng `[friends/aliases]` (có `pages=` và `stop=`).

---

### `POST /friends/alias`

**Body:** `accountId` ✅, `friendId` ✅, `alias` (chuỗi rỗng `""` ⇒ **xoá** biệt danh)
**Response `200`:** `{ "ok": true }`

---

## 12. Groups — nhóm

Cả năm endpoint đều trả lỗi dạng `500 { error, code }` và đều retry 3 lần cho lỗi chập chờn.

### `POST /groups/create`

**Body:** `accountId` ✅, `memberIds` ✅ (mảng, không rỗng), `name` (tuỳ chọn)

**Response `200`**

```jsonc
{ "ok": true, "groupId": "123", "errorMembers": ["456"] }
```

### `POST /groups/add-member` · `POST /groups/remove-member`

**Body:** `accountId` ✅, `groupId` ✅, `memberIds` ✅ (mảng hoặc một giá trị đơn đều được)

**Response `200`:** `{ "ok": true, "errorMembers": [] }`

> `ok: true` **không** nghĩa là mọi thành viên đều thành công. Luôn kiểm `errorMembers`.

### `POST /groups/rename`

**Body:** `accountId` ✅, `groupId` ✅, `name` ✅ (không rỗng)
**Response `200`:** `{ "ok": true, "status": 1 }`

### `POST /groups/avatar`

**Body:** `accountId` ✅, `groupId` ✅, `avatarUrl` ✅ (URL công khai — service tải về rồi mới đẩy lên)
**Response `200`:** `{ "ok": true }`

---

## 13. Webhook service GỬI RA

Đây là chiều ngược lại: **service POST vào hệ thống của bạn**. Upstream phải hiện thực các
endpoint dưới đây.

- **Base:** `{UPSTREAM_BASE_URL}{UPSTREAM_WEBHOOK_PATH}` (mặc định `/api/v1/webhook/zalo-personal`)
- **Header:** `Content-Type: application/json`, `X-System-Key: <SYSTEM_KEY>`
- **Kỳ vọng:** trả `2xx`. Trả khác thì service chỉ ghi log.

| Đường dẫn | Sự kiện |
|---|---|
| *(gốc, không hậu tố)* | Tin nhắn đến / tự gửi |
| `/reaction` | Ai đó thả cảm xúc |
| `/recall` | Ai đó thu hồi tin |
| `/typing` | Đang soạn tin |
| `/receipt` | Đã nhận / đã xem |
| `/group-event` | Biến động nhóm |
| `/friend-event` | Biến động bạn bè |

> ⚠️ **Fire-and-forget.** Không hàng đợi, không retry. Upstream restart hoặc trả 5xx đúng lúc đó
> là **mất tin vĩnh viễn** — Zalo không gửi lại như webhook chính thức. Upstream nên nhận nhanh,
> ghi vào hàng đợi của mình, rồi mới xử lý.

### Tin đến — POST tới đường gốc

Chat 1-1:

```jsonc
{
  "accountId": "198202235016560549",
  "senderId": "123456789",        // đối phương (cả khi mình gửi đi)
  "content": "Xin chào",
  "attachments": [],
  "msgId": "987654321",
  "direction": "In",              // "In" nhận | "Out" tự gửi từ điện thoại
  "senderName": "Nguyễn Văn A",
  "senderAvatar": "https://...",
  "timestamp": 1735689600000,
  // các field tuỳ chọn: replyToMsgId, replyToSnippet, replyToSenderName,
  //                     mentions, contactCard, location
}
```

Chat nhóm — thêm bốn field và `senderId` đổi nghĩa:

```jsonc
{
  "accountId": "...",
  "senderId": "999888",           // ⚠️ là groupId, KHÔNG phải người gửi
  "senderName": "Tên nhóm",
  "senderAvatar": "https://...",  // avatar nhóm
  "threadType": "Group",
  "memberSenderId": "123",        // người thật sự gửi
  "memberSenderName": "Trần B",
  "memberSenderAvatar": "https://...",
  "content": "...", "attachments": [], "msgId": "...",
  "direction": "In", "timestamp": 1735689600000
}
```

> Trong tin nhóm, `senderId` là **groupId** — nó đóng vai "hội thoại". Người gửi thật nằm ở
> `memberSenderId`. Nhầm chỗ này là mọi tin nhóm đều mang tên nhóm làm tên người gửi.
>
> **`msgId` có thể trùng.** Service đẩy tin từ nhiều đường (realtime, catch-up lúc khởi động,
> `/sync`). Upstream **phải khử trùng theo `msgId`**.

### `/reaction`

```jsonc
{ "accountId": "...", "threadId": "123", "reactedMsgId": "456",
  "reactionType": "/-heart", "reactorId": "789", "isSelf": false }
```

### `/recall`

```jsonc
{ "accountId": "...", "recalledMsgId": "456", "threadId": "123" }
```

### `/typing`

```jsonc
{ "accountId": "...", "threadId": "123", "threadType": 0, "isTyping": true }
```

`threadType` ở đây là **số** (`0` = User, `1` = Group), khác với chuỗi `"User"`/`"Group"` ở API vào.

### `/receipt`

```jsonc
{ "accountId": "...", "threadId": "123", "threadType": 0,
  "kind": "delivered" | "seen", "msgIds": ["456", "789"], "ts": 1735689600000 }
```

Nhiều tin cùng hội thoại được gom vào một lần gọi.

### `/group-event`

```jsonc
{
  "accountId": "...",
  "groupId": "999",
  "type": "join",         // join, leave, remove_member, block_member, update,
                          // update_avatar, add_admin, remove_admin, update_setting,
                          // new_link, join_request, ...
  "subType": 1,
  "act": "...",           // mã thô từ Zalo
  "actorId": "123",       // người thực hiện
  "targetIds": ["456"],   // người bị tác động
  "groupName": "Nhóm A",
  "isSelf": false,
  "raw": { },             // nguyên payload Zalo, để dự phòng
  "timestamp": 1735689600000
}
```

### `/friend-event`

```jsonc
{
  "accountId": "...",
  "type": "ADD",          // ADD, REMOVE, REQUEST, UNDO_REQUEST, REJECT_REQUEST,
                          // SEEN_FRIEND_REQUEST, BLOCK, UNBLOCK, BLOCK_CALL, UNBLOCK_CALL, ...
  "userId": "123",
  "message": "Lời nhắn kèm lời mời",   // chỉ có với type REQUEST
  "isSelf": false,
  "raw": { },
  "timestamp": 1735689600000
}
```

---

## 14. Endpoint upstream PHẢI cung cấp

Để phiên tự khôi phục sau restart (không phải quét QR lại), upstream cần expose:

```
GET {UPSTREAM_BASE_URL}{UPSTREAM_SESSIONS_PATH}
```

mặc định `/api/v1/channels/zalo-personal/internal/sessions`, nhận header `X-System-Key`.

**Phải trả về mảng:**

```jsonc
[
  {
    "externalId": "198202235016560549",   // = accountId
    "displayName": "Tên tài khoản",
    "cookiesBase64": "eyJ...",            // đúng chuỗi lấy từ /sessions/:qrToken/status
    "imei": "uuid-md5hash",
    "userAgent": "Mozilla/5.0 ..."
  }
]
```

Ba field `cookiesBase64`, `imei`, `userAgent` phải là **đúng bộ** lấy lúc đăng nhập — Zalo xác
thực theo `imei`, lệch một cái là khôi phục thất bại.

Upstream không trả lời thì service vẫn khởi động bình thường, chỉ là chờ quét QR thủ công.

---

## 15. Giới hạn đã biết

| Giới hạn | Hệ quả | Cách sống chung |
|---|---|---|
| Webhook fire-and-forget | Upstream 5xx / restart ⇒ **mất tin vĩnh viễn** | Upstream nhận nhanh, ghi hàng đợi rồi mới xử lý |
| Phiên nằm trong RAM | Restart mất hết phiên | Hiện thực endpoint ở [mục 14](#14-endpoint-upstream-phải-cung-cấp) |
| Cache `cliMsgId` trong RAM | Sau restart, thu hồi/thả cảm xúc tin cũ trả `409` | Upstream lưu `cliMsgId` và truyền vào |
| Cache quote trong RAM | Trả lời tin cũ mất trích dẫn, **âm thầm** | Chấp nhận, hoặc kiểm log |
| Không đọc được lịch sử chat 1-1 | Tin 1-1 mất lúc phiên chết là mất thật | Ưu tiên giữ phiên sống hơn là backfill |
| Zalo chỉ cho 1 phiên PC/web | Người dùng đăng nhập Zalo PC nơi khác ⇒ phiên này bị đá | Theo dõi `/sessions/:accountId/health` |
| Forward chỉ được text | Không chuyển tiếp được ảnh/tệp | Gọi lại `/send-image`, `/send-file` |
| API Zalo cá nhân không chính thức | Zalo đổi là gãy | Ghim phiên bản `zca-js`, thử lại sau khi nâng |

**Tự chữa khi rớt phiên:** WebSocket đóng thì zca-js tự nối lại; hết lượt thì service tự đăng
nhập lại bằng cookies (tối đa 3 lần cho mỗi lần chết). Cookies bị Zalo thu hồi thì máy không cứu
được — lúc đó `/sessions/:accountId/health` trả `healthy: false` và cần người quét QR lại.

---

## Bảo mật

Ba điểm phải xử lý trước khi đưa lên môi trường thật:

1. **Service không xác thực request đến.** Bất kỳ ai gọi được `http://host:3100` là đọc được
   danh bạ và gửi tin dưới danh nghĩa tài khoản Zalo đó. **Đừng expose ra Internet** — đặt sau
   reverse proxy có xác thực, hoặc giới hạn ở mạng nội bộ. `SYSTEM_KEY` chỉ bảo vệ chiều
   service → upstream, không bảo vệ chiều ngược lại.

2. **`cookiesEncrypted` không hề được mã hoá** — chỉ là base64. Ai có nó là chiếm được phiên
   Zalo. Lưu ở upstream thì phải mã hoá khi lưu trữ.

3. **Log không chứa nội dung tin** (cố ý — chỉ ghi độ dài và tên field), nhưng **có chứa
   `userId`, `groupId`, `msgId` và URL tệp đính kèm**. Xử lý log như dữ liệu cá nhân.
