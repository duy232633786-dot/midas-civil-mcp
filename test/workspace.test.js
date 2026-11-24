import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateBeamMct } from '../src/mct.js';
import { generateRevitBridgeMct } from '../src/revit-bridge.js';
import { commitBeamFile, commitRevitBridgeFile, readWorkspaceFile, resolveWorkspaceFile } from '../src/workspace.js';

async function withTemporaryWorkspace(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'midas-mcp-test-'));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('workspace rejects traversal and unsupported extensions', () => {
  const root = path.join(os.tmpdir(), 'midas-safe-root');
  assert.throws(() => resolveWorkspaceFile(root, '..\\escape.mct'), /Nested paths|outside/);
  assert.throws(() => resolveWorkspaceFile(root, '../escape.mct'), /Nested paths|outside/);
  assert.throws(() => resolveWorkspaceFile(root, 'script.ps1'), /extension/i);
});

test('hash mismatch writes nothing', async () => withTemporaryWorkspace(async (root) => {
  await assert.rejects(commitBeamFile({
    root,
    file: 'beam.mct',
    spec: {},
    expectedSha256: '0'.repeat(64)
  }), /hash mismatch/i);
  await assert.rejects(fs.stat(path.join(root, 'beam.mct')), { code: 'ENOENT' });
}));

test('matching preview hash commits the exact beam', async () => withTemporaryWorkspace(async (root) => {
  const spec = { lengthM: 12, segments: 4, widthM: 0.4, heightM: 0.8 };
  const preview = generateBeamMct(spec);
  const committed = await commitBeamFile({ root, file: 'beam.mct', spec, expectedSha256: preview.sha256 });
  const read = await readWorkspaceFile(root, 'beam.mct');
  assert.equal(committed.sha256, preview.sha256);
  assert.equal(read.content, preview.content);
  assert.equal(committed.overwritten, false);
}));

test('existing file is protected and overwrite needs its current hash', async () => withTemporaryWorkspace(async (root) => {
  const initialSpec = { lengthM: 6, segments: 2 };
  const initial = generateBeamMct(initialSpec);
  await commitBeamFile({ root, file: 'beam.mct', spec: initialSpec, expectedSha256: initial.sha256 });

  await assert.rejects(commitBeamFile({
    root,
    file: 'beam.mct',
    spec: initialSpec,
    expectedSha256: initial.sha256
  }), /already exists/i);

  const replacementSpec = { lengthM: 8, segments: 4 };
  const replacement = generateBeamMct(replacementSpec);
  await assert.rejects(commitBeamFile({
    root,
    file: 'beam.mct',
    spec: replacementSpec,
    expectedSha256: replacement.sha256,
    overwrite: true,
    expectedExistingSha256: 'f'.repeat(64)
  }), /changed after inspection/i);

  const existing = await readWorkspaceFile(root, 'beam.mct');
  const committed = await commitBeamFile({
    root,
    file: 'beam.mct',
    spec: replacementSpec,
    expectedSha256: replacement.sha256,
    overwrite: true,
    expectedExistingSha256: existing.sha256
  });
  assert.equal(committed.overwritten, true);
  assert.equal((await readWorkspaceFile(root, 'beam.mct')).content, replacement.content);
}));

test('Revit bridge commit binds both source and generated hashes', async () => withTemporaryWorkspace(async (root) => {
  const skeleton = {
    schema: 'dylight.revit.bridge-skeleton.v1', documentTitle: 'TEST', documentPath: 'test.rvt',
    activeView: '3D', familyCount: 1,
    instances: [{
      family: 'BRG_LOD300_RHS_DIAGONAL_ADAPTIVE', originM: [0, 0, 0],
      basisX: [1, 0, 0], basisY: [0, 1, 0], basisZ: [0, 0, 1],
      adaptivePointsM: [[0, 0, 0], [5, 0, 5]]
    }]
  };
  const sourceContent = `${JSON.stringify(skeleton)}\n`;
  await fs.writeFile(path.join(root, 'bridge.json'), sourceContent, 'utf8');
  const source = await readWorkspaceFile(root, 'bridge.json');
  const preview = generateRevitBridgeMct(skeleton);
  await assert.rejects(commitRevitBridgeFile({
    root, sourceFile: 'bridge.json', file: 'bridge.mct',
    expectedSourceSha256: '0'.repeat(64), expectedSha256: preview.sha256
  }), /changed after preview/i);
  const committed = await commitRevitBridgeFile({
    root, sourceFile: 'bridge.json', file: 'bridge.mct',
    expectedSourceSha256: source.sha256, expectedSha256: preview.sha256
  });
  assert.equal(committed.sha256, preview.sha256);
  assert.equal((await readWorkspaceFile(root, 'bridge.mct')).content, preview.content);
}));
