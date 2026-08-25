import fs from 'fs/promises';
import { imageSize } from 'image-size';

// zca-js v2.x đã BỎ sharp — khi gửi ảnh/gif bằng đường dẫn file, thư viện gọi
// ctx.options.imageMetadataGetter(filePath) để lấy { width, height, size }.
// Nếu KHÔNG cung cấp getter → ném ZaloApiMissingImageMetadataGetter → gửi ảnh
// LUÔN thất bại (trong khi gửi text vẫn OK vì không cần metadata).
//
// Dùng `image-size` (pure JS, không native binary → chạy tốt trên node:alpine),
// đọc width/height từ header ảnh; `size` lấy từ dung lượng file thật.
// Hỗ trợ jpg/jpeg/png/webp/gif — đủ cho các loại ảnh Zalo cho phép gửi.
export async function imageMetadataGetter(filePath) {
  const data = await fs.readFile(filePath);
  const dimensions = imageSize(data);
  return {
    width: dimensions.width,
    height: dimensions.height,
    size: data.length,
  };
}
