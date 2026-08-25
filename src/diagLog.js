// Chẩn đoán loại tin nhắn Zalo — dùng chung cho MỌI call site inbound (message + old_messages,
// cả 2 file sessions.js và sessionRestore.js) để tránh lặp + đảm bảo cùng 1 quy tắc log.
//
// Quy tắc: CHỈ log TÊN field, KHÔNG log giá trị — nội dung tin khách là dữ liệu nhạy cảm.
//
// Ngoại lệ HẸP: id/catId/type của STICKER là ĐỊNH DANH CATALOG CÔNG KHAI (đã log dạng rõ ở
// /messages/send-sticker, đã trả về qua /stickers) — KHÔNG phải nội dung khách viết.
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
