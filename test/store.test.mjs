import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store, StoreError, MAX_INLINE_BYTES } from '../server/store.mjs';
import { tempDir } from './helpers.mjs';

function freshStore() {
  return new Store(tempDir('store'));
}

test('a sent message lands in the recipient inbox and opens a thread', () => {
  const store = freshStore();
  const msg = store.createMessage({ from: 'alice', to: 'bob', subject: 'hi', body: 'hello' });

  assert.equal(msg.status, 'queued');
  assert.equal(msg.to, 'bob');
  assert.ok(fs.existsSync(path.join(store.dirs.inbox, 'bob', msg.id)));

  const events = store.readThread(msg.thread_id);
  assert.equal(events[0].type, 'thread.created');
  assert.deepEqual(events[0].participants, ['alice', 'bob']);
  assert.equal(events[1].type, 'message.sent');
});

test('status walks queued to delivered to read', () => {
  const store = freshStore();
  const msg = store.createMessage({ from: 'alice', to: 'bob', subject: 'hi', body: 'hello' });

  const [delivered] = store.inbox('bob');
  assert.equal(delivered.status, 'delivered');
  assert.ok(delivered.delivered_at);
  assert.equal(store.getMessage(msg.id).status, 'delivered');

  const read = store.ackRead('bob', msg.id);
  assert.equal(read.status, 'read');
  assert.ok(read.read_at);
  assert.equal(store.inbox('bob').length, 0, 'acked message leaves the inbox');
});

test('delivery is at-least-once: an unacked message comes back on the next tick', () => {
  const store = freshStore();
  store.createMessage({ from: 'alice', to: 'bob', subject: 'hi', body: 'hello' });

  assert.equal(store.inbox('bob').length, 1);
  const second = store.inbox('bob');
  assert.equal(second.length, 1, 'still queued for bob because nothing acked it');
  assert.equal(second[0].status, 'delivered', 'but it is no longer marked queued');
});

test('replying inherits the parent thread', () => {
  const store = freshStore();
  const first = store.createMessage({ from: 'alice', to: 'bob', subject: 'q', body: '?' });
  const reply = store.createMessage({ from: 'bob', to: 'alice', subject: 're: q', body: '!', replyTo: first.id });
  assert.equal(reply.thread_id, first.thread_id);
});

test('only the recipient can ack', () => {
  const store = freshStore();
  const msg = store.createMessage({ from: 'alice', to: 'bob', subject: 'hi', body: 'hello' });
  assert.throws(() => store.ackRead('alice', msg.id), (e) => e.code === 'not_recipient');
});

test('an inline body over the threshold is refused with a pointer to the offer flow', () => {
  const store = freshStore();
  const tooBig = 'x'.repeat(MAX_INLINE_BYTES + 1);
  assert.throws(
    () => store.createMessage({ from: 'alice', to: 'bob', subject: 'big', body: tooBig }),
    (e) => e.code === 'payload_too_large' && e.status === 413,
  );
});

test('agent and thread ids cannot escape the data folder', () => {
  const store = freshStore();
  for (const bad of ['../../etc', 'a/b', '.hidden', '']) {
    assert.throws(
      () => store.createMessage({ from: 'alice', to: bad, subject: 'x', body: 'y' }),
      StoreError,
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

test('an agent cannot message itself', () => {
  const store = freshStore();
  assert.throws(
    () => store.createMessage({ from: 'alice', to: 'alice', subject: 'x', body: 'y' }),
    (e) => e.code === 'self_send',
  );
});

test('accepted offer becomes a message carrying a verified blob', () => {
  const store = freshStore();
  const payload = Buffer.from('z'.repeat(MAX_INLINE_BYTES + 100));
  const offer = store.createOffer({
    from: 'alice',
    to: 'bob',
    subject: 'big file',
    sizeBytes: payload.length,
    contentType: 'text/plain',
  });

  assert.deepEqual(store.pendingOffersFor('bob').map((o) => o.id), [offer.id]);
  store.respondOffer({ agent: 'bob', offerId: offer.id, accept: true });
  assert.deepEqual(store.answeredOffersBy('alice').map((o) => o.status), ['accepted']);

  const { message } = store.attachPayload({ agent: 'alice', offerId: offer.id, buffer: payload });
  assert.equal(message.body, null);
  assert.equal(message.blob.size, payload.length);
  assert.deepEqual(store.readBlob(message.id), payload);
  assert.equal(store.getOffer(offer.id).status, 'uploaded');
  assert.deepEqual(store.inbox('bob').map((m) => m.id), [message.id]);
  assert.equal(message.thread_id, offer.thread_id, 'payload stays in the offer thread');
});

test('a rejected offer refuses the upload', () => {
  const store = freshStore();
  const payload = Buffer.from('nope');
  const offer = store.createOffer({ from: 'alice', to: 'bob', subject: 'big', sizeBytes: payload.length });
  store.respondOffer({ agent: 'bob', offerId: offer.id, accept: false, reason: 'not now' });

  assert.throws(
    () => store.attachPayload({ agent: 'alice', offerId: offer.id, buffer: payload }),
    (e) => e.code === 'offer_not_accepted',
  );
  assert.equal(store.getOffer(offer.id).reason, 'not now');
});

test('an upload whose size disagrees with the offer is refused', () => {
  const store = freshStore();
  const offer = store.createOffer({ from: 'alice', to: 'bob', subject: 'big', sizeBytes: 10 });
  store.respondOffer({ agent: 'bob', offerId: offer.id, accept: true });
  assert.throws(
    () => store.attachPayload({ agent: 'alice', offerId: offer.id, buffer: Buffer.from('too short') }),
    (e) => e.code === 'size_mismatch',
  );
});

test('an offer cannot be answered twice, or answered by the sender', () => {
  const store = freshStore();
  const offer = store.createOffer({ from: 'alice', to: 'bob', subject: 'big', sizeBytes: 10 });
  assert.throws(
    () => store.respondOffer({ agent: 'alice', offerId: offer.id, accept: true }),
    (e) => e.code === 'not_recipient',
  );
  store.respondOffer({ agent: 'bob', offerId: offer.id, accept: true });
  assert.throws(
    () => store.respondOffer({ agent: 'bob', offerId: offer.id, accept: false }),
    (e) => e.code === 'offer_settled',
  );
});

test('threads are append-only history, listed per participant', () => {
  const store = freshStore();
  const msg = store.createMessage({ from: 'alice', to: 'bob', subject: 'hi', body: 'hello' });
  store.inbox('bob');
  store.ackRead('bob', msg.id);
  store.createMessage({ from: 'carol', to: 'dave', subject: 'other', body: 'x' });

  const events = store.readThread(msg.thread_id).map((e) => e.type);
  assert.deepEqual(events, ['thread.created', 'message.sent', 'message.delivered', 'message.read']);

  const alicesThreads = store.listThreads('alice');
  assert.equal(alicesThreads.length, 1, "alice does not see carol and dave's thread");
  assert.equal(alicesThreads[0].thread_id, msg.thread_id);
  assert.equal(store.listThreads(null).length, 2);
});
