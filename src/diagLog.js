// Chẩn đoán loại tin nhắn Zalo (spec pha 1) — chỉ để trả lời 3 câu hỏi đo trước khi viết
// lại parseContentAndAttachments theo msgType (xem docs/superpowers/plans/...zalo-msgtype-dispatch.md
// bên upstream). Dùng chung cho MỌI call site inbound (message + old_messages, cả 2 file
// sessions.js và sessionRestore.js) để tránh lặp + đảm bảo cùng 1 quy tắc log.
//
// Quy tắc: CHỈ log TÊN field, KHÔNG log giá trị — nội dung tin khách là dữ liệu nhạy cảm.
//
// Ngoại lệ HẸP (được chủ dự án duyệt): id/catId/type của STICKER là ĐỊNH DANH CATALOG CÔNG
// KHAI (đã log dạng rõ ở /messages/send-sticker, đã trả về FE qua /stickers) — KHÔNG phải
// nội dung khách viết. Cổng đo cần giá trị này để gọi probe route debug-sticker/:id.
// KHÔNG mở rộng ngoại lệ này sang msgType khác.
export function logDiag(msg) {
  const diagRaw = msg?.data?.content;
  console.log(
    `[diag] msgType=${msg?.data?.msgType} contentType=${typeof diagRaw} keys=${
      diagRaw && typeof diagRaw === 'object' ? Object.keys(diagRaw).join(',') : '-'
    }`,
  );

  // Ngoại lệ HẸP với quy tắc "chỉ log tên field": id/catId/type của sticker là ĐỊNH DANH
  // CATALOG CÔNG KHAI (đã log dạng rõ ở /messages/send-sticker, đã trả về FE qua /stickers),
  // KHÔNG phải nội dung khách viết. Cần giá trị này cho cổng đo. Chỉ áp dụng cho sticker.
  if (msg.data?.msgType === 'chat.sticker') {
    console.log(`[diag] sticker id=${diagRaw?.id} catId=${diagRaw?.catId} type=${diagRaw?.type}`);
  }
}
