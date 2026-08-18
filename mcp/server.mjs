#!/usr/bin/env node
// MCP stdio server. Identical on both machines; only AGENT_ID and BROKER_URL
// differ. Uses the low-level SDK Server with plain JSON Schema so the tool
// surface does not depend on a validator version.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AgentLink } from './agent.mjs';

const AGENT_ID = process.env.AGENT_ID;
const BROKER_URL = process.env.BROKER_URL ?? 'http://127.0.0.1:8787';
const BROKER_TOKEN = process.env.BROKER_TOKEN ?? null;

if (!AGENT_ID) {
  console.error('agent-tunnel: AGENT_ID env var is required (e.g. AGENT_ID=alice)');
  process.exit(1);
}

const link = new AgentLink({ baseUrl: BROKER_URL, agentId: AGENT_ID, token: BROKER_TOKEN });

const TOOLS = [
  {
    name: 'check_inbox',
    description:
      'Monitor tick. Returns new messages addressed to this agent, any transfer offers waiting on this ' +
      'agent to accept or reject, and updates on offers this agent sent (accepted payloads upload during ' +
      'this call). Call on an interval to stay in sync with the other agent. `quiet: true` means nothing happened.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => link.checkInbox(),
  },
  {
    name: 'send_message',
    description:
      'Send a message to another agent. Payload size is handled automatically: anything under 64KB goes ' +
      'straight through, anything larger is offered to the recipient first and uploads only once they accept.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient agent id, e.g. "bob".' },
        subject: { type: 'string', description: 'Short one-line summary of what this message is.' },
        body: { type: 'string', description: 'Message content.' },
        content_type: { type: 'string', description: 'MIME type of the body. Defaults to text/plain.' },
        thread_id: { type: 'string', description: 'Continue an existing thread. Omit to start a new one.' },
        reply_to: { type: 'string', description: 'Message id being replied to; inherits that thread.' },
      },
      required: ['to', 'subject', 'body'],
      additionalProperties: false,
    },
    handler: (a) =>
      link.send({
        to: a.to,
        subject: a.subject,
        body: a.body,
        contentType: a.content_type,
        threadId: a.thread_id,
        replyTo: a.reply_to,
      }),
  },
  {
    name: 'ack_message',
    description:
      'Mark a message as read once it has been processed. This is the read receipt the sender sees, and it ' +
      'removes the message from this inbox. Unacked messages are redelivered on every check_inbox.',
    inputSchema: {
      type: 'object',
      properties: { message_id: { type: 'string' } },
      required: ['message_id'],
      additionalProperties: false,
    },
    handler: (a) => link.ack(a.message_id),
  },
  {
    name: 'respond_offer',
    description:
      'Accept or reject an incoming large-payload transfer offer surfaced by check_inbox. Nothing is ' +
      'transferred until accepted.',
    inputSchema: {
      type: 'object',
      properties: {
        offer_id: { type: 'string' },
        accept: { type: 'boolean' },
        reason: { type: 'string', description: 'Optional explanation, most useful when rejecting.' },
      },
      required: ['offer_id', 'accept'],
      additionalProperties: false,
    },
    handler: (a) => link.respondOffer({ offerId: a.offer_id, accept: a.accept, reason: a.reason ?? null }),
  },
  {
    name: 'fetch_payload',
    description:
      'Retrieve the payload of a large message. Small text payloads come back inline; anything else is ' +
      'written to disk and the path returned.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string' },
        inline: { type: 'boolean', description: 'Force inline (true) or force save-to-disk (false).' },
      },
      required: ['message_id'],
      additionalProperties: false,
    },
    handler: (a) => link.fetchPayload(a.message_id, { inline: a.inline ?? null }),
  },
  {
    name: 'message_status',
    description: 'Check whether a sent message is still queued, has been delivered, or has been read.',
    inputSchema: {
      type: 'object',
      properties: { message_id: { type: 'string' } },
      required: ['message_id'],
      additionalProperties: false,
    },
    handler: (a) => link.status(a.message_id),
  },
  {
    name: 'list_threads',
    description: 'List conversation threads this agent takes part in, most recently active first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => link.listThreads(),
  },
  {
    name: 'read_thread',
    description:
      'Read the full append-only history of one thread: every send, delivery, read receipt, offer and ' +
      'transfer, in order. Nothing is ever removed from a thread.',
    inputSchema: {
      type: 'object',
      properties: { thread_id: { type: 'string' } },
      required: ['thread_id'],
      additionalProperties: false,
    },
    handler: (a) => link.readThread(a.thread_id),
  },
  {
    name: 'list_agents',
    description: 'List agents known to the broker and when each was last seen.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => link.listAgents(),
  },
  {
    name: 'broker_health',
    description: 'Confirm the broker is reachable and report this agent id, the broker URL, and its auth mode.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => link.hello(),
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

const server = new Server(
  { name: 'agent-tunnel', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = byName.get(request.params.name);
  if (!tool) {
    return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }] };
  }
  try {
    const result = await tool.handler(request.params.arguments ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: err.code ?? 'error', message: err.message }, null, 2) }],
    };
  }
});

await server.connect(new StdioServerTransport());
console.error(`agent-tunnel: ${AGENT_ID} connected to ${BROKER_URL}`);
