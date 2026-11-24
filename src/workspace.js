import fs from 'node:fs/promises';
import path from 'node:path';
import { generateBeamMct, sha256Text, validateMct } from './mct.js';
import { generateRevitBridgeMct } from './revit-bridge.js';

export const READABLE_EXTENSIONS = new Set(['.mct', '.txt', '.json', '.csv']);
export const MAX_READ_BYTES = 2_000_000;

export function resolveWorkspaceFile(root, file, extensions = READABLE_EXTENSIONS) {
  if (typeof file !== 'string' || file.length < 1 || file.length > 128) {
    throw new TypeError('file must be a name between 1 and 128 characters.');
  }
  if (path.basename(file) !== file || file === '.' || file === '..') {
    throw new Error('Nested paths and path traversal are not allowed.');
  }
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._ -]*$/u.test(file)) {
    throw new Error('file contains an unsupported character.');
  }
  const extension = path.extname(file).toLowerCase();
  if (!extensions.has(extension)) {
    throw new Error(`File extension ${extension || '(none)'} is not allowed.`);
  }
  const absoluteRoot = path.resolve(root);
  const candidate = path.resolve(absoluteRoot, file);
  const relative = path.relative(absoluteRoot, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Path is outside MIDAS_WORKDIR.');
  }
  return candidate;
}

export async function listWorkspaceFiles(root) {
  await fs.mkdir(root, { recursive: true });
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !READABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const fullPath = resolveWorkspaceFile(root, entry.name);
    const stat = await fs.stat(fullPath);
    files.push({ name: entry.name, bytes: stat.size, modifiedAt: stat.mtime.toISOString() });
  }
  return files.sort((left, right) => left.name.localeCompare(right.name));
}

export async function readWorkspaceFile(root, file) {
  const fullPath = resolveWorkspaceFile(root, file);
  const stat = await fs.stat(fullPath);
  if (stat.size > MAX_READ_BYTES) throw new Error(`File exceeds ${MAX_READ_BYTES} readable bytes.`);
  const content = await fs.readFile(fullPath, 'utf8');
  return { file, fullPath, bytes: stat.size, sha256: sha256Text(content), content };
}

export async function commitBeamFile({
  root,
  file,
  spec,
  expectedSha256,
  overwrite = false,
  expectedExistingSha256 = null
}) {
  if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    throw new TypeError('expectedSha256 must be the 64-character hash returned by midas_preview_beam.');
  }
  const generated = generateBeamMct(spec);
  if (generated.sha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error('Preview hash mismatch. Nothing was written; preview the exact same beam parameters again.');
  }

  const fullPath = resolveWorkspaceFile(root, file, new Set(['.mct']));
  await fs.mkdir(path.resolve(root), { recursive: true });
  let existed = false;
  try {
    const oldContent = await fs.readFile(fullPath, 'utf8');
    existed = true;
    if (!overwrite) throw new Error('Target file already exists. Use a new name or explicitly confirm overwrite.');
    if (typeof expectedExistingSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedExistingSha256)) {
      throw new Error('Overwriting requires expectedExistingSha256 from midas_read_file.');
    }
    const actualExistingSha256 = sha256Text(oldContent);
    if (actualExistingSha256.toLowerCase() !== expectedExistingSha256.toLowerCase()) {
      throw new Error('Existing file changed after inspection. Nothing was overwritten.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const validation = validateMct(generated.content, {
    requireVersion: Boolean(generated.spec.mctVersion),
    requireEndData: Boolean(generated.spec.mctVersion)
  });
  if (!validation.ok) throw new Error('Internal validation failed immediately before write.');
  await fs.writeFile(fullPath, generated.content, { encoding: 'utf8', flag: existed ? 'w' : 'wx' });
  return {
    file,
    fullPath,
    sha256: generated.sha256,
    bytes: generated.byteLength,
    overwritten: existed,
    deliveryMode: generated.deliveryMode,
    summary: generated.summary,
    warnings: generated.warnings
  };
}

export async function commitRevitBridgeFile({
  root,
  sourceFile,
  file,
  expectedSourceSha256,
  expectedSha256,
  overwrite = false,
  expectedExistingSha256 = null
}) {
  if (typeof expectedSourceSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedSourceSha256)) {
    throw new TypeError('expectedSourceSha256 must be the source hash returned by midas_preview_revit_bridge.');
  }
  if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    throw new TypeError('expectedSha256 must be the MCT hash returned by midas_preview_revit_bridge.');
  }
  if (path.extname(sourceFile).toLowerCase() !== '.json') {
    throw new TypeError('sourceFile must be a JSON skeleton exported from Revit.');
  }
  const source = await readWorkspaceFile(root, sourceFile);
  if (source.sha256.toLowerCase() !== expectedSourceSha256.toLowerCase()) {
    throw new Error('Revit skeleton changed after preview. Nothing was written.');
  }
  let skeleton;
  try {
    skeleton = JSON.parse(source.content);
  } catch {
    throw new Error('Revit skeleton is not valid JSON.');
  }
  const generated = generateRevitBridgeMct(skeleton);
  if (generated.sha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error('Preview hash mismatch. Nothing was written; preview the same Revit skeleton again.');
  }

  const fullPath = resolveWorkspaceFile(root, file, new Set(['.mct']));
  await fs.mkdir(path.resolve(root), { recursive: true });
  let existed = false;
  try {
    const oldContent = await fs.readFile(fullPath, 'utf8');
    existed = true;
    if (!overwrite) throw new Error('Target file already exists. Use a new name or explicitly confirm overwrite.');
    if (typeof expectedExistingSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedExistingSha256)) {
      throw new Error('Overwriting requires expectedExistingSha256 from midas_read_file.');
    }
    const actualExistingSha256 = sha256Text(oldContent);
    if (actualExistingSha256.toLowerCase() !== expectedExistingSha256.toLowerCase()) {
      throw new Error('Existing file changed after inspection. Nothing was overwritten.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await fs.writeFile(fullPath, generated.content, { encoding: 'utf8', flag: existed ? 'w' : 'wx' });
  return {
    file,
    fullPath,
    sourceFile,
    sourceSha256: source.sha256,
    sha256: generated.sha256,
    bytes: generated.byteLength,
    overwritten: existed,
    deliveryMode: generated.deliveryMode,
    summary: generated.summary,
    source: generated.source,
    warnings: generated.warnings,
    disclaimer: generated.disclaimer
  };
}
