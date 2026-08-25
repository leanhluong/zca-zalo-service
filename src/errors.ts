// Tiện ích đọc lỗi.
//
// Với `strict`, biến trong `catch (err)` có kiểu `unknown` — đúng, vì JS ném được
// bất cứ thứ gì (chuỗi, số, object trần), không riêng Error. Code cũ viết
// `err?.message` khắp nơi và im lặng cho ra `undefined` khi thứ ném ra không phải
// Error. Ba helper dưới đây đọc phòng thủ, dùng ở MỌI khối catch.

/** Message của lỗi, hoặc String(err) khi thứ ném ra không phải Error. */
export function errMsg(err: unknown): string | undefined {
  if (err instanceof Error) return err.message;
  if (err == null) return undefined;
  if (typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    return typeof m === 'string' ? m : String(m);
  }
  return String(err);
}

/** Tên lỗi (vd "ZaloApiError") — dùng làm `code` trong response. */
export function errName(err: unknown): string | undefined {
  if (err instanceof Error) return err.name;
  if (err && typeof err === 'object' && 'name' in err) {
    const n = (err as { name?: unknown }).name;
    return typeof n === 'string' ? n : undefined;
  }
  return undefined;
}

/** Stack trace nếu có — chỉ để log. */
export function errStack(err: unknown): string | undefined {
  return err instanceof Error ? err.stack : undefined;
}

/** Cờ do withTimeout() gắn: lỗi này là quá hạn chờ Zalo ⇒ route trả 504. */
export function isTimeout(err: unknown): boolean {
  return !!(err && typeof err === 'object' && (err as { isTimeout?: boolean }).isTimeout === true);
}
