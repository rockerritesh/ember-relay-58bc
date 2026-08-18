// Drives mcp/server.mjs as a real subprocess over stdio, the way Claude Code
// will. Catches protocol and schema mistakes the in-process tests cannot.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startBroker, tempDir } from './helpers.mjs';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'server.mjs');

async function connect(agentId, baseUrl, stateDir) {
  const client = new Client({ name: 'test-harness', version: '0.0.0' }, { capabilities: {} });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: { ...process.env, AGENT_ID: agentId, BROKER_URL: baseUrl, AGENT_TUNNEL_HOME: stateDir },
      stderr: 'ignore',
    }),
  );
  return client;
}

function unwrap(result) {
  assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
  return JSON.parse(result.content[0].text);
}

test('MCP servers on both ends exchange a message end to end', async (t) => {
  const broker = await startBroker();
  const stateDir = tempDir('mcp-state');

  const alice = await connect('alice', broker.baseUrl, stateDir);
  const bob = await connect('bob', broker.baseUrl, stateDir);
  t.after(async () => {
    await alice.close();
    await bob.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
    await broker.stop();
  });

  const { tools } = await alice.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'ack_message',
    'broker_health',
    'check_inbox',
    'fetch_payload',
    'list_agents',
    'list_threads',
    'message_status',
    'read_thread',
    'respond_offer',
    'send_message',
  ]);
  for (const tool of tools) {
    assert.ok(tool.description?.length > 20, `${tool.name} needs a usable description`);
    assert.equal(tool.inputSchema.type, 'object');
  }

  const health = unwrap(await alice.callTool({ name: 'broker_health', arguments: {} }));
  assert.equal(health.ok, true);
  assert.equal(health.agent, 'alice');

  const sent = unwrap(
    await alice.callTool({
      name: 'send_message',
      arguments: { to: 'bob', subject: 'hello over MCP', body: 'it works' },
    }),
  );
  assert.equal(sent.mode, 'inline');

  const tick = unwrap(await bob.callTool({ name: 'check_inbox', arguments: {} }));
  assert.equal(tick.messages.length, 1);
  assert.equal(tick.messages[0].body, 'it works');

  unwrap(await bob.callTool({ name: 'ack_message', arguments: { message_id: sent.message_id } }));
  const status = unwrap(
    await alice.callTool({ name: 'message_status', arguments: { message_id: sent.message_id } }),
  );
  assert.equal(status.status, 'read');

  const history = unwrap(await alice.callTool({ name: 'read_thread', arguments: { thread_id: sent.thread_id } }));
  assert.deepEqual(history.events.map((e) => e.type), [
    'thread.created',
    'message.sent',
    'message.delivered',
    'message.read',
  ]);
});

test('a tool error comes back as an MCP error result, not a crash', async (t) => {
  const broker = await startBroker();
  const stateDir = tempDir('mcp-state');
  const alice = await connect('alice', broker.baseUrl, stateDir);
  t.after(async () => {
    await alice.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
    await broker.stop();
  });

  const bad = await alice.callTool({ name: 'ack_message', arguments: { message_id: 'msg_nope' } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /unknown_message/);

  // The server is still alive and serving after the failure.
  const health = unwrap(await alice.callTool({ name: 'broker_health', arguments: {} }));
  assert.equal(health.ok, true);
});
