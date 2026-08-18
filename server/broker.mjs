// HTTP face of the message folder. Zero dependencies — node:http only.
//
// Auth is a single gate: `requireAuth`. With BROKER_TOKEN unset it passes
// everything through, which is the intended bring-up posture. Setting
// BROKER_TOKEN=<secret> turns on bearer checking for every route at once,
// so switching the broker from open to closed is one env var, not a refactor.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, StoreError, MAX_INLINE_BYTES } from './store.mjs';

const MAX_JSON_BYTES = 1 * 1024 * 1024;
const MAX_BLOB_BYTES = Number(process.env.MAX_BLOB_BYTES ?? 64 * 1024 * 1024);

function send(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload, null, 2));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    ...headers,
  });
  res.end(body);
}

function fail(res, status, code, message) {
  send(res, status, { error: code, message });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new StoreError('payload_too_large', `body exceeds ${limit} bytes`, 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req, MAX_JSON_BYTES);
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new StoreError('invalid_json', 'body must be a JSON object');
    }
    return parsed;
  } catch (err) {
    if (err instanceof StoreError) throw err;
    throw new StoreError('invalid_json', `could not parse JSON body: ${err.message}`);
  }
}

function requireAuth(req) {
  const expected = process.env.BROKER_TOKEN;
  if (!expected) return; // open by design until a token is configured
  const header = req.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (presented !== expected) {
    throw new StoreError('unauthorized', 'valid bearer token required', 401);
  }
}

function requiredParam(url, name) {
  const value = url.searchParams.get(name);
  if (!value) throw new StoreError('missing_param', `query parameter '${name}' is required`);
  return value;
}

export function createServer(store) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const segments = url.pathname.split('/').filter(Boolean);
    const method = req.method;

    try {
      if (segments[0] !== 'v1') {
        return fail(res, 404, 'not_found', `no route for ${method} ${url.pathname}`);
      }
      const [, resource, id, action] = segments;

      if (resource === 'health' && method === 'GET') {
        return send(res, 200, {
          ok: true,
          service: 'agent-tunnel-broker',
          data_dir: store.root,
          max_inline_bytes: MAX_INLINE_BYTES,
          max_blob_bytes: MAX_BLOB_BYTES,
          auth: process.env.BROKER_TOKEN ? 'bearer' : 'open',
        });
      }

      requireAuth(req);

      // ---- agents ---------------------------------------------------------
      if (resource === 'agents' && method === 'GET' && !id) {
        return send(res, 200, { agents: store.listAgents() });
      }
      if (resource === 'agents' && method === 'POST' && id === 'heartbeat') {
        const { agent } = await readJson(req);
        return send(res, 200, store.heartbeat(agent));
      }

      // ---- messages -------------------------------------------------------
      if (resource === 'messages' && method === 'POST' && !id) {
        const b = await readJson(req);
        const message = store.createMessage({
          from: b.from,
          to: b.to,
          subject: b.subject,
          body: b.body ?? null,
          contentType: b.content_type,
          threadId: b.thread_id,
          replyTo: b.reply_to,
        });
        return send(res, 201, message);
      }
      if (resource === 'messages' && method === 'GET' && id && !action) {
        const message = store.getMessage(id);
        if (!message) return fail(res, 404, 'unknown_message', `message ${id} not found`);
        return send(res, 200, message);
      }
      if (resource === 'messages' && method === 'POST' && id && action === 'ack') {
        const { agent } = await readJson(req);
        return send(res, 200, store.ackRead(agent, id));
      }
      if (resource === 'messages' && method === 'GET' && id && action === 'payload') {
        const message = store.getMessage(id);
        if (!message) return fail(res, 404, 'unknown_message', `message ${id} not found`);
        const buffer = store.readBlob(id);
        res.writeHead(200, {
          'content-type': message.content_type || 'application/octet-stream',
          'content-length': buffer.length,
        });
        return res.end(buffer);
      }

      // ---- inbox ----------------------------------------------------------
      if (resource === 'inbox' && method === 'GET') {
        const agent = requiredParam(url, 'agent');
        return send(res, 200, { agent, messages: store.inbox(agent) });
      }

      // ---- offers ---------------------------------------------------------
      if (resource === 'offers' && method === 'POST' && !id) {
        const b = await readJson(req);
        const offer = store.createOffer({
          from: b.from,
          to: b.to,
          subject: b.subject,
          sizeBytes: b.size_bytes,
          contentType: b.content_type,
          threadId: b.thread_id,
          replyTo: b.reply_to,
        });
        return send(res, 201, offer);
      }
      if (resource === 'offers' && method === 'GET' && !id) {
        const agent = requiredParam(url, 'agent');
        return send(res, 200, {
          agent,
          incoming: store.pendingOffersFor(agent),
          answered: store.answeredOffersBy(agent),
        });
      }
      if (resource === 'offers' && method === 'GET' && id && !action) {
        const offer = store.getOffer(id);
        if (!offer) return fail(res, 404, 'unknown_offer', `offer ${id} not found`);
        return send(res, 200, offer);
      }
      if (resource === 'offers' && method === 'POST' && id && action === 'respond') {
        const b = await readJson(req);
        return send(res, 200, store.respondOffer({
          agent: b.agent,
          offerId: id,
          accept: b.accept === true,
          reason: b.reason ?? null,
        }));
      }
      if (resource === 'offers' && method === 'PUT' && id && action === 'payload') {
        const agent = requiredParam(url, 'agent');
        const buffer = await readBody(req, MAX_BLOB_BYTES);
        const { offer, message } = store.attachPayload({ agent, offerId: id, buffer });
        return send(res, 201, { offer, message });
      }
      if (resource === 'offers' && method === 'POST' && id && action === 'close') {
        const { agent } = await readJson(req);
        return send(res, 200, store.closeOffer({ agent, offerId: id }));
      }

      // ---- threads --------------------------------------------------------
      if (resource === 'threads' && method === 'GET' && !id) {
        return send(res, 200, { threads: store.listThreads(url.searchParams.get('agent')) });
      }
      if (resource === 'threads' && method === 'GET' && id) {
        return send(res, 200, { thread_id: id, events: store.readThread(id) });
      }

      return fail(res, 404, 'not_found', `no route for ${method} ${url.pathname}`);
    } catch (err) {
      if (err instanceof StoreError) return fail(res, err.status, err.code, err.message);
      console.error('[broker] unhandled', err);
      return fail(res, 500, 'internal_error', err.message);
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '127.0.0.1';
  const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');
  const store = new Store(dataDir);
  createServer(store).listen(port, host, () => {
    console.log(`[broker] listening on http://${host}:${port}`);
    console.log(`[broker] message folder: ${store.root}`);
    console.log(`[broker] auth: ${process.env.BROKER_TOKEN ? 'bearer token required' : 'OPEN (no token set)'}`);
  });
}
