// Dựng MCT dầm hộp PSC từ khung xương cầu xuất từ Revit (scripts/ExportRevitBridgeSkeleton.csx).
//   node build-revit-bridge.js <skeleton.json> [output.mct]
// Mặc định output nằm trong MIDAS_WORKDIR (hoặc ./midas-work); không ghi đè file có sẵn.
import fs from 'node:fs/promises';
import path from 'node:path';
import { generateRevitBridgeMct } from './src/revit-bridge.js';

const [, , sourceArg, outputArg] = process.argv;
if (!sourceArg) {
  console.error('Cách dùng: node build-revit-bridge.js <skeleton.json> [output.mct]');
  process.exit(2);
}
const workdir = path.resolve(process.env.MIDAS_WORKDIR || path.join(import.meta.dirname, 'midas-work'));
const sourcePath = path.resolve(sourceArg);
const outputPath = path.resolve(outputArg || path.join(workdir, 'revit-bridge-psc-box.mct'));
const reportPath = outputPath.replace(/\.mct$/i, '') + '.generation.json';

const skeleton = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
const generated = generateRevitBridgeMct(skeleton);
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, generated.content, { encoding: 'utf8', flag: 'wx' });
const { content, ...report } = generated;
await fs.writeFile(reportPath, `${JSON.stringify({ ...report, sourcePath, outputPath }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
console.log(JSON.stringify({ ok: true, outputPath, reportPath, ...report }, null, 2));
