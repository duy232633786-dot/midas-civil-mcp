import { createHash } from 'node:crypto';

export const MAX_MCT_BYTES = 1_000_000;

const SAFE_COMMANDS = new Set([
  'VERSION',
  'UNIT',
  'STRUCTYPE',
  'NODE',
  'ELEMENT',
  'MATERIAL',
  'SECTION',
  'CONSTRAINT',
  'ENDDATA'
]);

const SINGLETON_COMMANDS = new Set(['VERSION', 'UNIT', 'STRUCTYPE', 'ENDDATA']);

export function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function canonicalizeMct(content) {
  if (typeof content !== 'string') throw new TypeError('MCT content must be text.');
  const normalized = content.replace(/\r\n?/g, '\n');
  return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be a finite number.`);
  return number;
}

function boundedNumber(value, label, min, max) {
  const number = finiteNumber(value, label);
  if (number < min || number > max) {
    throw new RangeError(`${label} must be between ${min} and ${max}.`);
  }
  return number;
}

function boundedInteger(value, label, min, max) {
  const number = finiteNumber(value, label);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new RangeError(`${label} must be an integer between ${min} and ${max}.`);
  }
  return number;
}

function safeName(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(value)) {
    throw new TypeError(`${label} must start with a letter and contain only letters, digits, _ or - (max 32 characters).`);
  }
  return value;
}

function positiveId(value) {
  if (!/^\d+$/.test(String(value).trim())) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function parseCsv(line) {
  return line.split(';', 1)[0].split(',').map((field) => field.trim());
}

function parseNodeSelection(value) {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  const matches = [...compact.matchAll(/(\d+)\s*to\s*(\d+)|\d+/gi)];
  const residue = compact.replace(/(\d+)\s*to\s*(\d+)|\d+/gi, '').replace(/\s+/g, '');
  if (residue) return null;

  const ids = [];
  for (const match of matches) {
    if (match[1] !== undefined) {
      const start = positiveId(match[1]);
      const end = positiveId(match[2]);
      if (!start || !end || end < start || end - start > 10_000) return null;
      for (let id = start; id <= end; id += 1) ids.push(id);
    } else {
      const id = positiveId(match[0]);
      if (!id) return null;
      ids.push(id);
    }
  }
  return ids.length ? ids : null;
}

export function validateMct(content, { requireVersion = false, requireEndData = true } = {}) {
  const errors = [];
  const warnings = [];
  let canonicalContent;

  try {
    canonicalContent = canonicalizeMct(content);
  } catch (error) {
    return { ok: false, errors: [{ code: 'MCT_NOT_TEXT', line: 0, message: error.message }], warnings, summary: null };
  }

  const byteLength = Buffer.byteLength(canonicalContent, 'utf8');
  if (byteLength > MAX_MCT_BYTES) {
    errors.push({ code: 'MCT_TOO_LARGE', line: 0, message: `MCT exceeds ${MAX_MCT_BYTES} bytes.` });
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(canonicalContent)) {
    errors.push({ code: 'MCT_CONTROL_CHARACTER', line: 0, message: 'MCT contains a forbidden control character.' });
  }

  const commands = [];
  const commandCounts = new Map();
  const records = [];
  let currentCommand = null;
  let endDataLine = null;
  const lines = canonicalContent.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const raw = lines[index];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith(';')) continue;

    if (trimmed.startsWith('*')) {
      const match = /^\*([A-Z][A-Z0-9_]*)\s*(?:;.*)?$/i.exec(trimmed);
      if (!match) {
        errors.push({ code: 'MCT_BAD_COMMAND_LINE', line: lineNumber, message: 'Command lines may contain only *COMMAND and an optional comment.' });
        currentCommand = null;
        continue;
      }
      const command = match[1].toUpperCase();
      if (!SAFE_COMMANDS.has(command)) {
        errors.push({ code: 'MCT_COMMAND_NOT_ALLOWED', line: lineNumber, message: `Command *${command} is not in the safe allowlist.` });
        currentCommand = null;
        continue;
      }
      if (endDataLine !== null) {
        errors.push({ code: 'MCT_AFTER_ENDDATA', line: lineNumber, message: 'No command may follow *ENDDATA.' });
      }
      const count = (commandCounts.get(command) ?? 0) + 1;
      commandCounts.set(command, count);
      if (SINGLETON_COMMANDS.has(command) && count > 1) {
        errors.push({ code: 'MCT_DUPLICATE_COMMAND', line: lineNumber, message: `*${command} may appear only once.` });
      }
      commands.push(command);
      currentCommand = command;
      if (command === 'ENDDATA') endDataLine = lineNumber;
      continue;
    }

    if (!currentCommand) {
      errors.push({ code: 'MCT_DATA_WITHOUT_COMMAND', line: lineNumber, message: 'Data appears before a recognized command.' });
      continue;
    }
    if (currentCommand === 'ENDDATA') {
      errors.push({ code: 'MCT_DATA_AFTER_ENDDATA', line: lineNumber, message: 'No data may follow *ENDDATA.' });
      continue;
    }
    records.push({ command: currentCommand, line: lineNumber, fields: parseCsv(raw) });
  }

  const requiredCommands = ['UNIT', 'STRUCTYPE', 'NODE', 'ELEMENT', 'MATERIAL', 'SECTION'];
  if (requireEndData) requiredCommands.push('ENDDATA');
  for (const required of requiredCommands) {
    if (!commandCounts.has(required)) {
      errors.push({ code: 'MCT_MISSING_COMMAND', line: 0, message: `Required command *${required} is missing.` });
    }
  }
  if (requireVersion && !commandCounts.has('VERSION')) {
    errors.push({ code: 'MCT_VERSION_REQUIRED', line: 0, message: '*VERSION is required for file import mode.' });
  } else if (!commandCounts.has('VERSION')) {
    warnings.push({ code: 'MCT_VERSION_OMITTED', line: 0, message: 'No *VERSION: use MCT Command Shell, or add the exact compatible version before file import.' });
  }
  if (commandCounts.has('ENDDATA') && commands.at(-1) !== 'ENDDATA') {
    errors.push({ code: 'MCT_ENDDATA_NOT_LAST', line: endDataLine ?? 0, message: '*ENDDATA must be the final command.' });
  }

  const nodes = new Map();
  const materials = new Map();
  const sections = new Map();
  const elements = new Map();
  const constraints = [];

  function addUnique(map, id, record, label) {
    if (map.has(id)) {
      errors.push({ code: `MCT_DUPLICATE_${label.toUpperCase()}_ID`, line: record.line, message: `Duplicate ${label} ID ${id}.` });
      return false;
    }
    map.set(id, record);
    return true;
  }

  for (const record of records) {
    const { command, fields, line } = record;
    if (command === 'NODE') {
      const id = positiveId(fields[0]);
      const coordinates = fields.slice(1, 4).map(Number);
      if (!id || fields.length < 4 || coordinates.some((value) => !Number.isFinite(value))) {
        errors.push({ code: 'MCT_BAD_NODE', line, message: 'NODE requires: positive ID, finite X, Y and Z.' });
      } else if (addUnique(nodes, id, record, 'node')) {
        record.coordinates = coordinates;
      }
    } else if (command === 'UNIT') {
      if (fields.length < 4 || String(fields[0]).toUpperCase() !== 'KN' || String(fields[1]).toUpperCase() !== 'M') {
        errors.push({ code: 'MCT_BAD_UNIT', line, message: 'Safe subset requires KN, M and explicit heat/temperature units.' });
      }
    } else if (command === 'STRUCTYPE') {
      const yesNoIndexes = [3, 4, 7, 8, 9];
      const booleansValid = yesNoIndexes.every((index) => /^(YES|NO)$/i.test(fields[index] ?? ''));
      if (fields.length < 10 || !booleansValid || !Number.isFinite(Number(fields[5])) || !Number.isFinite(Number(fields[6]))) {
        errors.push({ code: 'MCT_BAD_STRUCTYPE', line, message: 'Civil 2022 STRUCTYPE requires 10 fields including bSELFWEIGHT and bROTRIGID.' });
      }
    } else if (command === 'MATERIAL') {
      const id = positiveId(fields[0]);
      const numericData = fields.slice(10, 15).every((value) => Number.isFinite(Number(value)));
      if (!id || fields.length < 15 || String(fields[1]).toUpperCase() !== 'CONC' || !/^(YES|NO)$/i.test(fields[7] ?? '') || fields[9] !== '2' || !numericData) {
        errors.push({ code: 'MCT_BAD_MATERIAL', line, message: 'Safe Civil 2022 MATERIAL requires CONC, damping ratio, selector 2 and five numeric material values.' });
      } else {
        addUnique(materials, id, record, 'material');
      }
    } else if (command === 'SECTION') {
      const id = positiveId(fields[0]);
      const dimensions = fields.slice(14, 24).map(Number);
      const shape = String(fields[12]).toUpperCase();
      const commonInvalid = (
        !id || fields.length < 25 || String(fields[1]).toUpperCase() !== 'DBUSER' ||
        !/^(YES|NO)$/i.test(fields[10] ?? '') || !/^(YES|NO)$/i.test(fields[11] ?? '') ||
        !new Set(['SB', 'B']).has(shape) || fields[13] !== '2' ||
        dimensions.some((value) => !Number.isFinite(value)) ||
        !Number.isInteger(Number(fields[24])) || Number(fields[24]) < 0
      );
      const solidRectangleInvalid = shape === 'SB' && (dimensions[0] <= 0 || dimensions[1] <= 0);
      const boxInvalid = shape === 'B' && (
        dimensions.slice(0, 6).some((value) => value <= 0) ||
        dimensions[2] + dimensions[5] >= dimensions[0] ||
        dimensions[4] > dimensions[1] ||
        dimensions[3] * 2 >= Math.min(dimensions[1], dimensions[4])
      );
      if (commonInvalid || solidRectangleInvalid || boxInvalid) {
        errors.push({ code: 'MCT_BAD_SECTION', line, message: 'Safe Civil 2022 SECTION requires DBUSER, bSD, bWE, selector 2 and a valid SB rectangle or B hollow-box profile.' });
      } else {
        addUnique(sections, id, record, 'section');
      }
    } else if (command === 'ELEMENT') {
      const id = positiveId(fields[0]);
      const type = String(fields[1] ?? '').toUpperCase();
      const materialId = positiveId(fields[2]);
      const sectionId = positiveId(fields[3]);
      const node1 = positiveId(fields[4]);
      const node2 = positiveId(fields[5]);
      if (!id || type !== 'BEAM' || !materialId || !sectionId || !node1 || !node2 || fields.length < 7) {
        errors.push({ code: 'MCT_BAD_ELEMENT', line, message: 'Safe subset supports BEAM records with positive element, material, section and two node IDs.' });
      } else if (addUnique(elements, id, record, 'element')) {
        Object.assign(record, { materialId, sectionId, node1, node2 });
      }
    } else if (command === 'CONSTRAINT') {
      const nodeIds = parseNodeSelection(fields[0] ?? '');
      if (!nodeIds || !/^[01]{6}$/.test(fields[1] ?? '') || String(fields[2] ?? '').trim() !== '') {
        errors.push({ code: 'MCT_BAD_CONSTRAINT', line, message: 'Safe CONSTRAINT requires a node list, a six-digit 0/1 restraint code and an empty boundary-group field.' });
      } else {
        constraints.push({ ...record, nodeIds });
      }
    }
  }

  for (const element of elements.values()) {
    if (!nodes.has(element.node1)) errors.push({ code: 'MCT_ELEMENT_NODE_MISSING', line: element.line, message: `Element references missing node ${element.node1}.` });
    if (!nodes.has(element.node2)) errors.push({ code: 'MCT_ELEMENT_NODE_MISSING', line: element.line, message: `Element references missing node ${element.node2}.` });
    if (!materials.has(element.materialId)) errors.push({ code: 'MCT_ELEMENT_MATERIAL_MISSING', line: element.line, message: `Element references missing material ${element.materialId}.` });
    if (!sections.has(element.sectionId)) errors.push({ code: 'MCT_ELEMENT_SECTION_MISSING', line: element.line, message: `Element references missing section ${element.sectionId}.` });
    const first = nodes.get(element.node1)?.coordinates;
    const second = nodes.get(element.node2)?.coordinates;
    if (first && second && first.every((value, index) => value === second[index])) {
      errors.push({ code: 'MCT_ZERO_LENGTH_ELEMENT', line: element.line, message: `Element ${element.fields[0]} has zero length.` });
    }
  }
  for (const constraint of constraints) {
    for (const nodeId of constraint.nodeIds) {
      if (!nodes.has(nodeId)) errors.push({ code: 'MCT_CONSTRAINT_NODE_MISSING', line: constraint.line, message: `Constraint references missing node ${nodeId}.` });
    }
  }

  const summary = {
    commands,
    nodes: nodes.size,
    elements: elements.size,
    materials: materials.size,
    sections: sections.size,
    constraints: constraints.length
  };

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary,
    sha256: sha256Text(canonicalContent),
    byteLength,
    canonicalContent
  };
}

export function normalizeBeamSpec(input = {}) {
  const spec = {
    lengthM: boundedNumber(input.lengthM ?? 6, 'lengthM', 0.1, 10_000),
    segments: boundedInteger(input.segments ?? 6, 'segments', 1, 1_000),
    widthM: boundedNumber(input.widthM ?? 0.3, 'widthM', 0.01, 100),
    heightM: boundedNumber(input.heightM ?? 0.5, 'heightM', 0.01, 100),
    elasticModulusKnM2: boundedNumber(input.elasticModulusKnM2 ?? 30_000_000, 'elasticModulusKnM2', 1, 1e12),
    poisson: boundedNumber(input.poisson ?? 0.2, 'poisson', -0.999, 0.499),
    thermalCoefficient: boundedNumber(input.thermalCoefficient ?? 0.00001, 'thermalCoefficient', -1, 1),
    weightDensityKnM3: boundedNumber(input.weightDensityKnM3 ?? 25, 'weightDensityKnM3', 0.000001, 10_000),
    materialName: safeName(input.materialName ?? 'C30', 'materialName'),
    sectionName: safeName(input.sectionName ?? 'RECT_300x500', 'sectionName'),
    mctVersion: input.mctVersion === undefined || input.mctVersion === null || input.mctVersion === ''
      ? null
      : String(input.mctVersion)
  };
  if (spec.mctVersion !== null && !/^\d+\.\d+(?:\.\d+)?$/.test(spec.mctVersion)) {
    throw new TypeError('mctVersion must look like 9.1.0. Leave it blank for MCT Command Shell mode.');
  }
  return spec;
}

export function generateBeamMct(input = {}) {
  const spec = normalizeBeamSpec(input);
  const lines = [];
  if (spec.mctVersion) lines.push('*VERSION', ` ${spec.mctVersion}`);
  lines.push(
    '*UNIT',
    '; FORCE, LENGTH, HEAT, TEMPER',
    ' KN, M, KJ, C',
    '*STRUCTYPE',
    '; iSTYP, iMASS, iSMAS, bMASSOFFSET, bSELFWEIGHT, GRAV, TEMPER, bALIGNBEAM, bALIGNSLAB, bROTRIGID',
    ' 0, 0, 1, NO, YES, 9.806, 0, NO, NO, NO',
    '*NODE',
    '; iNO, X, Y, Z'
  );
  for (let index = 0; index <= spec.segments; index += 1) {
    const x = (spec.lengthM * index) / spec.segments;
    lines.push(` ${index + 1}, ${Number(x.toFixed(12))}, 0, 0`);
  }
  lines.push('*ELEMENT', '; iEL, TYPE, iMAT, iPRO, iN1, iN2, ANGLE');
  for (let index = 0; index < spec.segments; index += 1) {
    lines.push(` ${index + 1}, BEAM, 1, 1, ${index + 1}, ${index + 2}, 0`);
  }
  lines.push(
    '*MATERIAL',
    '; iMAT, TYPE, MNAME, SPHEAT, HEATCO, PLAST, TUNIT, bMASS, [DATA1]',
    ` 1, CONC, ${spec.materialName}, 0, 0, , C, NO, 0.05, 2, ${spec.elasticModulusKnM2}, ${spec.poisson}, ${spec.thermalCoefficient}, ${spec.weightDensityKnM3}, 0`,
    '*SECTION',
    '; iSEC, TYPE, SNAME, OFFSET, ... DBUSER rectangle data',
    ` 1, DBUSER, ${spec.sectionName}, CC, 0, 0, 0, 0, 0, 0, YES, NO, SB, 2, ${spec.heightM}, ${spec.widthM}, 0, 0, 0, 0, 0, 0, 0, 0, 0`,
    '*CONSTRAINT',
    '; NODE_LIST, CONST(Dx,Dy,Dz,Rx,Ry,Rz), GROUP',
    ' 1, 111000,',
    ` ${spec.segments + 1}, 011000,`
  );
  if (spec.mctVersion) lines.push('*ENDDATA');

  const content = canonicalizeMct(lines.join('\n'));
  const validation = validateMct(content, {
    requireVersion: Boolean(spec.mctVersion),
    requireEndData: Boolean(spec.mctVersion)
  });
  if (!validation.ok) {
    throw new Error(`Generated beam failed validation: ${validation.errors.map((item) => item.message).join(' ')}`);
  }
  return {
    content,
    sha256: validation.sha256,
    byteLength: validation.byteLength,
    summary: validation.summary,
    warnings: validation.warnings,
    spec,
    deliveryMode: spec.mctVersion ? 'MCT_FILE_IMPORT' : 'MCT_COMMAND_SHELL'
  };
}
