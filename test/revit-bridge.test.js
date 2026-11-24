import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRevitBridgeMct } from '../src/revit-bridge.js';
import { validateMct } from '../src/mct.js';

const identity = { basisX: [1, 0, 0], basisY: [0, 1, 0], basisZ: [0, 0, 1] };

test('Revit bridge skeleton creates a safe deterministic command-shell MCT', () => {
  const skeleton = {
    schema: 'dylight.revit.bridge-skeleton.v1',
    documentTitle: 'TEST_BRIDGE',
    documentPath: 'test.rvt',
    activeView: '3D',
    familyCount: 3,
    instances: [
      { family: 'BRG_3SP300_PSC_CBG_SEG_01', originM: [0, 0, 10], ...identity },
      { family: 'BRG_3SP300_RC_ARCH_RIB_200M', originM: [0, -5, 0], ...identity },
      {
        family: 'BRG_LOD300_RHS_DIAGONAL_ADAPTIVE', originM: [0, 0, 0], ...identity,
        adaptivePointsM: [[0, -5, 0], [5, -5, 5]]
      }
    ]
  };
  const first = generateRevitBridgeMct(skeleton);
  const second = generateRevitBridgeMct(skeleton);
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.deliveryMode, 'MCT_COMMAND_SHELL');
  assert.equal(first.summary.materials, 1);
  assert.equal(first.summary.sections, 11);
  assert(first.summary.nodes > 10);
  assert(first.summary.elements > 10);
  assert.equal(first.source.includedElementsBySource.psc_box_segment, 5);
  assert.equal(first.source.pscBox.analysisSegmentLengthM, 1);
  assert.equal(first.source.pscBox.depthM.tower, 10.5);
  assert.match(first.content, /DBUSER, PSC_BOX_S001, CT[^\n]+YES, NO, B, 2/);
  assert.doesNotMatch(first.content, /PSC_DECK_GRILLAGE|deck_cross_frame/);
  assert.doesNotMatch(first.content, /\*ENDDATA/);
  assert.equal(validateMct(first.content, { requireEndData: false }).ok, true);
});
