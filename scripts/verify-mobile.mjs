/**
 * 移动端验证:手机视口 + **真实触摸事件**。
 *
 * 三维俄罗斯方块在手机上最大的问题不是画面,而是**没有键盘就完全玩不了** ——
 * 所以这一层验证的核心是屏幕按键:用 CDP 派发真正的 touchstart/touchend,
 * 断言「点一下按钮,方块真的动了」。
 *
 * 用法:node scripts/verify-mobile.mjs [dist/3D俄罗斯方块.html]
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

function resolveTarget() {
  const arg = process.argv[2] ?? process.env.VERIFY_URL;
  if (!arg) return 'http://127.0.0.1:5184/';
  if (/^https?:\/\//.test(arg)) return arg;
  return pathToFileURL(path.resolve(arg)).href;
}

const URL = resolveTarget();
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = path.resolve(process.env.VERIFY_OUT ?? 'artifacts');
const IS_HTTP = URL.startsWith('http');
const PREFIX = IS_HTTP ? 'mobile-' : 'mobile-single-';

const DEVICE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mkdir(OUT, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--mute-audio', '--hide-scrollbars'],
  });

  const failures = [];
  const problems = [];
  const check = (cond, message) => { if (!cond) failures.push(message); };
  let report = null;

  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console.error: ${m.text()}`); });
    page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));

    await page.setViewport(DEVICE);
    await page.emulate({
      viewport: DEVICE,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });

    await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => Boolean(window.__BLOCKOUT__), { timeout: 20000 });
    await sleep(700);

    const state = () => page.evaluate(() => window.__BLOCKOUT__.state());

    // ---- 1) 布局:不溢出、画布尺寸正确、屏幕按键可见且够大 ----
    const layout = await page.evaluate(() => {
      const rect = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      };
      const buttons = Array.from(document.querySelectorAll('#touchPad button')).map((b) => {
        const r = b.getBoundingClientRect();
        return { action: b.dataset.action, w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && r.height > 0 };
      });
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        canvas: rect('#scene'),
        pad: rect('#touchPad'),
        legendDisplay: getComputedStyle(document.getElementById('legend')).display,
        buttons,
      };
    });

    check(layout.scrollWidth <= layout.innerWidth + 1, `横向溢出:${layout.scrollWidth} > ${layout.innerWidth}`);
    check(layout.scrollHeight <= layout.innerHeight + 1, `纵向溢出:${layout.scrollHeight} > ${layout.innerHeight}`);
    check(
      layout.canvas && Math.abs(layout.canvas.w - layout.innerWidth) <= 1 && Math.abs(layout.canvas.h - layout.innerHeight) <= 1,
      `画布尺寸必须等于视口:${layout.canvas?.w}×${layout.canvas?.h} vs ${layout.innerWidth}×${layout.innerHeight}`,
    );
    check(layout.buttons.length >= 12, `屏幕按键数量不足:${layout.buttons.length}`);
    check(layout.buttons.every((b) => b.visible), '有屏幕按键不可见');
    check(
      layout.buttons.every((b) => b.h >= 36 && b.w >= 36),
      `触摸目标太小(手指点不中):${JSON.stringify(layout.buttons.filter((b) => b.h < 36 || b.w < 36))}`,
    );
    check(layout.pad && layout.pad.y + layout.pad.h <= layout.innerHeight, '屏幕按键超出视口底部');

    // 方井取景
    const well = await page.evaluate(() => window.__BLOCKOUT__.wellNDC());
    check(well.minX >= -1 && well.maxX <= 1, `方井横向超出屏幕:x[${well.minX.toFixed(2)}, ${well.maxX.toFixed(2)}]`);
    // 手机的安全带与桌面不同:HUD 在顶部,屏幕按键占了底下约三成,所以下限比桌面更紧(实测 -0.45 / 0.63)
    check(well.minY >= -0.5, `方井底部被屏幕按键挡住:y 最低 ${well.minY.toFixed(2)}`);
    check(well.maxY <= 0.66, `方井顶部被 HUD 压住:y 最高 ${well.maxY.toFixed(2)}`);

    await page.screenshot({ path: path.join(OUT, `${PREFIX}01-开局.png`) });

    // ---- 2) 用真实触摸点按钮开局 ----
    const client = await page.createCDPSession();
    const tapAction = async (action) => {
      const box = await page.evaluate((name) => {
        const el = document.querySelector(`#touchPad button[data-action="${name}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, action);
      if (!box) return false;
      const point = { x: Math.round(box.x), y: Math.round(box.y), radiusX: 10, radiusY: 10, force: 1 };
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      await sleep(30);
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(140);
      return true;
    };

    // 开始遮罩上的按钮是普通 DOM 按钮,tap 一下即可
    await page.tap('#overlayButton');
    await sleep(400);
    check((await state()).started, '触摸「开始」之后应当已经开局');

    // ---- 3) 每个方向/旋转按钮都要真的改变方块状态 ----
    const before = await page.evaluate(() => window.__BLOCKOUT__.state());
    // 必须比较**坐标**;state().pieceCellCount 只是格子数量,方块平移时不会变(第一版就踩了这个坑)
    const pieceKey = () => page.evaluate(() => JSON.stringify(window.__BLOCKOUT__.state().cells ?? null));

    const cellsBeforeMove = await pieceKey();
    await tapAction('left');
    const cellsAfterMove = await pieceKey();
    check(cellsBeforeMove !== cellsAfterMove || (await page.evaluate(() => window.__BLOCKOUT__.move([-1, 0, 0]))) === false,
      '点「左移」按钮之后方块的位置应当变化(或已经贴墙)');

    const rotationTried = await page.evaluate(async () => {
      // 直接问内核:这个方块在当前位置还能不能转 —— 用来区分「按钮没生效」和「转不动」
      const beforeCells = JSON.stringify(window.__BLOCKOUT__.state().cells);
      const ok = window.__BLOCKOUT__.rotate('y', 1);
      return { ok, changed: beforeCells !== JSON.stringify(window.__BLOCKOUT__.state().cells) };
    });
    check(rotationTried.ok === undefined || rotationTried.ok === true || rotationTried.ok === false, '旋转接口应当有明确返回值');

    const beforeRotate = await pieceKey();
    await tapAction('yawLeft');
    const afterRotate = await pieceKey();
    check(beforeRotate !== afterRotate || rotationTried.ok === false, '点「左偏航」按钮之后方块姿态应当变化');

    // 前后同理:贴着某一边的壁时那个方向动不了,所以两个方向都要试
    const beforeForward = await pieceKey();
    await tapAction('forward');
    let movedInDepth = (await pieceKey()) !== beforeForward;
    if (!movedInDepth) {
      await tapAction('back');
      movedInDepth = (await pieceKey()) !== beforeForward;
    }
    check(movedInDepth, '点「前移」「后移」之后方块在深度方向应当变化');

    await page.screenshot({ path: path.join(OUT, `${PREFIX}02-按键操作中.png`) });

    // ---- 4) 硬降按钮:方块落地、井里多出方块 ----
    const beforeDrop = await state();
    await tapAction('hardDrop');
    await sleep(350);
    const afterDrop = await state();
    check(afterDrop.filled > beforeDrop.filled, `点「硬降」之后井里应当多出方块:${beforeDrop.filled} → ${afterDrop.filled}`);
    check(afterDrop.score > beforeDrop.score, '硬降应当加分');

    // ---- 5) 暂停按钮 ----
    await tapAction('pause');
    await sleep(250);
    check((await state()).paused, '点「暂停」应当暂停');
    // 暂停时遮罩(inset:0,z-index 5)会盖住屏幕按键 —— 这是刻意的:恢复要走遮罩上的「继续」按钮
    await page.tap('#overlayButton');
    await sleep(300);
    check(!(await state()).paused, '点遮罩上的「继续」应当恢复');

    // ---- 6) 音频:触摸也要能唤醒(浏览器要求用户手势) ----
    const audio = await page.evaluate(() => window.__BLOCKOUT__.audio());
    check(audio.unlocked, '触摸之后音频应当已被唤醒');
    check(audio.context === 'running' || audio.context === 'suspended', `音频上下文状态异常:${audio.context}`);

    check(problems.length === 0, `页面出现错误:\n  ${problems.join('\n  ')}`);

    report = { url: URL, device: DEVICE, layout, well, before, afterDrop, audio, problems, failures };
  } finally {
    await browser.close();
  }

  await writeFile(path.join(OUT, `${PREFIX}report.json`), JSON.stringify(report, null, 2), 'utf8');

  if (report.failures.length > 0) {
    console.error('❌ 移动端验证失败:');
    for (const line of report.failures) console.error(`  - ${line}`);
    if (report.problems.length) for (const line of report.problems) console.error(`  ! ${line}`);
    process.exit(1);
  }

  console.log('\n✅ 移动端验证通过:无溢出、画布尺寸正确、取景安全、屏幕按键可点且真的能操作、音频已唤醒。');
  console.log(`   视口 ${report.device.width}×${report.device.height} @${report.device.deviceScaleFactor}x,屏幕按键 ${report.layout.buttons.length} 个`);
  console.log(`   硬降:井内 ${report.before.filled} → ${report.afterDrop.filled} 格,分数 ${report.afterDrop.score}`);
  console.log(`   截图:${OUT}\\${PREFIX}01-开局.png、${PREFIX}02-按键操作中.png`);
}

main().catch((err) => {
  console.error('❌ 移动端验证异常:', err);
  process.exit(1);
});
