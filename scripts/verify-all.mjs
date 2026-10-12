/**
 * 一键验证闸门。每一步都跑在**最终产物**或**纯逻辑**上,不留只在开发环境成立的中间态。
 *
 * 用法:node scripts/verify-all.mjs   (等价于 pnpm verify)
 */

import { spawn } from 'node:child_process';

const NODE = process.execPath;

function step(title, args) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(NODE, args, { stdio: 'inherit', env: process.env });
    child.on('close', (code) => resolve({ title, ok: code === 0, seconds: ((Date.now() - started) / 1000).toFixed(1) }));
  });
}

const results = [];
async function run(title, args) {
  console.log(`\n${'─'.repeat(60)}\n▶ ${title}\n${'─'.repeat(60)}`);
  const result = await step(title, args);
  results.push(result);
  return result.ok;
}

console.log('验证《3D 俄罗斯方块》');

let allOk = true;

// 1) 规则层:几何、井、状态机 —— 全部能在 Node 里跑,不需要浏览器
allOk = await run('单元测试(规则层)', ['--test', 'tests/**/*.test.js']) && allOk;

if (allOk) {
  // 2) 产出可双击运行的自包含单文件
  allOk = await run('打包自包含单文件', ['scripts/build-single-file.mjs']) && allOk;

  // 3) 交付物自检:零外部引用 —— 这正是「双击即玩、不依赖任何代理进程」的定义
  allOk = await run('单文件自包含自检', ['scripts/check-standalone.mjs']) && allOk;

  // 4) 真实浏览器(file:// 打开最终产物):出图、键盘、消层、结束
  allOk = await run('浏览器端到端(file:// 单文件)', ['scripts/verify-browser.mjs', 'dist/3D俄罗斯方块.html']) && allOk;

  // 5) 手机视口 + 真实触摸:屏幕按键是手机上唯一能操作的方式,必须验证
  allOk = await run('移动端(触摸 + 屏幕按键)', ['scripts/verify-mobile.mjs', 'dist/3D俄罗斯方块.html']) && allOk;
}

console.log(`\n${'═'.repeat(60)}\n验证汇总\n${'═'.repeat(60)}`);
for (const r of results) console.log(`${r.ok ? '✅' : '❌'}  ${r.title.padEnd(26)} ${r.seconds}s`);
if (!allOk) console.log('⏭️   (因前序失败而跳过后续步骤)');

console.log(allOk
  ? '\n全部通过:规则正确、单文件可生成、双击即玩、真实浏览器里能操作能消层能结束、手机上触摸也能玩。'
  : '\n有步骤失败,详见上面的输出。');

process.exit(allOk ? 0 : 1);
