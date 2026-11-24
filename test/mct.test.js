import test from 'node:test';
import assert from 'node:assert/strict';
import { generateBeamMct, validateMct } from '../src/mct.js';

test('generated beam is deterministic and semantically valid', () => {
  const first = generateBeamMct({ lengthM: 6, segments: 6, widthM: 0.3, heightM: 0.5 });
  const second = generateBeamMct({ lengthM: 6, segments: 6, widthM: 0.3, heightM: 0.5 });
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.summary.nodes, 7);
  assert.equal(first.summary.elements, 6);
  assert.equal(first.deliveryMode, 'MCT_COMMAND_SHELL');
  assert.match(first.content, /\*CONSTRAINT[\s\S]*111000[\s\S]*011000/);
  assert.doesNotMatch(first.content, /\*ENDDATA/);
});

test('versioned beam is valid for file-import validation', () => {
  const generated = generateBeamMct({ mctVersion: '9.1.0' });
  const validation = validateMct(generated.content, { requireVersion: true });
  assert.equal(validation.ok, true);
  assert.equal(generated.deliveryMode, 'MCT_FILE_IMPORT');
});

test('validator rejects an unknown command', () => {
  const generated = generateBeamMct();
  const content = `${generated.content}*SYSTEM\n dangerous\n`;
  const validation = validateMct(content, { requireEndData: false });
  assert.equal(validation.ok, false);
  assert(validation.errors.some((item) => item.code === 'MCT_COMMAND_NOT_ALLOWED'));
});

test('validator rejects a missing material reference', () => {
  const generated = generateBeamMct({ segments: 1 });
  const content = generated.content.replace('1, BEAM, 1, 1, 1, 2, 0', '1, BEAM, 99, 1, 1, 2, 0');
  const validation = validateMct(content);
  assert.equal(validation.ok, false);
  assert(validation.errors.some((item) => item.code === 'MCT_ELEMENT_MATERIAL_MISSING'));
});

test('validator rejects a zero-length element', () => {
  const generated = generateBeamMct({ segments: 1 });
  const content = generated.content.replace('2, 6, 0, 0', '2, 0, 0, 0');
  const validation = validateMct(content);
  assert.equal(validation.ok, false);
  assert(validation.errors.some((item) => item.code === 'MCT_ZERO_LENGTH_ELEMENT'));
});

test('validator rejects duplicate node IDs', () => {
  const generated = generateBeamMct({ segments: 1 });
  const content = generated.content.replace('2, 6, 0, 0', '1, 6, 0, 0');
  const validation = validateMct(content);
  assert.equal(validation.ok, false);
  assert(validation.errors.some((item) => item.code === 'MCT_DUPLICATE_NODE_ID'));
});

test('validator requires version only when file-import mode requests it', () => {
  const generated = generateBeamMct();
  assert.equal(validateMct(generated.content, { requireEndData: false }).ok, true);
  const strict = validateMct(generated.content, { requireVersion: true, requireEndData: true });
  assert.equal(strict.ok, false);
  assert(strict.errors.some((item) => item.code === 'MCT_VERSION_REQUIRED'));
});

test('beam inputs are bounded', () => {
  assert.throws(() => generateBeamMct({ lengthM: 0 }), /lengthM/);
  assert.throws(() => generateBeamMct({ segments: 1001 }), /segments/);
  assert.throws(() => generateBeamMct({ materialName: '../bad' }), /materialName/);
});
