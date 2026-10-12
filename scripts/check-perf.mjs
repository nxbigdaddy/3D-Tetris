/**
 * 帧率体检(**手动工具,不在验证闸门里**)。
 *
 * 为什么单独一个:井的底面从 5×5 改成 10×10 之后,棋盘格子数变成 4 倍
 * (空井到满井最多 1200 个方块网格),渲染负载必须实测而不是猜。
 *
 * 但**不能放进闸门**:无头环境测的是墙钟时间,机器一忙就抖,「断言帧率」会变成随机失败。
 * 这里只报数,由人判断。
 *
 * 用法:node scripts/check-perf.mjs
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const url = pathToFileURL(path.resolve('dist/3D俄罗斯方块.html')).href;
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  defaultViewport: { width: 1280, height: 800 },
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__BLOCKOUT__));
await new Promise((r) => setTimeout(r, 800));

async function frameStats(label) {
  const stats = await page.evaluate(async () => {
    const times = [];
    let last = performance.now();
    await new Promise((resolve) => {
      let frames = 0;
      const tick = () => {
        const now = performance.now();
        times.push(now - last);
        last = now;
        if (++frames >= 90) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    times.sort((a, b) => a - b);
    return { median: times[Math.floor(times.length / 2)], p95: times[Math.floor(times.length * 0.95)], frames: times.length };
  });
  console.log(`${label}: 中位帧间隔 ${stats.median.toFixed(2)} ms,p95 ${stats.p95.toFixed(2)} ms`);
  return stats;
}

await page.evaluate(() => window.__BLOCKOUT__.start(1));
await new Promise((r) => setTimeout(r, 400));
await frameStats('空井  ');

// 把井填到大约一半(按实际尺寸),再测一次
const filled = await page.evaluate(() => {
  const api = window.__BLOCKOUT__;
  const { width, depth, height } = api.state().dims;
  let count = 0;
  for (let y = 0; y < Math.floor(height / 2); y++) {
    for (let z = 0; z < depth; z++) {
      for (let x = 0; x < width; x++) {
        if ((x + z) % 7 === 0) continue;   // 留点空隙,避免整层被消掉
        api.setBoardCell(x, y, z, 1 + ((x + z + y) % 7));
        count++;
      }
    }
  }
  return count;
});
await new Promise((r) => setTimeout(r, 300));
console.log(`井内已填 ${filled} 格`);
await frameStats('半满井');
await page.screenshot({ path: 'artifacts/perf-half-filled.png' });
await browser.close();
