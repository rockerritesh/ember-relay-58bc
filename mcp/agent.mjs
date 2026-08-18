// The agent-side logic, kept free of MCP protocol details so it can be tested
// directly against a real broker.
//
// The one piece of state that lives here rather than in the broker is the
// outbox stash: when a payload is too large to send inline, the bytes wait on
// the sender's own disk until the recipient accepts. Nothing crosses the wire
// until there is a yes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_INLINE_BYTES } from '../shared/limits.mjs';
import { BrokerClient } from './client.mjs';

const TEXTUAL = /^(text\/|application\/(json|xml|yaml|x-ndjson)|.*\+json$)/;
const MAX_INLINE_RETURN = 32 * 1024;

export function defaultStateDir() {
  return process.env.AGENT_TUNNEL_HOME ?? path.join(os.homedir(), '.agent-tunnel');
}

export class AgentLink {
  constructor({ baseUrl, agentId, token = null, stateDir = defaultStateDir() }) {
    this.agentId = agentId;
    this.client = new BrokerClient({ baseUrl, agentId, token });
    this.stateDir = stateDir;
    this.outboxDir = path.join(stateDir, 'outbox', agentId);
    this.downloadDir = path.join(stateDir, 'downloads', agentId);
    fs.mkdirSync(this.outboxDir, { recursive: true });
    fs.mkdirSync(this.downloadDir, { recursive: true });
  }

