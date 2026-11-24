import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: process.execPath, args: ['server.js'], cwd: process.cwd() });
const client = new Client({ name: 'midas-safe-demo', version: '0.3.0' }, { capabilities: {} });
await client.connect(transport);

const spec = { lengthM: 6, segments: 6, widthM: 0.3, heightM: 0.5 };
const previewResult = await client.callTool({ name: 'midas_preview_beam', arguments: { spec } });
const preview = JSON.parse(previewResult.content[0].text);
console.log(JSON.stringify({
  status: 'PREVIEW_ONLY',
  sha256: preview.sha256,
  summary: preview.summary,
  deliveryMode: preview.deliveryMode,
  note: 'No file was written. Commit requires this exact hash.'
}, null, 2));

await transport.close();
