/** 交付物自检:单文件必须零外部引用(否则就不是「双击即玩」) */
import { readFileSync, statSync } from 'node:fs';

const path = 'dist/3D俄罗斯方块.html';
const html = readFileSync(path, 'utf8');
const external = html.match(/(?:src|href)\s*=\s*"(?!data:)[^"]+"/g) ?? [];
const size = statSync(path).size;

console.log(`单文件: ${path}`);
console.log(`  大小: ${(size / 1024).toFixed(0)} kB`);
console.log(`  外部引用: ${external.length === 0 ? '0 处 ✓' : external.join(', ')}`);
console.log(`  内联 three: ${html.includes('THREE') ? '是 ✓' : '否 ✗'}`);
// 注意不要用「源码里出现 fetch( 就算联网」这种判定:打包进来的 three 内部本来就含有这些字符串,
// 会稳定误报。真正可靠的判据是浏览器端到端里的 requestfailed 监控(那里一个请求都不允许失败,
// 而 file:// 下任何外部请求都必然失败)。这里只报一个信息量更大的事实:有没有指向外部的引用。

if (external.length > 0) process.exit(1);