  #stashPath(offerId) {
    if (!/^ofr_[a-z0-9]+$/.test(offerId)) throw new Error(`bad offer id ${offerId}`);
    return path.join(this.outboxDir, offerId);
  }

  // ---- sending ------------------------------------------------------------

  // The caller never picks a mode. Anything that fits goes inline; anything
  // bigger becomes an offer whose bytes wait in the outbox for an accept.
  async send({ to, subject, body, contentType = 'text/plain', threadId, replyTo }) {
    const buffer = Buffer.from(body, 'utf8');
    if (buffer.length <= MAX_INLINE_BYTES) {
      const message = await this.client.sendMessage({ to, subject, body, contentType, threadId, replyTo });
      return {
        mode: 'inline',
        status: message.status,
        message_id: message.id,
        thread_id: message.thread_id,
        bytes: buffer.length,
      };
    }

    const offer = await this.client.createOffer({
      to,
      subject,
      sizeBytes: buffer.length,
      contentType,
      threadId,
      replyTo,
    });
    fs.writeFileSync(this.#stashPath(offer.id), buffer);
    return {
      mode: 'offer',
      status: offer.status,
      offer_id: offer.id,
      thread_id: offer.thread_id,
      bytes: buffer.length,
      note: `Payload is held locally. It uploads automatically on the check_inbox tick after ${to} accepts.`,
    };
  }

  // ---- the monitor tick ---------------------------------------------------

  // One call does all three jobs: collect what arrived, surface offers waiting
  // on this agent's decision, and finish off offers this agent sent that have
  // since been answered.
  async checkInbox() {
    const [{ messages }, { incoming, answered }] = await Promise.all([
      this.client.inbox(),
      this.client.offers(),
    ]);

    const outbox_updates = [];
    for (const offer of answered) {
      try {
        outbox_updates.push(await this.#settle(offer));
      } catch (err) {
        outbox_updates.push({ offer_id: offer.id, status: 'error', error: err.message });
      }
    }

    return {
      agent: this.agentId,
      messages: messages.map((m) => this.#summarize(m)),
      offers_awaiting_response: incoming.map((o) => ({
        offer_id: o.id,
        thread_id: o.thread_id,
        from: o.from,
        subject: o.subject,
        size_bytes: o.size_bytes,
        content_type: o.content_type,
        action: 'call respond_offer to accept or reject',
      })),
      outbox_updates,
      quiet: messages.length === 0 && incoming.length === 0 && outbox_updates.length === 0,
    };
  }

  async #settle(offer) {
    const stash = this.#stashPath(offer.id);

    if (offer.status === 'rejected') {
      fs.rmSync(stash, { force: true });
      await this.client.closeOffer(offer.id);
      return { offer_id: offer.id, status: 'rejected', to: offer.to, subject: offer.subject, reason: offer.reason };
    }

    if (!fs.existsSync(stash)) {
      // Accepted, but the bytes are gone — a wipe of ~/.agent-tunnel, or the
      // offer was made from a different machine. Say so instead of hanging.
      await this.client.closeOffer(offer.id);
      return {
        offer_id: offer.id,
        status: 'error',
        error: 'accepted but the local payload stash is missing; resend the message',
      };
    }

    const buffer = fs.readFileSync(stash);
    const { message } = await this.client.uploadOffer({
      offerId: offer.id,
      buffer,
      contentType: offer.content_type,
    });
    fs.rmSync(stash, { force: true });
    return {
      offer_id: offer.id,
      status: 'sent',
      message_id: message.id,
      thread_id: message.thread_id,
      to: offer.to,
      subject: offer.subject,
      bytes: buffer.length,
    };
  }

  #summarize(message) {
    return {
      message_id: message.id,
      thread_id: message.thread_id,
      from: message.from,
      subject: message.subject,
      content_type: message.content_type,
      status: message.status,
      created_at: message.created_at,
      reply_to: message.reply_to,
      ...(message.body !== null
        ? { body: message.body }
        : {
            body: null,
            payload: {
              size_bytes: message.blob?.size ?? null,
              sha256: message.blob?.sha256 ?? null,
              action: 'call fetch_payload with this message_id to read it',
            },
          }),
    };
  }

  // ---- responses ----------------------------------------------------------

  async ack(messageId) {
    const message = await this.client.ackMessage(messageId);
    return { message_id: message.id, status: message.status, read_at: message.read_at };
  }

  async respondOffer({ offerId, accept, reason = null }) {
    const offer = await this.client.respondOffer({ offerId, accept, reason });
    return {
      offer_id: offer.id,
      status: offer.status,
      from: offer.from,
      subject: offer.subject,
      note: accept
        ? `${offer.from} uploads on its next check_inbox tick; the payload then shows up here as a normal message.`
        : 'Sender has been told no; nothing will be uploaded.',
    };
  }

  // Large payloads land on disk by default — an agent should not have a
  // multi-megabyte blob shoved into its context without asking.
  async fetchPayload(messageId, { inline = null } = {}) {
    const message = await this.client.getMessage(messageId);
    const buffer = await this.client.getPayload(messageId);
    const textual = TEXTUAL.test(message.content_type ?? '');
    const wantsInline = inline ?? (textual && buffer.length <= MAX_INLINE_RETURN);

    if (wantsInline) {
      return {
        message_id: messageId,
        bytes: buffer.length,
        content_type: message.content_type,
        body: buffer.toString('utf8'),
      };
    }

    const file = path.join(this.downloadDir, messageId);
    fs.writeFileSync(file, buffer);
    return {
      message_id: messageId,
      bytes: buffer.length,
      content_type: message.content_type,
      saved_to: file,
      note: 'Payload written to disk rather than returned inline. Read the file if you need its contents.',
    };
  }

  // ---- history and status -------------------------------------------------

  async status(messageId) {
    const m = await this.client.getMessage(messageId);
    return {
      message_id: m.id,
      thread_id: m.thread_id,
      from: m.from,
      to: m.to,
      subject: m.subject,
      status: m.status,
      created_at: m.created_at,
      delivered_at: m.delivered_at,
      read_at: m.read_at,
    };
  }

  listThreads() {
    return this.client.listThreads();
  }

  readThread(threadId) {
    return this.client.readThread(threadId);
  }

  listAgents() {
    return this.client.listAgents();
  }

  async hello() {
    const [health] = await Promise.all([this.client.health(), this.client.heartbeat()]);
    return { agent: this.agentId, broker: this.client.baseUrl, ...health };
  }
}
