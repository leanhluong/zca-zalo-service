// userProfile.ts — đọc profile người dùng từ kết quả zca-js `getUserInfo`.
//
// Vì sao có file này: `getUserInfo` trả về **object có khoá theo userId**, không phải mảng:
//
//     { changed_profiles: { "8240816636307180606": { zaloName, avatar, ... } }, unchanged_profiles: {...} }
//
// `routes/friends.ts` đọc đúng (`info.changed_profiles[userId]`) nên chạy tốt — prod trả về 188
// bạn kèm đủ tên. Nhưng `listener.ts` (2 chỗ) và `routes/users.ts` lại đọc `info.data` như MẢNG.
// `info.data` không tồn tại ⇒ `.find()` trên undefined ⇒ profile = null, **luôn luôn**, kể cả với
// bạn bè. Không ném lỗi, không log gì bất thường — chỉ lặng lẽ trả tên rỗng.
//
// Hậu quả đo được trên prod 01/08/2026 (Thái Anh Beauty): mọi tin MÌNH chủ động gửi đi đều ghi
// `recipientName=null`, nên liên hệ tạo ra mang tên "Zalo 189727..." — nhân viên không nhận ra là
// ai và báo là "hội thoại bị mất". 19/96 liên hệ 1-1 của workspace đó đang mang tên tạm này.
//
// Chiều KHÁCH NHẮN VÀO không lộ lỗi vì Zalo nhúng sẵn tên người gửi trong payload
// (`msg.data.dName`), nên nhánh getUserInfo hiếm khi được dùng tới.

import type { UserProfile, ZaloRaw } from './types.js';

/**
 * Gom mọi profile trong kết quả getUserInfo về một Map userId → profile thô.
 *
 * Chấp nhận cả 3 shape đã gặp:
 *   - `{ changed_profiles: {...}, unchanged_profiles: {...} }` — shape thật của zca-js hiện tại
 *   - `{ data: [...] }` — shape các chỗ cũ giả định
 *   - mảng trực tiếp — phòng bản zca-js khác
 *
 * @param info - giá trị trả về của `api.getUserInfo(...)`
 */
export function collectProfiles(info: ZaloRaw): Map<string, ZaloRaw> {
  const out = new Map<string, ZaloRaw>();
  if (!info) return out;

  const addKeyed = (obj: ZaloRaw): void => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    for (const [key, value] of Object.entries(obj)) {
      if (value && typeof value === 'object') out.set(String(key), value);
    }
  };
  const addList = (arr: ZaloRaw): void => {
    if (!Array.isArray(arr)) return;
    for (const p of arr) {
      if (!p || typeof p !== 'object') continue;
      const id = p.userId ?? p.uid ?? p.user_id;
      if (id !== undefined && id !== null) out.set(String(id), p);
    }
  };

  addKeyed(info.changed_profiles);
  addKeyed(info.unchanged_profiles);
  addList(info.data);
  addList(info.profiles);
  addList(info);

  return out;
}

/**
 * Lấy tên + ảnh đại diện của MỘT người từ kết quả getUserInfo.
 *
 * Khớp đúng theo `userId`. KHÔNG lấy bừa phần tử đầu khi không khớp — các chỗ cũ dùng
 * `?? profiles[0]`, hỏng ngầm khi gọi theo lô: người A có thể nhận tên của người B.
 *
 * @param info - giá trị trả về của `api.getUserInfo(...)`
 * @param userId - id cần tra
 * @returns cả hai field null nếu không tìm thấy
 */
export function extractUserProfile(info: ZaloRaw, userId: string | number): UserProfile {
  const profile = collectProfiles(info).get(String(userId));
  if (!profile) return { displayName: null, avatarUrl: null };

  const displayName =
    profile.zaloName ?? profile.displayName ?? profile.dName ??
    profile.name ?? profile.fullName ?? null;

  const avatarUrl =
    profile.avatar ?? profile.avatarSm ?? profile.avt ?? profile.avatarUrl ??
    profile.avatar_url ?? profile.thumbnailUrl ?? profile.bigAvt ?? null;

  return { displayName, avatarUrl };
}
