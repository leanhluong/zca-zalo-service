// aliasList.js — đọc TOÀN BỘ biệt danh (alias) bạn bè của 1 nick Zalo cá nhân.
//
// Vì sao có file này: zca-js `getAliasList(count = 100, page = 1)`. Gọi trần (không tham số) chỉ
// lấy **100 alias đầu của trang 1** — chủ shop đặt biệt danh cho vài trăm khách thì phần còn lại
// mất im lặng, không lỗi, không cảnh báo. Đo prod 31/07/2026: 3/4 nick trả về ĐÚNG 100 → chạm trần.

export const ALIAS_PAGE_SIZE = 200;
export const ALIAS_MAX_PAGES = 25; // trần an toàn (~5000 alias) — zca-js không chính thức, tránh loop vô tận
export const ALIAS_PAGE_DELAY_MS = 150; // nghỉ giữa trang cho đỡ rate-limit

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Mảng alias thô từ 1 response getAliasList — shape khác nhau giữa các bản zca-js.
export function extractAliasRows(result, onUnexpected) {
  if (Array.isArray(result?.items)) return result.items;
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.data)) return result.data;
  onUnexpected?.(result);
  return [];
}

/**
 * Duyệt hết các trang getAliasList và trả về danh sách alias đã dedupe theo userId.
 *
 * @param {{ getAliasList: (count: number, page: number) => Promise<unknown> }} api - session.api của zca-js
 * @param {{ pageSize?: number, maxPages?: number, delayMs?: number, log?: (msg: string) => void }} [opts]
 * @returns {Promise<{ items: {userId: string, alias: string}[], pagesRead: number, stopReason: 'complete'|'page-cap'|'page-error' }>}
 *   stopReason ≠ 'complete' nghĩa là danh sách CÓ THỂ THIẾU — caller nên log ra, đừng coi như đủ.
 * @throws lỗi của trang ĐẦU (không có gì để giữ lại) — caller quyết định best-effort hay không.
 */
export async function fetchAllAliases(api, opts = {}) {
  const pageSize = opts.pageSize ?? ALIAS_PAGE_SIZE;
  const maxPages = opts.maxPages ?? ALIAS_MAX_PAGES;
  const delayMs = opts.delayMs ?? ALIAS_PAGE_DELAY_MS;
  const log = opts.log ?? (() => {});

  const byUserId = new Map(); // uid → alias; dedupe phòng trang chồng nhau
  let pagesRead = 0;
  let stopReason = 'complete';

  for (let page = 1; page <= maxPages; page += 1) {
    let raw;
    try {
      raw = extractAliasRows(await api.getAliasList(pageSize, page), (result) =>
        log(`unexpected response structure: ${JSON.stringify(result ?? null).substring(0, 300)}`),
      );
    } catch (err) {
      // Lỗi ở trang giữa chừng: giữ lại những trang đã lấy được thay vì vứt hết.
      if (page === 1) throw err;
      log(`page ${page} failed: ${err?.message}`);
      stopReason = 'page-error';
      break;
    }
    pagesRead = page;

    for (const a of raw) {
      const userId = String(a.userId ?? a.uid ?? a.user_id ?? '');
      if (!userId) continue;
      if (!byUserId.has(userId)) byUserId.set(userId, a.alias ?? a.name ?? '');
    }

    if (raw.length < pageSize) break; // trang cuối
    if (page === maxPages) {
      stopReason = 'page-cap'; // chạm trần — nói thẳng ra, đừng im như thể đã lấy đủ
      break;
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  return {
    items: [...byUserId].map(([userId, alias]) => ({ userId, alias })),
    pagesRead,
    stopReason,
  };
}
