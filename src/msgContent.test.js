import test from 'node:test';
import assert from 'node:assert/strict';
import { parseContentAndAttachments } from './msgContent.js';

// Dựng message zca-js tối thiểu. extra dùng cho isSelf khi test nhật ký cuộc gọi.
const msg = (msgType, content, extra = {}) => ({ data: { msgType, content }, ...extra });

// Bộ mẫu dùng chung cho kiểm thử bất biến (Task 3 dùng lại).
export const SAMPLES = [
  ['văn bản',        msg('webchat', 'chào shop')],
  ['danh thiếp',     msg('chat.recommended', { phone: '0389754831', caption: 'Nguyễn Văn A', action: 'recommened.user' })],
  ['cuộc gọi nhỡ',   msg('chat.recommended', { title: 'sendBubbleMessage', params: JSON.stringify({ callId: '123', callType: '1', duration: 0, callStatus: 'missed' }) })],
  ['vị trí',         msg('chat.location.new', { lat: 10.7769, lng: 106.7009, address: '123 Nguyễn Huệ, Q1' })],
  ['ảnh',            msg('chat.photo', { href: 'https://cdn.zalo/p.jpg' })],
  ['echo ảnh',       msg('chat.photo', { photoId: 99 })],
  ['tệp',            msg('share.file', { title: 'hopdong.pdf', href: 'https://cdn.zalo/f' })],
  ['ghi âm',         msg('chat.voice', { href: 'https://cdn.zalo/v.m4a' })],
  ['sản phẩm',       msg('chat.x.product', { product_name: 'Áo thun', path: 'shop/123', price: 200000, currency_unit: 'VND' })],
  ['tin hệ thống',   msg('webchat', '{"title":"Bạn đã tạo nhắc hẹn mới lúc 14:15.","action":"msginfo.actionlist"}')],
  // Payload THẬT lấy từ log sandbox 2026-08-01T02:02:42Z (khách gửi sticker mèo mặc định).
  ['sticker',        msg('chat.sticker', { id: 1, catId: 0, type: 7 })],
  ['gif',            msg('chat.gif', { title: '', description: '', href: 'https://zgif-v2.zdn.vn/a2334ca7.gif', thumb: 'https://zgif-v2.zdn.vn/t.jpg' })],
  ['link',           msg('chat.x.link', { title: 'Bài viết ABC', href: 'https://example.com/bai-viet', thumb: 'https://cdn/t.jpg' })],
  ['tệp title-only (refactor sẽ đổi)',   msg('share.file', { title: 'hopdong.pdf' })],
  ['ghi âm title-only (refactor sẽ đổi)', msg('chat.voice', { title: 'ghi âm 5 giây' })],
  ['video title-only (refactor sẽ đổi)', msg('chat.video.msg', { title: 'clip.mp4' })],
];

test('văn bản thường giữ nguyên', () => {
  const r = parseContentAndAttachments(msg('webchat', 'chào shop'));
  assert.equal(r.content, 'chào shop');
  assert.deepEqual(r.attachments, []);
});

test('danh thiếp thật → [Danh thiếp] + contactCard', () => {
  const r = parseContentAndAttachments(
    msg('chat.recommended', { phone: '0389754831', caption: 'Nguyễn Văn A', action: 'recommened.user' }));
  assert.equal(r.content, '[Danh thiếp] Nguyễn Văn A 0389754831');
  assert.deepEqual(r.contactCard, { name: 'Nguyễn Văn A', phone: '0389754831' });
  assert.deepEqual(r.attachments, []);
});

test('nhật ký cuộc gọi nhỡ → [Cuộc gọi thoại] Cuộc gọi nhỡ, KHÔNG phải danh thiếp', () => {
  const r = parseContentAndAttachments(
    msg('chat.recommended', { title: 'sendBubbleMessage', params: JSON.stringify({ callId: '123', callType: '1', duration: 0, callStatus: 'missed' }) }));
  assert.equal(r.content, '[Cuộc gọi thoại] Cuộc gọi nhỡ');
  assert.equal(r.contactCard, undefined);
});

test('vị trí → [Vị trí] + location', () => {
  const r = parseContentAndAttachments(
    msg('chat.location.new', { lat: 10.7769, lng: 106.7009, address: '123 Nguyễn Huệ, Q1' }));
  assert.equal(r.content, '[Vị trí] 123 Nguyễn Huệ, Q1');
  assert.deepEqual(r.location, { lat: 10.7769, lng: 106.7009, address: '123 Nguyễn Huệ, Q1' });
});

test('ảnh → attachment image, content rỗng', () => {
  const r = parseContentAndAttachments(msg('chat.photo', { href: 'https://cdn.zalo/p.jpg' }));
  assert.equal(r.content, '');
  assert.deepEqual(r.attachments, [
    { type: 'image', url: 'https://cdn.zalo/p.jpg', fileName: 'photo.jpg', mimeType: 'image/jpeg' },
  ]);
});

test('echo ảnh tự gửi (object không có href) → [Hình ảnh]', () => {
  const r = parseContentAndAttachments(msg('chat.photo', { photoId: 99 }));
  assert.equal(r.content, '[Hình ảnh]');
  assert.deepEqual(r.attachments, []);
});

test('tệp → attachment file, tên + mime suy từ title', () => {
  const r = parseContentAndAttachments(msg('share.file', { title: 'hopdong.pdf', href: 'https://cdn.zalo/f' }));
  assert.deepEqual(r.attachments, [
    { type: 'file', url: 'https://cdn.zalo/f', fileName: 'hopdong.pdf', mimeType: 'application/pdf' },
  ]);
});

