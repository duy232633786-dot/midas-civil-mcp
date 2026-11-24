import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const helperPath = fileURLToPath(new URL('../scripts/MidasCommandShell.ps1', import.meta.url));

function positiveProcessId(value) {
  const processId = Number(value);
  if (!Number.isSafeInteger(processId) || processId <= 0) throw new TypeError('targetProcessId must be a positive integer.');
  return processId;
}

async function runHelper(argumentsList, timeout = 15_000) {
  if (process.platform !== 'win32') throw new Error('MIDAS UI control is available only on Windows.');
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    helperPath,
    ...argumentsList
  ], { windowsHide: true, timeout, maxBuffer: 3_000_000, encoding: 'utf8' });
  const output = stdout.trim();
  if (!output) throw new Error('MIDAS UI helper returned no result.');
  return JSON.parse(output);
}

export async function inspectMidasWindows() {
  return runHelper(['-Action', 'Inspect']);
}

export async function stageMctInCommandShell({ targetProcessId, mctFile, expectedSha256 }) {
  return runHelper([
    '-Action', 'Stage',
    '-TargetProcessId', String(positiveProcessId(targetProcessId)),
    '-MctFile', mctFile,
    '-ExpectedSha256', expectedSha256
  ]);
}

export async function runStagedCommandShell({ targetProcessId, expectedSha256, expectedWindowTitle }) {
  return runHelper([
    '-Action', 'Run',
    '-TargetProcessId', String(positiveProcessId(targetProcessId)),
    '-ExpectedSha256', expectedSha256,
    '-ExpectedWindowTitle', expectedWindowTitle
  ], 60_000);
}

export async function closeCommandShell({ targetProcessId, expectedWindowTitle }) {
  return runHelper([
    '-Action', 'Close',
    '-TargetProcessId', String(positiveProcessId(targetProcessId)),
    '-ExpectedWindowTitle', expectedWindowTitle
  ]);
}
