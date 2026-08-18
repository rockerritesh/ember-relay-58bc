// Two AgentLinks against one broker: the same code path both machines run,
// minus the network hop and the MCP framing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AgentLink } from '../mcp/agent.mjs';
import { MAX_INLINE_BYTES } from '../shared/limits.mjs';
import { startBroker, tempDir } from './helpers.mjs';

async function twoAgents(t) {
  const broker = await startBroker();
  const stateDir = tempDir('state');
  t.after(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
    return broker.stop();
  });
  return {
    broker,
    alice: new AgentLink({ baseUrl: broker.baseUrl, agentId: 'alice', stateDir }),
    bob: new AgentLink({ baseUrl: broker.baseUrl, agentId: 'bob', stateDir }),
  };
}

test('small message: send, monitor tick, read receipt', async (t) => {
  const { alice, bob } = await twoAgents(t);

  const quiet = await bob.checkInbox();
  assert.equal(quiet.quiet, true, 'a fresh inbox reports nothing to do');

  const sent = await alice.send({ to: 'bob', subject: 'ping', body: 'are you there?' });
  assert.equal(sent.mode, 'inline');
  assert.equal(sent.status, 'queued');

  const tick = await bob.checkInbox();
  assert.equal(tick.quiet, false);
  assert.equal(tick.messages.length, 1);
  assert.equal(tick.messages[0].from, 'alice');
  assert.equal(tick.messages[0].body, 'are you there?');

  assert.equal((await alice.status(sent.message_id)).status, 'delivered');
  await bob.ack(sent.message_id);
  assert.equal((await alice.status(sent.message_id)).status, 'read');
  assert.equal((await bob.checkInbox()).quiet, true, 'acked message stops reappearing');
});

test('replies stay in one thread and the history records every step', async (t) => {
  const { alice, bob } = await twoAgents(t);

  const first = await alice.send({ to: 'bob', subject: 'question', body: 'what is the ETA?' });
  await bob.checkInbox();
  await bob.ack(first.message_id);
  const reply = await bob.send({
    to: 'alice',
    subject: 're: question',
    body: 'tomorrow',
    replyTo: first.message_id,
  });
  assert.equal(reply.thread_id, first.thread_id);

  await alice.checkInbox();
  await alice.ack(reply.message_id);

  const { events } = await alice.readThread(first.thread_id);
  assert.deepEqual(events.map((e) => e.type), [
    'thread.created',
    'message.sent',
    'message.delivered',
    'message.read',
    'message.sent',
    'message.delivered',
    'message.read',
  ]);

  const { threads } = await bob.listThreads();
  assert.equal(threads.length, 1);
  assert.deepEqual(threads[0].participants, ['alice', 'bob']);
});

test('large payload: offer waits for accept, then uploads on the senders own tick', async (t) => {
  const { alice, bob } = await twoAgents(t);
  const big = 'row,value\n'.repeat(10000);
  assert.ok(Buffer.byteLength(big) > MAX_INLINE_BYTES);

  const offered = await alice.send({ to: 'bob', subject: 'dataset', body: big, contentType: 'text/csv' });
  assert.equal(offered.mode, 'offer', 'size alone decides the mode; the agent never picks');
  assert.equal(offered.status, 'pending');

  // Nothing has crossed yet — bob sees an offer, not a message.
  const bobBefore = await bob.checkInbox();
  assert.equal(bobBefore.messages.length, 0);
  assert.deepEqual(bobBefore.offers_awaiting_response.map((o) => o.offer_id), [offered.offer_id]);
  assert.equal(bobBefore.offers_awaiting_response[0].size_bytes, Buffer.byteLength(big));

  // Alice's own tick is a no-op while the offer is unanswered.
  assert.deepEqual((await alice.checkInbox()).outbox_updates, []);

  await bob.respondOffer({ offerId: offered.offer_id, accept: true });

  // The upload happens inside alice's next monitor tick, with no follow-up call.
  const aliceTick = await alice.checkInbox();
  assert.equal(aliceTick.outbox_updates.length, 1);
  assert.equal(aliceTick.outbox_updates[0].status, 'sent');
  const messageId = aliceTick.outbox_updates[0].message_id;

  const bobAfter = await bob.checkInbox();
  assert.deepEqual(bobAfter.messages.map((m) => m.message_id), [messageId]);
  assert.equal(bobAfter.messages[0].body, null, 'large payloads are not inlined into the inbox');
  assert.equal(bobAfter.messages[0].payload.size_bytes, Buffer.byteLength(big));

  const payload = await bob.fetchPayload(messageId, { inline: true });
  assert.equal(payload.body, big);

  // And once settled, the tick is quiet again on both sides.
  assert.deepEqual((await alice.checkInbox()).outbox_updates, []);
});

