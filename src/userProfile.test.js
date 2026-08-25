import test from 'node:test';
import assert from 'node:assert/strict';
import { collectProfiles, extractUserProfile } from './userProfile.js';

// Shape THẬT của zca-js getUserInfo — suy ra từ cách routes/friends.js đọc, đường duy nhất chạy
// đúng trên prod (trả về 188 bạn kèm đủ tên).
const realShape = {
  changed_profiles: {
    '8240816636307180606': { userId: '8240816636307180606', zaloName: 'Trang nv cs2', avatar: 'https://a/1.jpg' },
    '91252683452540455': { userId: '91252683452540455', zaloName: 'Lili', avatar: 'https://a/2.jpg' },
  },
  unchanged_profiles: {
    '2362425954378074794': { userId: '2362425954378074794', displayName: 'Thuỳ Dương', avatarSm: 'https://a/3.jpg' },
  },
};

// Ca đã hỏng trên prod: trước 01/08 listener.js đọc `info.data` như MẢNG, mà getUserInfo trả object
// có khoá ⇒ luôn null ⇒ mọi tin mình gửi đi mất tên người nhận ⇒ liên hệ mang tên "Zalo 824081...".
test('đọc được shape thật của zca-js (object có khoá)', () => {
  assert.deepEqual(extractUserProfile(realShape, '8240816636307180606'), {
    displayName: 'Trang nv cs2',
    avatarUrl: 'https://a/1.jpg',
  });
});

test('đọc được cả unchanged_profiles, không chỉ changed_profiles', () => {
  assert.deepEqual(extractUserProfile(realShape, '2362425954378074794'), {
    displayName: 'Thuỳ Dương',
    avatarUrl: 'https://a/3.jpg',
  });
});

test('vẫn đọc được shape mảng mà code cũ giả định (phòng bản zca-js khác)', () => {
  const listShape = { data: [{ uid: '77', displayName: 'Cũ', avt: 'https://a/4.jpg' }] };
  assert.deepEqual(extractUserProfile(listShape, '77'), {
    displayName: 'Cũ',
    avatarUrl: 'https://a/4.jpg',
  });
});

// Code cũ dùng `?? profiles[0]`: gọi theo lô là gán nhầm tên người này cho người kia — hỏng âm
// thầm, tệ hơn cả trả rỗng. Khớp sai id thì phải trả null.
test('KHÔNG lấy bừa người khác khi id không khớp', () => {
  assert.deepEqual(extractUserProfile(realShape, 'khong-ton-tai'), {
    displayName: null,
    avatarUrl: null,
  });
});

test('trả null gọn gàng khi getUserInfo cho về rác', () => {
  for (const bad of [null, undefined, {}, [], 'chuỗi', 0]) {
    assert.deepEqual(extractUserProfile(bad, '1'), { displayName: null, avatarUrl: null });
  }
});

test('collectProfiles gom hết mọi nguồn về một Map', () => {
  assert.equal(collectProfiles(realShape).size, 3);
});