test('ghi âm → attachment audio', () => {
  const r = parseContentAndAttachments(msg('chat.voice', { href: 'https://cdn.zalo/v.m4a' }));
  assert.equal(r.attachments[0].mimeType, 'audio/mp4');
  assert.equal(r.attachments[0].type, 'audio');
});

test('share sản phẩm không có href → [Sản phẩm] kèm tên, giá, link', () => {
  const r = parseContentAndAttachments(
    msg('chat.x.product', { product_name: 'Áo thun', path: 'shop/123', price: 200000, currency_unit: 'VND' }));
  assert.equal(r.content, '[Sản phẩm] Áo thun - 200000 VND — https://catalog.zalo.me/shop/123');
});

test('sticker → attachment ảnh dựng từ id, KHÔNG phải [Sản phẩm]', () => {
  const r = parseContentAndAttachments(msg('chat.sticker', { id: 1, catId: 0, type: 7 }));
  assert.equal(r.content, '');
  assert.deepEqual(r.attachments, [{
    type: 'image',
    url: 'https://zalo-api.zadn.vn/api/emoticon/sticker/webpc?eid=1',
    fileName: 'sticker-1.png',
    mimeType: 'image/png',
  }]);
});

test('sticker id lệch shape → [Nhãn dán], KHÔNG dựng URL rác và KHÔNG mất tin', () => {
  for (const bad of [{ catId: 0, type: 7 }, { id: 'abc', catId: 0 }, { id: 0, catId: 0 }]) {
    const r = parseContentAndAttachments(msg('chat.sticker', bad));
    assert.equal(r.content, '[Nhãn dán]');
    assert.deepEqual(r.attachments, []);
  }
});

// Payload THẬT (sandbox 2026-08-01T02:48:57Z): keys=title,description,href,thumb,childnumber,
// action,params,type — Zalo gửi title RỖNG. Thiếu case 'chat.gif' thì rơi xuống nhánh default:
// type 'file', fileName '' (vì `??` không bắt chuỗi rỗng), mime application/octet-stream.
test('GIF → attachment ảnh động, KHÔNG phải file tải về', () => {
  const r = parseContentAndAttachments(
    msg('chat.gif', { title: '', description: '', href: 'https://zgif-v2.zdn.vn/a2334ca7.gif', thumb: 'https://zgif-v2.zdn.vn/t.jpg' }));
  assert.equal(r.content, '');
  assert.deepEqual(r.attachments, [{
    type: 'image',
    url: 'https://zgif-v2.zdn.vn/a2334ca7.gif',
    fileName: 'animation.gif',
    mimeType: 'image/gif',
  }]);
});

test('object chỉ có catId → không còn bị coi là share sản phẩm', () => {
  const r = parseContentAndAttachments(msg('chat.x.unknown', { catId: 3 }));
  assert.notEqual(r.content, '[Sản phẩm]');
  assert.ok(r.content.length > 0);
});

test('tin hệ thống (chuỗi JSON có action) → lấy title làm content', () => {
  const r = parseContentAndAttachments(
    msg('webchat', '{"title":"Bạn đã tạo nhắc hẹn mới lúc 14:15.","action":"msginfo.actionlist"}'));
  assert.equal(r.content, 'Bạn đã tạo nhắc hẹn mới lúc 14:15.');
});

// Ba test dưới đây khoá hành vi HIỆN TẠI của nhánh "text fallback" (msgContent.js dòng
// 520-522): khi content là object KHÔNG có href/thumb, hàm ưu tiên field text người-đọc-được
// (title/text/description/caption/msg) TRƯỚC KHI xét mediaLabelByType theo msgType (dòng
// 527-537). Refactor msgType-dispatch SẮP TỚI dự kiến trả nhãn theo msgType TRƯỚC và không
// đọc `title` nữa — nghĩa là 3 test này sẽ ĐỎ sau refactor. Đó là điều CỐ Ý: chúng tồn tại
// để refactor phải chạm và cập nhật đúng 3 nhánh này, không phải bug.
test('share.file title-only (không href/thumb) → giữ nguyên title, KHÔNG phải [Tệp tin]', () => {
  const r = parseContentAndAttachments(msg('share.file', { title: 'hopdong.pdf' }));
  assert.equal(r.content, 'hopdong.pdf');
  assert.deepEqual(r.attachments, []);
});

test('chat.voice title-only (không href/thumb) → giữ nguyên title, KHÔNG phải [Tin nhắn thoại]', () => {
  const r = parseContentAndAttachments(msg('chat.voice', { title: 'ghi âm 5 giây' }));
  assert.equal(r.content, 'ghi âm 5 giây');
  assert.deepEqual(r.attachments, []);
});

test('chat.video.msg title-only (không href/thumb) → giữ nguyên title, KHÔNG phải [Video]', () => {
  const r = parseContentAndAttachments(msg('chat.video.msg', { title: 'clip.mp4' }));
  assert.equal(r.content, 'clip.mp4');
  assert.deepEqual(r.attachments, []);
});

test('BẤT BIẾN: mọi mẫu đều có content hoặc attachment — content rỗng + 0 attachment = upstream nuốt tin', () => {
  for (const [name, sample] of SAMPLES) {
    const r = parseContentAndAttachments(sample);
    assert.ok(
      (typeof r.content === 'string' && r.content.length > 0) || r.attachments.length > 0,
      `mẫu "${name}" vi phạm bất biến: content rỗng và không attachment`,
    );
  }
});