test('large payload: rejection discards the local stash and never uploads', async (t) => {
  const { alice, bob } = await twoAgents(t);
  const big = 'x'.repeat(MAX_INLINE_BYTES + 1000);

  const offered = await alice.send({ to: 'bob', subject: 'huge', body: big });
  const stash = `${alice.outboxDir}/${offered.offer_id}`;
  assert.ok(fs.existsSync(stash), 'payload waits on the senders disk');

  await bob.respondOffer({ offerId: offered.offer_id, accept: false, reason: 'too big for me' });

  const tick = await alice.checkInbox();
  assert.equal(tick.outbox_updates.length, 1);
  assert.equal(tick.outbox_updates[0].status, 'rejected');
  assert.equal(tick.outbox_updates[0].reason, 'too big for me');
  assert.equal(fs.existsSync(stash), false, 'stash is cleaned up on rejection');

  assert.equal((await bob.checkInbox()).quiet, true, 'nothing was ever transferred');
  assert.deepEqual((await alice.checkInbox()).outbox_updates, [], 'rejection is reported once, then closed');
});

test('an accepted offer whose stash vanished reports an error instead of hanging', async (t) => {
  const { alice, bob } = await twoAgents(t);
  const offered = await alice.send({ to: 'bob', subject: 'huge', body: 'y'.repeat(MAX_INLINE_BYTES + 1) });
  await bob.respondOffer({ offerId: offered.offer_id, accept: true });

  fs.rmSync(`${alice.outboxDir}/${offered.offer_id}`);

  const tick = await alice.checkInbox();
  assert.equal(tick.outbox_updates[0].status, 'error');
  assert.match(tick.outbox_updates[0].error, /stash is missing/);
});

test('a big non-text payload is saved to disk rather than returned inline', async (t) => {
  const { alice, bob } = await twoAgents(t);
  const blob = 'B'.repeat(MAX_INLINE_BYTES + 5);

  const offered = await alice.send({
    to: 'bob',
    subject: 'binary',
    body: blob,
    contentType: 'application/octet-stream',
  });
  await bob.respondOffer({ offerId: offered.offer_id, accept: true });
  const messageId = (await alice.checkInbox()).outbox_updates[0].message_id;

  const fetched = await bob.fetchPayload(messageId);
  assert.equal(fetched.body, undefined);
  assert.ok(fetched.saved_to);
  assert.equal(fs.readFileSync(fetched.saved_to, 'utf8'), blob);
});

test('broker_health round-trips and registers the agent', async (t) => {
  const { alice, bob } = await twoAgents(t);
  const health = await alice.hello();
  assert.equal(health.ok, true);
  assert.equal(health.agent, 'alice');
  assert.equal(health.auth, 'open');

  const { agents } = await bob.listAgents();
  assert.deepEqual(agents.map((a) => a.agent_id), ['alice']);
});

test('an unreachable broker fails with a clear message, not a stack trace', async (t) => {
  const stateDir = tempDir('state');
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const orphan = new AgentLink({ baseUrl: 'http://127.0.0.1:1', agentId: 'alice', stateDir });
  await assert.rejects(orphan.checkInbox(), (e) => e.code === 'broker_unreachable');
});
