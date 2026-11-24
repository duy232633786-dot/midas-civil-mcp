import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { generateBeamMct, validateMct } from './src/mct.js';
import { generateRevitBridgeMct } from './src/revit-bridge.js';
import { commitBeamFile, commitRevitBridgeFile, listWorkspaceFiles, readWorkspaceFile } from './src/workspace.js';
import { inspectInstallation, launchMidas } from './src/installation.js';
import {
  closeCommandShell,
  inspectMidasWindows,
  runStagedCommandShell,
  stageMctInCommandShell
} from './src/ui-windows.js';

const root = path.resolve(process.env.MIDAS_WORKDIR || path.join(process.cwd(), 'midas-work'));
const exe = process.env.MIDAS_EXE || 'C:\\Program Files\\MIDAS\\midas Civil\\CVLw.exe';

const beamProperties = {
  lengthM: { type: 'number', minimum: 0.1, maximum: 10000, default: 6 },
  segments: { type: 'integer', minimum: 1, maximum: 1000, default: 6 },
  widthM: { type: 'number', minimum: 0.01, maximum: 100, default: 0.3 },
  heightM: { type: 'number', minimum: 0.01, maximum: 100, default: 0.5 },
  elasticModulusKnM2: { type: 'number', minimum: 1, maximum: 1e12, default: 30000000 },
  poisson: { type: 'number', minimum: -0.999, maximum: 0.499, default: 0.2 },
  thermalCoefficient: { type: 'number', minimum: -1, maximum: 1, default: 0.00001 },
  weightDensityKnM3: { type: 'number', exclusiveMinimum: 0, maximum: 10000, default: 25 },
  materialName: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,31}$', default: 'C30' },
  sectionName: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,31}$', default: 'RECT_300x500' },
  mctVersion: { type: 'string', pattern: '^\\d+\\.\\d+(?:\\.\\d+)?$', description: 'Optional. Omit for MCT Command Shell mode.' }
};

const beamSpecSchema = { type: 'object', properties: beamProperties, additionalProperties: false };
const json = (value) => JSON.stringify(value, null, 2);
const result = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : json(value) }] });
const stagedByProcess = new Map();

