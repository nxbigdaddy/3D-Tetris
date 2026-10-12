/**
 * 用系统默认程序打开一个文件或网址。
 *
 * 放在独立模块里是因为 Windows 上「打开默认浏览器」这件事比看上去麻烦:
 *   - `start` 是 cmd 内建命令,必须经过 cmd,且第一个参数会被当成窗口标题,得传空串占位;
 *   - explorer.exe 直接接路径就能用关联程序打开,且天然处理带空格的路径。
 * 所以优先用 explorer,失败再退回 cmd start。
 */

import { spawn } from 'node:child_process';

export function openInBrowser(target) {
  const platform = process.platform;

  if (platform === 'win32') {
    const viaExplorer = spawn('explorer.exe', [target], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    // explorer 即使成功也常返回非 0,所以这里不看返回值,只兜底异常
    viaExplorer.on('error', () => {
      spawn('cmd', ['/c', 'start', '', `"${target}"`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    });
    viaExplorer.unref();
    return;
  }

  const opener = platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(opener, [target], { detached: true, stdio: 'ignore' }).unref();
}
