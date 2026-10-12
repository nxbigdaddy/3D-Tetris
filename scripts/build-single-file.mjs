/**
 * 一键产出**自包含单文件 HTML**。
 *
 * 目的:让游戏能在这台机器上双击即玩 —— 不需要 Node、不需要起服务器、不依赖任何后台进程。
 * 因为所有资源和几何体都是内联或过程生成的(没有外部贴图/字体/模型),内联 JS + CSS 之后
 * 就是一个完整的游戏,可以拷到任何地方用浏览器打开。
 *
 * 实现上刻意做了两个选择:
 *   1. 用 Vite 的 JS API 而不是 `vite build && node ...` 的 shell 链。
 *      在 Windows 上链式调用偶发原生崩溃(exit code 0xC0000409),而且崩了就看不到原因。
 *   2. 内联时用「替换函数」而不是替换字符串,详见 inlineAsset()。
 *
 * 用法:node scripts/build-single-file.mjs   (等价于 pnpm build:single)
 */

import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { build as viteBuild } from 'vite';

const DIST = path.resolve('dist');
const ENTRY = path.join(DIST, 'index.html');
const OUTPUT = path.join(DIST, '3D俄罗斯方块.html');

/** ./assets/xxx.js → dist/assets/xxx.js */
function resolveAsset(href) {
  return path.join(DIST, href.replace(/^\.?\//, ''));
}

function mustMatch(html, regex, what) {
  const m = html.match(regex);
  if (!m) throw new Error(`产物结构不符合预期,找不到${what}。Vite 输出格式可能变了,请检查 ${ENTRY}`);
  return m;
}

/** 防止内联脚本里出现 </script> 提前闭合标签 */
function escapeScript(code) {
  return code.replace(/<\/script/gi, '<\\/script');
}

/**
 * 把资源内容内联进 HTML,并逐字符校验结果。
 *
 * ⚠️ 必须用「替换函数」而不是替换字符串:String.replace 会展开替换串里的
 * `$&` / `` $` `` / `$'` / `$1` 等特殊记号。压缩后的 three.js 里恰好含有 `` `$` ``
 * 这样的模板字符串片段,用替换串会把整段 HTML 插进 JS 中间,产物语法直接损坏 ——
 * 而且「无外部引用」这类自检根本发现不了(实测踩过)。
 */
function inlineAsset(html, match, content, wrapper) {
  const built = wrapper(content);
  const replaced = html.replace(match, () => built);
  if (replaced === html) throw new Error('内联失败:未发生替换,产物结构可能不符合预期');
  if (!replaced.includes(built)) throw new Error('内联失败:替换过程中内容被改动($ 展开?)');
  return replaced;
}

async function main() {
  console.log('[1/2] 构建前端产物...');
  await viteBuild({ logLevel: 'warn' });

  console.log('[2/2] 内联为自包含单文件...');
  let html = await readFile(ENTRY, 'utf8').catch(() => {
    throw new Error(`找不到 ${ENTRY},Vite 构建可能失败了`);
  });

  // 1) 内联 JS
  const scriptMatch = mustMatch(html, /<script[^>]*type="module"[^>]*src="([^"]+)"[^>]*><\/script>/, '入口脚本');
  const js = await readFile(resolveAsset(scriptMatch[1]), 'utf8');
  html = inlineAsset(html, scriptMatch[0], escapeScript(js), (code) => `<script type="module">\n${code}\n</script>`);

  // 2) 内联 CSS
  let cssCount = 0;
  for (const m of [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)]) {
    const css = await readFile(resolveAsset(m[1]), 'utf8');
    html = inlineAsset(html, m[0], css, (code) => `<style>\n${code}\n</style>`);
    cssCount++;
  }

  // 3) 清掉 modulepreload(内容已内联,再预加载会去请求不存在的文件)
  html = html.replace(/<link[^>]*rel="modulepreload"[^>]*>\s*/g, '');

  // 4) 自检:不能残留任何指向本地文件的引用,否则拷走就打不开了
  const leftovers = [...html.matchAll(/(?:src|href)="(?!data:|https?:|#)([^"]+)"/g)].map((m) => m[1]);
  if (leftovers.length > 0) {
    throw new Error(`单文件里仍存在外部引用,拷走后会失效:${leftovers.join(', ')}`);
  }

  await writeFile(OUTPUT, html, 'utf8');

  const { size } = await stat(OUTPUT);
  console.log(`✅ 自包含单文件已生成:${path.relative(process.cwd(), OUTPUT)}`);
  console.log(`   内联 JS ${(js.length / 1024).toFixed(0)} kB,CSS ${cssCount} 份,总计 ${(size / 1024).toFixed(0)} kB`);
  console.log('   双击即可用浏览器打开,无需服务器与 Node。');
}

main().catch((err) => {
  console.error(`❌ 单文件打包失败:${err.message}`);
  process.exit(1);
});
