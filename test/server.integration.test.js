import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP server exposes preview and guarded commit end to end', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'midas-mcp-integration-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve('server.js')],
    cwd: process.cwd(),
    env: { ...process.env, MIDAS_WORKDIR: workspace }
  });
  const client = new Client({ name: 'integration-test', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert(listed.tools.some((tool) => tool.name === 'midas_preview_beam'));
    assert(listed.tools.some((tool) => tool.name === 'midas_preview_revit_bridge'));
    assert(listed.tools.some((tool) => tool.name === 'midas_commit_revit_bridge'));
    assert(listed.tools.some((tool) => tool.name === 'midas_ui_stage_mct'));
    assert(listed.tools.some((tool) => tool.name === 'midas_ui_run_staged'));
    assert(!listed.tools.some((tool) => tool.name === 'midas_write_mct'));

    const spec = { lengthM: 9, segments: 3 };
    const previewCall = await client.callTool({ name: 'midas_preview_beam', arguments: { spec } });
    const preview = JSON.parse(previewCall.content[0].text);
    assert.equal(preview.summary.elements, 3);

    const commitCall = await client.callTool({
      name: 'midas_commit_beam',
      arguments: { file: 'integration-beam.mct', spec, expectedSha256: preview.sha256 }
    });
    const committed = JSON.parse(commitCall.content[0].text);
    assert.equal(committed.sha256, preview.sha256);
    assert.equal((await fs.stat(path.join(workspace, 'integration-beam.mct'))).isFile(), true);
  } finally {
    await transport.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
