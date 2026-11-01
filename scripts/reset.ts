/** 清空本地记忆（不可恢复）。npm run reset */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../src/config.ts";

const dataDir = path.join(ROOT, "data");
if (!fs.existsSync(dataDir)) {
  console.log("没有 data/ 目录，已经干净了。");
  process.exit(0);
}
let n = 0;
for (const f of fs.readdirSync(dataDir)) {
  if (/\.db(-wal|-shm)?$/.test(f)) {
    fs.rmSync(path.join(dataDir, f));
    console.log(`  删除 ${f}`);
    n++;
  }
}
console.log(n === 0 ? "没有数据库文件。" : `已清空 ${n} 个文件。`);
