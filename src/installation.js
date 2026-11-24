import fs from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function inspectInstallation(exePath) {
  let stat = null;
  try {
    stat = await fs.stat(exePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  let running = null;
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('tasklist.exe', ['/FI', 'IMAGENAME eq CVLw.exe', '/FO', 'CSV', '/NH'], { windowsHide: true });
      running = /"CVLw\.exe"/i.test(stdout);
    } catch {
      running = null;
    }
  }

  return {
    exePath,
    installed: Boolean(stat?.isFile()),
    bytes: stat?.size ?? null,
    modifiedAt: stat?.mtime?.toISOString() ?? null,
    running,
    licensing: 'Not inspected or modified'
  };
}

export async function launchMidas(exePath, args = []) {
  const stat = await fs.stat(exePath);
  if (!stat.isFile()) throw new Error('MIDAS executable path is not a file.');
  const child = spawn(exePath, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return { started: true, pid: child.pid, exePath, args };
}
