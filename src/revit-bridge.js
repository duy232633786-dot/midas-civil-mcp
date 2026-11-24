import { canonicalizeMct, validateMct } from './mct.js';

const SECTION_ARCH = 1;
const SECTION_STEEL = 2;
const SECTION_TOWER = 3;
const SECTION_CABLE = 4;
const SECTION_PILE = 5;
const SECTION_RC_LINK = 6;
const SECTION_PSC_BOX_BASE = 100;
const CANTILEVER_ARM_LENGTH_M = 100;
const REVIT_SEGMENT_LENGTH_M = 5;
const ANALYSIS_SEGMENT_LENGTH_M = 1;

const SECTIONS = [
  { id: SECTION_ARCH, name: 'RC_ARCH_RIB', heightM: 2.5, widthM: 1.8 },
  { id: SECTION_STEEL, name: 'STEEL_RHS_IDEAL', heightM: 0.45, widthM: 0.45 },
  { id: SECTION_TOWER, name: 'RC_TOWER_IDEAL', heightM: 2.2, widthM: 2.2 },
  { id: SECTION_CABLE, name: 'STAY_CABLE_IDEAL', heightM: 0.2, widthM: 0.2 },
  { id: SECTION_PILE, name: 'PILE_D1500_IDEAL', heightM: 1.5, widthM: 1.5 },
  { id: SECTION_RC_LINK, name: 'RC_LINK_IDEAL', heightM: 1.2, widthM: 1.2 }
];

function finitePoint(value, label) {
  if (!Array.isArray(value) || value.length !== 3) throw new TypeError(`${label} must contain X, Y and Z.`);
  const point = value.map(Number);
  if (point.some((coordinate) => !Number.isFinite(coordinate) || Math.abs(coordinate) > 100_000)) {
    throw new TypeError(`${label} contains an invalid coordinate.`);
  }
  return point;
}

function transformPoint(record, localPoint) {
  const origin = finitePoint(record.originM, `${record.family}.originM`);
  const basisX = finitePoint(record.basisX, `${record.family}.basisX`);
  const basisY = finitePoint(record.basisY, `${record.family}.basisY`);
  const basisZ = finitePoint(record.basisZ, `${record.family}.basisZ`);
  const local = finitePoint(localPoint, 'localPoint');
  return origin.map((value, index) => (
    value + basisX[index] * local[0] + basisY[index] * local[1] + basisZ[index] * local[2]
  ));
}

function rectangularSectionLine(section) {
  return ` ${section.id}, DBUSER, ${section.name}, CC, 0, 0, 0, 0, 0, 0, YES, NO, SB, 2, ${section.heightM}, ${section.widthM}, 0, 0, 0, 0, 0, 0, 0, 0, 0`;
}

function roundedDimension(value) {
  return Number(value.toFixed(6));
}

function cantileverBoxSection(stationIndex) {
  const stationM = stationIndex * ANALYSIS_SEGMENT_LENGTH_M + ANALYSIS_SEGMENT_LENGTH_M / 2;
  const towerFactor = 1 - stationM / CANTILEVER_ARM_LENGTH_M;
  return {
    id: SECTION_PSC_BOX_BASE + stationIndex,
    name: `PSC_BOX_S${String(stationIndex + 1).padStart(3, '0')}`,
    stationM: roundedDimension(stationM),
    depthM: roundedDimension(3.5 + 7 * towerFactor * towerFactor),
    topWidthM: 12,
    topThicknessM: 0.45,
    webThicknessM: 0.7,
    bottomWidthM: roundedDimension(2 * (3.5 + 1.2 * towerFactor)),
    bottomThicknessM: roundedDimension(0.45 + 0.45 * towerFactor)
  };
}

function boxSectionLine(section) {
  return ` ${section.id}, DBUSER, ${section.name}, CT, 0, 0, 0, 0, 0, 0, YES, NO, B, 2, ${section.depthM}, ${section.topWidthM}, ${section.topThicknessM}, ${section.webThicknessM}, ${section.bottomWidthM}, ${section.bottomThicknessM}, 0, 0, 0, 0, 0`;
}

