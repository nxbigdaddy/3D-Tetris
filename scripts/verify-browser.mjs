/**
 * 真实浏览器端到端验证:打开**最终产物本身**(file:// 协议下的自包含单文件),
 * 用真实键盘事件走一遍完整循环。
 *
 * 断言的都是「玩家能感知到的事」:画面真的在出图、按键真的让方块动了、
 * 消层真的加分并刷新 HUD、堆到井口真的结束。
 *
 * 用法:node scripts/verify-browser.mjs [dist/3D俄罗斯方块.html]
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
const PREFIX = IS_HTTP ? '' : 'single-';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mkdir(OUT, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    defaultViewport: { width: 1280, height: 800 },
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader',
      '--mute-audio',
      '--hide-scrollbars',
    ],
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
    if (IS_HTTP) {
      page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`); });
    }

    await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => Boolean(window.__BLOCKOUT__), { timeout: 20000 });
    await sleep(600);

    const state = () => page.evaluate(() => window.__BLOCKOUT__.state());
    const hud = () => page.evaluate(() => ({
      score: document.getElementById('score').textContent,
      layers: document.getElementById('layers').textContent,
      level: document.getElementById('level').textContent,
      next: document.getElementById('next').textContent,
      overlayVisible: !document.getElementById('overlay').classList.contains('hidden'),
      overlayTitle: document.getElementById('overlayTitle').textContent,
      overlayText: document.getElementById('overlayText').textContent,
      best: document.getElementById('best').textContent,
      mode: document.getElementById('mode').textContent,
      bars: document.querySelectorAll('#layersBars .layerRow').length,
      fullBars: document.querySelectorAll('#layersBars .layerRow.full').length,
    }));

    // ---- 1) 画面:真的在出图,而且不是一片纯色 ----
    const canvasInfo = await page.evaluate(() => {
      const canvas = document.getElementById('scene');
      const rect = canvas.getBoundingClientRect();
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      return {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        buffer: [canvas.width, canvas.height],
        hasContext: Boolean(gl),
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
      };
    });
    check(canvasInfo.hasContext, 'canvas 没有拿到 WebGL 上下文');
    check(Math.abs(canvasInfo.width - canvasInfo.innerWidth) <= 1, `画布宽度不等于视口:${canvasInfo.width} vs ${canvasInfo.innerWidth}`);
    check(Math.abs(canvasInfo.height - canvasInfo.innerHeight) <= 1, `画布高度不等于视口:${canvasInfo.height} vs ${canvasInfo.innerHeight}`);

    // 像素必须在渲染的同一帧里采样:帧外 readPixels 读到的是已提交的缓冲(实测只有 1 种颜色)
    const pixels = await page.evaluate(() => window.__BLOCKOUT__.samplePixels());
    check(!pixels.error, `像素采样失败:${pixels.error}`);
    check(pixels.distinct > 6, `画面颜色种类太少(${pixels.distinct}),可能没在渲染`);
    check(pixels.nonBackground > 200, `画面上几乎没有非背景像素(${pixels.nonBackground}),可能没画出井或方块`);

    // ---- 取景:方井必须完整落在可视区内,且不让顶部 HUD / 底部按键条压住 ----
    const well = await page.evaluate(() => window.__BLOCKOUT__.wellNDC());
    check(well.minX >= -1 && well.maxX <= 1, `方井横向超出屏幕:NDC x[${well.minX.toFixed(2)}, ${well.maxX.toFixed(2)}]`);
    check(well.minY >= -0.86, `方井底部被按键条压住:NDC y 最低 ${well.minY.toFixed(2)}`);
    check(well.maxY <= 0.62, `方井顶部被 HUD 压住或出屏:NDC y 最高 ${well.maxY.toFixed(2)}`);

    // ---- 1b) 新手引导:第一次打开必须先讲清三维规则 ----
    const firstRun = await hud();
    check(firstRun.overlayVisible, '第一次打开应当先显示遮罩');
    check(
      firstRun.overlayTitle.includes('欢迎') || firstRun.overlayTitle.includes('俄罗斯方块'),
      `第一次打开应当是引导/开始遮罩,实际「${firstRun.overlayTitle}」`,
    );
    check(
      firstRun.overlayText.includes('水平层'),
      `引导必须讲清「填满一整个水平层」这条三维规则,实际「${firstRun.overlayText}」`,
    );
    await page.screenshot({ path: path.join(OUT, `${PREFIX}00-新手引导.png`) });

    // ---- 2) HUD 与「各层填充」面板 ----
    const hudBefore = await hud();
    check(hudBefore.bars === 12, `各层填充面板应当有 12 行,实际 ${hudBefore.bars}`);
    check(hudBefore.overlayVisible, '开局应当先显示开始遮罩');
    await page.screenshot({ path: path.join(OUT, `${PREFIX}01-开始遮罩.png`) });

    // ---- 3) 真实键盘:开始游戏 → 方块真的动/转 ----
    await page.keyboard.press('Space');
    await sleep(400);
    const started = await state();
    check(started.started, '按空格之后应当已经开局');
    check(!(await hud()).overlayVisible, '开局之后遮罩应当消失');
    await page.screenshot({ path: path.join(OUT, `${PREFIX}02-开局.png`) });

    const beforeMove = await state();
    await page.keyboard.press('ArrowRight');
    await sleep(120);
    const afterMove = await state();
    check(afterMove.pieceId === beforeMove.pieceId, '移动不应改变方块种类');

    // 左移右移各若干次,方块的水平最小/最大格应当在变
    check(
      JSON.stringify(beforeMove.cells) !== JSON.stringify(afterMove.cells),
      '按右方向键之后方块的**坐标**必须改变',
    );
    check(afterMove.pieceCellCount === beforeMove.pieceCellCount, '移动不应改变方块的格子数量');

    const rotated = await page.evaluate(() => {
      const before = window.__BLOCKOUT__.state();
      const ok = window.__BLOCKOUT__.rotate('y', 1);
      const after = window.__BLOCKOUT__.state();
      return { ok, beforeFilled: before.filled, afterFilled: after.filled };
    });
    check(rotated.ok !== undefined, '旋转接口应当有返回值');

    // 用真实按键旋转三次(绕竖轴),方块必须还在场上
    await page.keyboard.press('KeyQ');
    await page.keyboard.press('KeyQ');
    await page.keyboard.press('KeyW');
    await sleep(150);
    const afterRotate = await state();
    check(afterRotate.pieceId !== null, '连续旋转之后方块不应当消失');
    check(afterRotate.filled === 0, '旋转不应把方块写进井里');

    // ---- 4) 落地投影:必须存在,而且比分块低 ----
    const ghostInfo = await page.evaluate(() => {
      const ghost = window.__BLOCKOUT__.ghost();
      const distance = window.__BLOCKOUT__.dropDistance();
      return { count: ghost ? ghost.length : 0, distance, minY: ghost ? Math.min(...ghost.map((c) => c[1])) : null };
    });
    check(ghostInfo.count >= 4, `落地投影应当至少有 4 格,实际 ${ghostInfo.count}`);
    check(ghostInfo.minY >= 0, '落地投影不应当沉到井底以下');

    // ---- 5) 硬降 → 方块写进井里、分数增加 ----
    await page.keyboard.press('Space');
    await sleep(300);
    const afterDrop = await state();
    check(afterDrop.filled >= 4, `硬降之后井里应当有方块,实际 ${afterDrop.filled} 格`);
    check(afterDrop.score > beforeMove.score, '硬降应当加分');
    check((await hud()).score === String(afterDrop.score), 'HUD 分数应当和内核状态一致');
    await page.screenshot({ path: path.join(OUT, `${PREFIX}03-硬降之后.png`) });

    // ---- 6) 消层:把一层填到只差几格,再用方块补上 ----
    const cleared = await page.evaluate(async () => {
      const api = window.__BLOCKOUT__;
      // **按井的实际尺寸铺层**:写死 5×5 的话井一改成 10×10 就只铺了四分之一,消层永远不发生
      // (这个坑先在单元测试里踩过一次,这里是同一个坑的第二次 —— 验证脚本也得尺寸无关)
      const { width, depth } = api.state().dims;
      for (let z = 0; z < depth; z++) {
        for (let x = 0; x < width; x++) api.setBoardCell(x, 0, z, 3);
      }
      // 全填满之后,给当前方块挖出 4 个洞让它补上
      const spots = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]];
      for (const [x, y, z] of spots) api.setBoardCell(x, y, z, 0);
      api.setPieceCells(spots);
      api.hardDrop();
      return api.state();
    });
    await sleep(500);
    const afterClear = await state();
    check(
      afterClear.layers > afterDrop.layers,
      `补满一层之后应当消层:${afterDrop.layers} → ${afterClear.layers}`,
    );
    check(afterClear.score > afterDrop.score, '消层应当加分');
    await page.screenshot({ path: path.join(OUT, `${PREFIX}04-消层.png`) });

    // ---- 7) 暂停 ----
    await page.keyboard.press('KeyP');
    await sleep(250);
    const paused = await state();
    check(paused.paused, '按 P 应当暂停');
    check((await hud()).overlayVisible, '暂停时应当显示遮罩');
    await page.keyboard.press('KeyP');
    await sleep(250);
    check(!(await state()).paused, '再按 P 应当继续');
    await page.evaluate(() => document.getElementById('scene').focus());
    await page.evaluate(() => window.__BLOCKOUT__.start(4242));
    await sleep(300);
    check((await state()).started, '重开之后应当在游戏中');

    // ---- 7a) 消层时的「逐格碎裂」必须真的产生碎裂块 ----
    const shardInfo = await page.evaluate(async () => {
      const api = window.__BLOCKOUT__;
      api.start(31337);
      await new Promise((r) => setTimeout(r, 250));
      const { width, depth } = api.state().dims;
      for (let z = 0; z < depth; z++) for (let x = 0; x < width; x++) api.setBoardCell(x, 0, z, 3);
      const spots = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]];
      for (const [x, y, z] of spots) api.setBoardCell(x, y, z, 0);
      api.setPieceCells(spots);
      api.hardDrop();
      await new Promise((r) => setTimeout(r, 120));
      return { shards: api.shards(), layers: api.state().layers, dims: api.state().dims };
    });
    check(shardInfo.layers >= 1, `这一刀应当消掉一层,实际 ${shardInfo.layers}`);
    check(shardInfo.shards > 0, `消层时应当出现逐格碎裂块,实际 ${shardInfo.shards}`);

    // ---- 7a2) 切出窗口/切标签页必须自动暂停 ----
    await page.evaluate(() => window.__BLOCKOUT__.start(555));
    await sleep(300);
    check((await state()).started, '自动暂停的用例需要先处于对局中');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await sleep(300);
    check((await state()).paused, '窗口失去焦点时应当自动暂停(否则回来就发现已经输了)');
    check((await hud()).overlayVisible, '自动暂停应当显示遮罩');
    await page.tap('#overlayButton');
    await sleep(250);
    check(!(await state()).paused, '点「继续」应当恢复');

    // ---- 7b) 难度模式:切换之后方块集真的变了 ----
    const classicMode = await page.evaluate(() => window.__BLOCKOUT__.mode());
    check(classicMode.pieces === 8, `经典模式应当是 8 种方块,实际 ${classicMode.pieces}`);
    const hardId = await page.evaluate(() => window.__BLOCKOUT__.setMode('hard'));
    await sleep(400);
    const hardMode = await page.evaluate(() => window.__BLOCKOUT__.mode());
    check(hardId === 'hard', `切换模式应当生效,实际 ${hardId}`);
    check(hardMode.pieces === 29, `高难模式应当是 29 种方块,实际 ${hardMode.pieces}`);
    const hardPiece = await state();
    check(String(hardPiece.pieceId).startsWith('P'), `高难模式的方块应当是五立方体(P*),实际 ${hardPiece.pieceId}`);
    const modeLabel = await page.evaluate(() => document.getElementById('mode').textContent);
    check(modeLabel.includes('高难'), `HUD 应当显示当前模式,实际「${modeLabel}」`);
    await page.screenshot({ path: path.join(OUT, `${PREFIX}06-高难模式.png`) });
    // 切回经典,后面几条都按经典模式继续
    await page.evaluate(() => window.__BLOCKOUT__.setMode('classic'));
    await sleep(300);
    check((await page.evaluate(() => window.__BLOCKOUT__.mode())).pieces === 8, '应当能切回经典模式');

    // ---- 7c) 成绩记录:结束时写入、HUD 与遮罩都反映出来 ----
    await page.evaluate(() => window.__BLOCKOUT__.start(2024));
    await sleep(300);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Space');
    await sleep(300);
    const scoreBefore = (await state()).score;
    check(scoreBefore > 0, `硬降之后应当有分数可记,实际 ${scoreBefore}`);
    await page.evaluate(() => window.__BLOCKOUT__.forceGameOver());
    await sleep(400);
    const progress = await page.evaluate(() => window.__BLOCKOUT__.progress());
    const bestLabel = await page.evaluate(() => document.getElementById('best').textContent);
    const overHud = await hud();
    check(progress.games >= 1, `应当记录到至少一局,实际 ${progress.games}`);
    check(progress.best.classic >= scoreBefore, `最高分应当不低于这一局:${progress.best.classic} vs ${scoreBefore}`);
    check(bestLabel === String(progress.best.classic), `HUD 最高分应当与存档一致:${bestLabel} vs ${progress.best.classic}`);
    check(overHud.overlayTitle.includes('纪录') || overHud.overlayTitle.includes('井口'), `结束遮罩标题异常:「${overHud.overlayTitle}」`);
    check(overHud.overlayText.includes('最高分'), `结束遮罩应当写明最高分,实际「${overHud.overlayText}」`);

    // 刷新页面:成绩必须还在(localStorage)
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => Boolean(window.__BLOCKOUT__), { timeout: 20000 });
    await sleep(500);
    const afterReload = await page.evaluate(() => window.__BLOCKOUT__.progress());
    const bestAfterReload = await page.evaluate(() => document.getElementById('best').textContent);
    check(
      afterReload.best.classic >= progress.best.classic,
      `刷新之后最高分应当还在:${afterReload.best.classic} vs ${progress.best.classic}`,
    );
    check(bestAfterReload === String(afterReload.best.classic), '刷新之后 HUD 最高分应当正确');
    check(afterReload.lastMode === progress.lastMode, '刷新之后应当记得上次玩的模式');
    check(afterReload.seenTutorial === true, '看过引导之后应当记住,不再打扰');
    const afterReloadHud = await hud();
    check(
      !afterReloadHud.overlayTitle.includes('欢迎'),
      `刷新之后不该再显示新手引导,实际「${afterReloadHud.overlayTitle}」`,
    );

    // ---- 8) 堆到井口 → 游戏结束 ----
    // 真实地把井堆满:一直原地下落(不移动),方块会在中央越堆越高,直到井口放不下
    const over = await page.evaluate(async () => {
      const api = window.__BLOCKOUT__;
      api.start(777);
      for (let i = 0; i < 120; i++) {
        api.hardDrop();
        if (api.state().status === 'gameover') break;
        await new Promise((r) => setTimeout(r, 14));
      }
      return { state: api.state() };
    });
    await sleep(500);
    const afterOver = await state();
    const hudOver = await hud();
    check(afterOver.status === 'gameover', `井口堆满之后应当结束,实际 ${afterOver.status}`);
    check(hudOver.overlayVisible, '结束之后应当显示遮罩');
    // 标题有两种合法值:破纪录时是「新纪录!」,否则说明原因。写死其中一种会因为「恰好破纪录」而失败
    check(
      hudOver.overlayTitle.includes('井口') || hudOver.overlayTitle.includes('纪录'),
      `结束遮罩标题异常:「${hudOver.overlayTitle}」`,
    );
    check(hudOver.overlayText.includes('最高分'), `结束遮罩应当写明最高分,实际「${hudOver.overlayText}」`);
    await page.screenshot({ path: path.join(OUT, `${PREFIX}05-结束.png`) });

    check(problems.length === 0, `页面出现错误:\n  ${problems.join('\n  ')}`);

    report = {
      url: URL,
      canvasInfo,
      pixels,
      well,
      started,
      ghostInfo,
      afterDrop,
      afterClear,
      paused,
      afterOver,
      over: over.state,
      problems,
      failures,
    };
  } finally {
    await browser.close();
  }

  await writeFile(path.join(OUT, `${PREFIX}report.json`), JSON.stringify(report, null, 2), 'utf8');

  if (report.failures.length > 0) {
    console.error('❌ 浏览器端验证失败:');
    for (const line of report.failures) console.error(`  - ${line}`);
    if (report.problems.length) for (const line of report.problems) console.error(`  ! ${line}`);
    process.exit(1);
  }

  console.log('\n✅ 浏览器端验证通过:画面在出图、键盘真的能操作、消层真的加分、堆满真的结束。');
  console.log(`   画布 ${report.canvasInfo.width}×${report.canvasInfo.height},画面颜色种类 ${report.pixels.distinct}`);
  console.log(`   硬降后:井内 ${report.afterDrop.filled} 格,分数 ${report.afterDrop.score}`);
  console.log(`   消层后:消层 ${report.afterClear.layers},分数 ${report.afterClear.score}`);
  console.log(`   截图:${OUT}\\${PREFIX}0*.png`);
}

main().catch((err) => {
  console.error('❌ 浏览器端验证异常:', err);
  process.exit(1);
});
