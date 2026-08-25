// Chạy unit test trên bản đã build.
//
// Vì sao cần script này thay vì gọi thẳng `node --test`:
//   - `node --test dist`            → Node chạy MỌI file .js trong thư mục, gồm cả index.js
//                                     ⇒ khởi động server thật rồi treo vô hạn.
//   - `node --test "dist/**/*.js"`  → Node CHỈ hiểu glob từ v22. Trên Node 20 (bản Dockerfile
//                                     và CI đang dùng) nó coi đó là tên file literal:
//                                     "Could not find '.../dist/**/*.test.js'" → exit 1.
//   - Bỏ nháy để shell tự expand    → `sh` không có globstar, `cmd` không expand gì cả.
//
// Nên tự liệt kê file test rồi truyền danh sách tường minh — chạy giống nhau trên
// Windows/Linux và trên mọi Node ≥ 18.

import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const DIST = resolve('dist');

/** Liệt kê đệ quy mọi *.test.js. Tự đệ quy thay vì readdirSync({recursive}) cho khỏi kén bản Node. */
function findTests(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findTests(p));
    else if (entry.name.endsWith('.test.js')) out.push(p);
  }
  return out;
}

let files;
try {
  files = findTests(DIST);
} catch {
  console.error(`Không đọc được ${DIST} — chạy "npm run build" trước.`);
  process.exit(1);
}

// Không tìm thấy test nào thì PHẢI đỏ. Im lặng trả 0 ở đây nghĩa là mọi lần CI sau
// đều "xanh" mà không chạy gì — đúng kiểu hỏng nguy hiểm nhất.
if (files.length === 0) {
  console.error(`Không tìm thấy file *.test.js nào trong ${DIST}`);
  process.exit(1);
}

console.log(`Chạy ${files.length} file test từ ${DIST}`);
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