export function generateRevitBridgeMct(skeleton) {
  if (!skeleton || skeleton.schema !== 'dylight.revit.bridge-skeleton.v1') {
    throw new TypeError('Expected a dylight.revit.bridge-skeleton.v1 export.');
  }
  if (!Array.isArray(skeleton.instances) || skeleton.instances.length < 1) {
    throw new TypeError('Revit bridge export contains no family instances.');
  }

  const nodes = [];
  const elements = [];
  const nodeByKey = new Map();
  const elementKeys = new Set();
  const fixedNodeIds = new Set();
  const sourceCounts = new Map();
  const deckStations = new Map();
  const boxSectionsById = new Map();

  function normalizedCoordinate(value) {
    const rounded = Number(Number(value).toFixed(6));
    return Object.is(rounded, -0) ? 0 : rounded;
  }

  function node(point) {
    const coordinates = finitePoint(point, 'node').map(normalizedCoordinate);
    const key = coordinates.join('|');
    if (nodeByKey.has(key)) return nodeByKey.get(key);
    const id = nodes.length + 1;
    nodes.push({ id, coordinates });
    nodeByKey.set(key, id);
    return id;
  }

  function member(start, end, sectionId, source) {
    const node1 = node(start);
    const node2 = node(end);
    if (node1 === node2) return null;
    const pair = node1 < node2 ? `${node1}|${node2}` : `${node2}|${node1}`;
    const key = `${pair}|${sectionId}`;
    if (elementKeys.has(key)) return null;
    elementKeys.add(key);
    const element = { id: elements.length + 1, node1, node2, sectionId, source };
    elements.push(element);
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
    return element;
  }

  const adaptiveRecords = skeleton.instances.filter((record) => Array.isArray(record.adaptivePointsM));
  for (const record of adaptiveRecords) {
    if (record.adaptivePointsM.length !== 2) continue;
    const isConcrete = String(record.family).startsWith('BRG_LOD300_RC_');
    member(record.adaptivePointsM[0], record.adaptivePointsM[1], isConcrete ? SECTION_RC_LINK : SECTION_STEEL, 'revit_adaptive');
  }

  const deckRecords = skeleton.instances.filter((record) => /^BRG_3SP300_PSC_CBG_SEG_\d{2}$/.test(String(record.family)));
  for (const record of deckRecords) {
    const familyIndex = Number(String(record.family).slice(-2));
    if (!Number.isInteger(familyIndex) || familyIndex < 1 || familyIndex > 20) continue;
    for (let localX = 0; localX <= REVIT_SEGMENT_LENGTH_M; localX += ANALYSIS_SEGMENT_LENGTH_M) {
      const center = transformPoint(record, [localX, 0, 0]).map(normalizedCoordinate);
      deckStations.set(center.join('|'), center);
      if (localX === REVIT_SEGMENT_LENGTH_M) continue;
      const stationIndex = (familyIndex - 1) * REVIT_SEGMENT_LENGTH_M + localX;
      const section = cantileverBoxSection(stationIndex);
      boxSectionsById.set(section.id, section);
      member(
        center,
        transformPoint(record, [localX + ANALYSIS_SEGMENT_LENGTH_M, 0, 0]),
        section.id,
        'psc_box_segment'
      );
    }
  }
  const orderedStations = [...deckStations.values()].sort((left, right) => left[0] - right[0]);

  for (const record of skeleton.instances.filter((item) => item.family === 'BRG_3SP300_RC_ARCH_RIB_200M')) {
    let previous = null;
    for (let index = 0; index <= 40; index += 1) {
      const x = -100 + index * 5;
      const ratio = Math.min(1, Math.abs(x) / 100);
      const point = transformPoint(record, [x, 0, 18 * (1 - ratio * ratio)]);
      if (previous) member(previous, point, SECTION_ARCH, 'arch_rib');
      previous = point;
    }
  }

  const localMembers = new Map([
    ['BRG_3SP300_RC_TOWER_LEG_A', [[-3, 0, 0], [-0.85, 0, 22]]],
    ['BRG_3SP300_RC_TOWER_LEG_B', [[3, 0, 0], [0.85, 0, 22]]],
    ['BRG_3SP300_RC_TOWER_CROSSBEAM', [[0, -5.2, 0], [0, 5.2, 0]]],
    ['BRG_3SP300_RC_TOWER_BASE_BEAM', [[0, -6.5, 0], [0, 6.5, 0]]],
    ['BRG_3SP300_RC_TOWER_CAP', [[0, -8, -0.75], [0, 8, -0.75]]],
    ['BRG_3SP300_RC_PYLON_UPPER_LEG_S', [[0, -7.2, 0], [0, -4.8, 30]]],
    ['BRG_3SP300_RC_PYLON_UPPER_LEG_N', [[0, 7.2, 0], [0, 4.8, 30]]],
    ['BRG_3SP300_RC_PYLON_CROSSBEAM_MID', [[0, -6.3, 0], [0, 6.3, 0]]],
    ['BRG_3SP300_RC_PYLON_CROSSBEAM_TOP', [[0, -5.55, 0], [0, 5.55, 0]]]
  ]);
  for (const record of skeleton.instances) {
    const local = localMembers.get(record.family);
    if (local) member(transformPoint(record, local[0]), transformPoint(record, local[1]), SECTION_TOWER, 'tower_pylon');
  }

  const stayRuns = [0, 20, 38, 55, 72, 88];
  for (const record of skeleton.instances.filter((item) => /^BRG_3SP300_STAY_CABLE_PAIR_\d{2}$/.test(String(item.family)))) {
    const index = Number(String(record.family).slice(-2));
    const run = stayRuns[index];
    const height = 7.5 + 4.5 * index;
    for (const side of [-1, 1]) {
      const pylonY = side * (7.2 - (2.4 * height) / 30);
      const top = transformPoint(record, [0, pylonY + side * 1.05, height]);
      const deck = transformPoint(record, [run, side * 7.2, 0.35]);
      member(top, deck, SECTION_CABLE, 'stay_cable');
    }
  }

  for (const record of skeleton.instances.filter((item) => item.family === 'BRG_3SP300_RC_BORED_PILE_D1500_L20M')) {
    const bottom = transformPoint(record, [0, 0, -20]);
    const top = transformPoint(record, [0, 0, 0]);
    member(bottom, top, SECTION_PILE, 'pile');
    fixedNodeIds.add(node(bottom));
  }

  for (const record of skeleton.instances.filter((item) => item.family === 'BRG_3SP300_RC_END_ABUTMENT')) {
    member(transformPoint(record, [0, 0, -17.8]), transformPoint(record, [0, 0, 0.1]), SECTION_RC_LINK, 'abutment');
    member(transformPoint(record, [0, -6, 0.1]), transformPoint(record, [0, 6, 0.1]), SECTION_RC_LINK, 'abutment');
  }
  for (const record of skeleton.instances.filter((item) => item.family === 'BRG_3SP300_RC_MAIN_PILE_CAP')) {
    member(transformPoint(record, [0, -6.5, -1.25]), transformPoint(record, [0, 6.5, -1.25]), SECTION_RC_LINK, 'pile_cap');
  }
  for (const record of skeleton.instances.filter((item) => item.family === 'BRG_3SP300_RC_ABUTMENT_PILE_CAP')) {
    member(transformPoint(record, [0, -7, -1.25]), transformPoint(record, [0, 7, -1.25]), SECTION_RC_LINK, 'pile_cap');
  }

  const deckEndpointIds = [];
  for (const station of orderedStations) {
    if (station !== orderedStations[0] && station !== orderedStations.at(-1)) continue;
    deckEndpointIds.push(node(station));
  }

  const boxSections = [...boxSectionsById.values()].sort((left, right) => left.id - right.id);

  const lines = [
    '*UNIT',
    '; FORCE, LENGTH, HEAT, TEMPER',
    ' KN, M, KJ, C',
    '*STRUCTYPE',
    '; iSTYP, iMASS, iSMAS, bMASSOFFSET, bSELFWEIGHT, GRAV, TEMPER, bALIGNBEAM, bALIGNSLAB, bROTRIGID',
    ' 0, 0, 1, NO, YES, 9.806, 0, NO, NO, NO',
    '*NODE',
    '; iNO, X, Y, Z',
    ...nodes.map(({ id, coordinates }) => ` ${id}, ${coordinates[0]}, ${coordinates[1]}, ${coordinates[2]}`),
    '*ELEMENT',
    '; iEL, TYPE, iMAT, iPRO, iN1, iN2, ANGLE',
    ...elements.map((element) => ` ${element.id}, BEAM, 1, ${element.sectionId}, ${element.node1}, ${element.node2}, 0`),
    '*MATERIAL',
    '; Geometry-transfer placeholder only; properties require engineer verification',
    ' 1, CONC, C50_ASSUMED, 0, 0, , C, NO, 0.05, 2, 34500000, 0.2, 0.00001, 25, 0',
    '*SECTION',
    '; Civil 2022 DBUSER idealisations plus variable-depth hollow PSC box sections',
    ...SECTIONS.map(rectangularSectionLine),
    ...boxSections.map(boxSectionLine),
    '*CONSTRAINT',
    '; NODE_LIST, CONST(Dx,Dy,Dz,Rx,Ry,Rz), GROUP'
  ];
  if (deckEndpointIds.length === 2) {
    lines.push(` ${deckEndpointIds[0]}, 111000,`);
    lines.push(` ${deckEndpointIds[1]}, 011000,`);
  }
  if (fixedNodeIds.size > 0) lines.push(` ${[...fixedNodeIds].join(' ')}, 111000,`);

  const content = canonicalizeMct(lines.join('\n'));
  const validation = validateMct(content, { requireVersion: false, requireEndData: false });
  if (!validation.ok) {
    throw new Error(`Generated Revit bridge failed validation: ${validation.errors.map((item) => item.message).join(' ')}`);
  }
  return {
    content,
    sha256: validation.sha256,
    byteLength: validation.byteLength,
    summary: validation.summary,
    warnings: validation.warnings,
    deliveryMode: 'MCT_COMMAND_SHELL',
    source: {
      schema: skeleton.schema,
      documentTitle: skeleton.documentTitle,
      documentPath: skeleton.documentPath,
      activeView: skeleton.activeView,
      exportedInstances: skeleton.instances.length,
      exportedFamilies: skeleton.familyCount,
      includedElementsBySource: Object.fromEntries([...sourceCounts.entries()].sort()),
      pscBox: {
        revitSegmentRecords: deckRecords.length,
        cantileverArms: deckRecords.filter((record) => String(record.family).endsWith('_01')).length,
        analysisSegmentLengthM: ANALYSIS_SEGMENT_LENGTH_M,
        analysisElements: sourceCounts.get('psc_box_segment') ?? 0,
        sectionCount: boxSections.length,
        topWidthM: 12,
        depthM: { tower: 10.5, remoteEnd: 3.5 },
        bottomWidthM: { tower: 9.4, remoteEnd: 7 },
        topThicknessM: 0.45,
        bottomThicknessM: { tower: 0.9, remoteEnd: 0.45 },
        webThicknessM: 0.7
      }
    },
    disclaimer: 'Variable-depth PSC box geometry transfer for visual and analytical-model setup only. Materials, connectivity, tendons, construction stages, loads, supports and design require bridge-engineer verification.'
  };
}