const tools = [
  {
    name: 'midas_inspect_installation',
    description: 'Read-only check of the configured MIDAS Civil executable and whether CVLw.exe is running. Never reads or changes licensing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'midas_preview_beam',
    description: 'Generate and validate a simple supported beam in memory. Does not write files or control MIDAS. Returns the exact SHA-256 required for commit.',
    inputSchema: { type: 'object', properties: { spec: beamSpecSchema }, additionalProperties: false }
  },
  {
    name: 'midas_commit_beam',
    description: 'Write exactly a previously previewed beam MCT file. Requires the matching preview SHA-256; overwrite requires the inspected existing-file SHA-256 too.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', pattern: '^[^\\\\/]+\\.mct$' },
        spec: beamSpecSchema,
        expectedSha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
        overwrite: { type: 'boolean', default: false },
        expectedExistingSha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' }
      },
      required: ['file', 'expectedSha256'],
      additionalProperties: false
    }
  },
  {
    name: 'midas_preview_revit_bridge',
    description: 'Read a controlled Revit bridge-skeleton JSON and generate a MIDAS frame with a one-metre, variable-depth PSC hollow box girder in memory. Does not write or control MIDAS. Returns source and MCT SHA-256 values required for commit.',
    inputSchema: {
      type: 'object',
      properties: { sourceFile: { type: 'string', pattern: '^[^\\\\/]+\\.json$' } },
      required: ['sourceFile'],
      additionalProperties: false
    }
  },
  {
    name: 'midas_commit_revit_bridge',
    description: 'Write exactly a previously previewed Revit-to-MIDAS bridge MCT with variable-depth PSC box sections. Requires matching source and MCT hashes; overwrite is separately guarded.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceFile: { type: 'string', pattern: '^[^\\\\/]+\\.json$' },
        file: { type: 'string', pattern: '^[^\\\\/]+\\.mct$' },
        expectedSourceSha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
        expectedSha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
        overwrite: { type: 'boolean', default: false },
        expectedExistingSha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' }
      },
      required: ['sourceFile', 'file', 'expectedSourceSha256', 'expectedSha256'],
      additionalProperties: false
    }
  },
  {
    name: 'midas_validate_mct',
    description: 'Fail-closed validation of MCT text using a safe beam-frame command subset. Does not write or execute anything.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string' },
        requireVersion: { type: 'boolean', default: false },
        commandShellMode: { type: 'boolean', default: false, description: 'When true, *ENDDATA is not required.' }
      },
      required: ['content'],
      additionalProperties: false
    }
  },
  {
    name: 'midas_list_files',
    description: 'List allowed text files in the controlled MIDAS workspace.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'midas_read_file',
    description: 'Read one allowed text file from the controlled MIDAS workspace and return its SHA-256.',
    inputSchema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'], additionalProperties: false }
  },
  {
    name: 'midas_prepare_command_shell',
    description: 'Validate an MCT file and return its exact content plus visible MIDAS Civil 2022 MCT Command Shell loading steps. Does not paste or run it.',
    inputSchema: { type: 'object', properties: { file: { type: 'string', pattern: '^[^\\\\/]+\\.mct$' } }, required: ['file'], additionalProperties: false }
  },
  {
    name: 'midas_ui_inspect',
    description: 'Read-only list of visible MIDAS Civil windows and whether MCT Command Shell is open.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'midas_ui_stage_mct',
    description: 'Put a validated workspace MCT into the visible MCT Command Shell for an exact CVLw process. Requires the exact file SHA-256 and never presses Run.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', pattern: '^[^\\\\/]+\\.mct$' },
        expectedSha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
        targetProcessId: { type: 'integer', minimum: 1 }
      },
      required: ['file', 'expectedSha256', 'targetProcessId'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'midas_ui_run_staged',
    description: 'Press Run only for MCT staged by this server, after rechecking process, window title and exact SHA-256. This modifies the open MIDAS model and requires explicit confirmation that no valuable unsaved model will be harmed.',
    inputSchema: {
      type: 'object',
      properties: {
        targetProcessId: { type: 'integer', minimum: 1 },
        expectedSha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
        expectedWindowTitle: { type: 'string', minLength: 1 },
        confirmModifyOpenModel: { type: 'boolean', const: true },
        confirmNoValuableUnsavedModel: { type: 'boolean', const: true }
      },
      required: ['targetProcessId', 'expectedSha256', 'expectedWindowTitle', 'confirmModifyOpenModel', 'confirmNoValuableUnsavedModel'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'midas_ui_close_command_shell',
    description: 'Close the MCT Command Shell without pressing Run, provided its target window still matches the staged record.',
    inputSchema: {
      type: 'object',
      properties: {
        targetProcessId: { type: 'integer', minimum: 1 },
        expectedWindowTitle: { type: 'string', minLength: 1 }
      },
      required: ['targetProcessId', 'expectedWindowTitle'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'midas_open',
    description: 'Explicitly launch MIDAS Civil visibly. Does not bypass licensing, login or authentication.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'midas_open_mct',
    description: 'Explicitly launch MIDAS Civil with a validated versioned MCT path. It does not silently execute MCT commands.',
    inputSchema: { type: 'object', properties: { file: { type: 'string', pattern: '^[^\\\\/]+\\.mct$' } }, required: ['file'], additionalProperties: false }
  },
  {
    name: 'midas_nx_status',
    description: 'Report whether optional MIDAS CIVIL NX REST settings are present, without revealing the MAPI key or making a network request.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
];

const server = new Server(
  { name: 'midas-civil-safe-gateway', version: '0.5.0' },
  {
    capabilities: { tools: {} },
    instructions: 'MIDAS Civil 2022 safety workflow: preview, commit with the exact SHA-256, then stage in MCT Command Shell. Never call midas_ui_run_staged unless the user explicitly confirms the exact visible target and that no valuable unsaved model can be harmed. Civil 2022 uses MCT; REST applies only to CIVIL NX. Do not bypass licensing or claim engineering verification.'
  }
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const args = params.arguments ?? {};
  try {
    switch (params.name) {
      case 'midas_inspect_installation':
        return result(await inspectInstallation(exe));
      case 'midas_preview_beam': {
        const preview = generateBeamMct(args.spec ?? {});
        return result({
          sha256: preview.sha256,
          bytes: preview.byteLength,
          deliveryMode: preview.deliveryMode,
          spec: preview.spec,
          summary: preview.summary,
          warnings: preview.warnings,
          content: preview.content,
          nextStep: 'Call midas_commit_beam with the same spec and this exact sha256.'
        });
      }
      case 'midas_commit_beam':
        return result(await commitBeamFile({
          root,
          file: args.file,
          spec: args.spec ?? {},
          expectedSha256: args.expectedSha256,
          overwrite: args.overwrite ?? false,
          expectedExistingSha256: args.expectedExistingSha256 ?? null
        }));
      case 'midas_preview_revit_bridge': {
        const source = await readWorkspaceFile(root, args.sourceFile);
        if (path.extname(args.sourceFile).toLowerCase() !== '.json') throw new Error('sourceFile must be JSON.');
        let skeleton;
        try { skeleton = JSON.parse(source.content); } catch { throw new Error('Revit skeleton is not valid JSON.'); }
        const preview = generateRevitBridgeMct(skeleton);
        return result({
          sourceFile: args.sourceFile,
          sourceSha256: source.sha256,
          sha256: preview.sha256,
          bytes: preview.byteLength,
          deliveryMode: preview.deliveryMode,
          summary: preview.summary,
          source: preview.source,
          warnings: preview.warnings,
          disclaimer: preview.disclaimer,
          nextStep: 'Call midas_commit_revit_bridge with this sourceSha256 and sha256.'
        });
      }
      case 'midas_commit_revit_bridge':
        return result(await commitRevitBridgeFile({
          root,
          sourceFile: args.sourceFile,
          file: args.file,
          expectedSourceSha256: args.expectedSourceSha256,
          expectedSha256: args.expectedSha256,
          overwrite: args.overwrite ?? false,
          expectedExistingSha256: args.expectedExistingSha256 ?? null
        }));
      case 'midas_validate_mct': {
        const validation = validateMct(args.content, {
          requireVersion: args.requireVersion ?? false,
          requireEndData: args.commandShellMode !== true
        });
        const { canonicalContent, ...publicValidation } = validation;
        return result(publicValidation);
      }
      case 'midas_list_files':
        return result({ root, files: await listWorkspaceFiles(root) });
      case 'midas_read_file':
        return result(await readWorkspaceFile(root, args.file));
      case 'midas_prepare_command_shell': {
        const file = await readWorkspaceFile(root, args.file);
        const validation = validateMct(file.content, { requireVersion: false, requireEndData: false });
        if (!validation.ok) throw new Error(`MCT validation failed: ${validation.errors.map((item) => item.message).join(' ')}`);
        return result({
          file: file.file,
          fullPath: file.fullPath,
          sha256: validation.sha256,
          validation: { ok: true, summary: validation.summary, warnings: validation.warnings },
          content: validation.canonicalContent,
          steps: [
            'Open a NEW empty MIDAS model so an existing model is not modified.',
            'Open Tools > MCT Command Shell.',
            'Paste the exact content above into the command window.',
            'Review it visibly, then press Run only in the empty model.'
          ]
        });
      }
      case 'midas_ui_inspect':
        return result(await inspectMidasWindows());
      case 'midas_ui_stage_mct': {
        const file = await readWorkspaceFile(root, args.file);
        const validation = validateMct(file.content, { requireVersion: false, requireEndData: false });
        if (!validation.ok) throw new Error(`MCT validation failed: ${validation.errors.map((item) => item.message).join(' ')}`);
        if (validation.sha256.toLowerCase() !== String(args.expectedSha256).toLowerCase()) {
          throw new Error('Workspace file hash does not match expectedSha256. Nothing was staged.');
        }
        const staged = await stageMctInCommandShell({
          targetProcessId: args.targetProcessId,
          mctFile: file.fullPath,
          expectedSha256: validation.sha256
        });
        stagedByProcess.set(Number(args.targetProcessId), {
          sha256: validation.sha256,
          windowTitle: staged.windowTitle,
          file: args.file
        });
        return result({ ...staged, file: args.file, nextStep: 'Visually verify the target. Run requires a separate midas_ui_run_staged call with both confirmations.' });
      }
      case 'midas_ui_run_staged': {
        if (args.confirmModifyOpenModel !== true || args.confirmNoValuableUnsavedModel !== true) {
          throw new Error('Both explicit model-modification confirmations are required.');
        }
        const targetProcessId = Number(args.targetProcessId);
        const staged = stagedByProcess.get(targetProcessId);
        if (!staged) throw new Error('No MCT was staged by this server for that process.');
        if (staged.sha256.toLowerCase() !== String(args.expectedSha256).toLowerCase()) throw new Error('Staged SHA-256 does not match. Run was not pressed.');
        if (staged.windowTitle !== args.expectedWindowTitle) throw new Error('Expected MIDAS window title does not match the staged target. Run was not pressed.');
        const executed = await runStagedCommandShell({
          targetProcessId,
          expectedSha256: staged.sha256,
          expectedWindowTitle: staged.windowTitle
        });
        stagedByProcess.delete(targetProcessId);
        return result({ ...executed, file: staged.file, note: 'Run was pressed visibly. This is model generation, not an engineering analysis result.' });
      }
      case 'midas_ui_close_command_shell': {
        const targetProcessId = Number(args.targetProcessId);
        const staged = stagedByProcess.get(targetProcessId);
        if (staged && staged.windowTitle !== args.expectedWindowTitle) throw new Error('Expected window title does not match the staged target.');
        const closed = await closeCommandShell({ targetProcessId, expectedWindowTitle: args.expectedWindowTitle });
        stagedByProcess.delete(targetProcessId);
        return result(closed);
      }
      case 'midas_open':
        return result(await launchMidas(exe));
      case 'midas_open_mct': {
        const file = await readWorkspaceFile(root, args.file);
        const validation = validateMct(file.content, { requireVersion: true });
        if (!validation.ok) throw new Error(`Versioned file-import validation failed: ${validation.errors.map((item) => item.message).join(' ')}`);
        return result(await launchMidas(exe, [file.fullPath]));
      }
      case 'midas_nx_status': {
        const baseUrl = process.env.MIDAS_NX_BASE_URL || '';
        let origin = null;
        try { origin = baseUrl ? new URL(baseUrl).origin : null; } catch { origin = 'invalid'; }
        return result({
          configured: Boolean(baseUrl && process.env.MIDAS_NX_MAPI_KEY),
          baseUrlPresent: Boolean(baseUrl),
          baseUrlOrigin: origin,
          mapiKeyPresent: Boolean(process.env.MIDAS_NX_MAPI_KEY),
          networkRequestMade: false,
          note: 'MIDAS Civil 2022 uses the MCT workflow; REST API support is for MIDAS CIVIL NX.'
        });
      }
      default:
        throw new Error(`Unknown tool: ${params.name}`);
    }
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
});

await server.connect(new StdioServerTransport());
