import test from 'node:test';
import assert from 'node:assert/strict';
import { startBroker, api } from './helpers.mjs';

test('HTTP surface', async (t) => {
  const broker = await startBroker();
  t.after(() => broker.stop());
  const call = (m, p, b) => api(broker.baseUrl, m, p, b);

  await t.test('health reports the folder it is serving and its auth mode', async () => {
    const res = await call('GET', '/v1/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data_dir, broker.store.root);
    assert.equal(res.body.auth, 'open');
  });

  await t.test('send, fetch inbox, ack, and watch status move', async () => {
    const sent = await call('POST', '/v1/messages', {
      from: 'alice',
      to: 'bob',
      subject: 'ping',
      body: 'are you there?',
    });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.status, 'queued');
    const id = sent.body.id;

    const inbox = await call('GET', '/v1/inbox?agent=bob');
    assert.equal(inbox.status, 200);
    assert.deepEqual(inbox.body.messages.map((m) => m.id), [id]);
    assert.equal(inbox.body.messages[0].body, 'are you there?');

    const acked = await call('POST', `/v1/messages/${id}/ack`, { agent: 'bob' });
    assert.equal(acked.body.status, 'read');

    const after = await call('GET', `/v1/messages/${id}`);
    assert.equal(after.body.status, 'read');
    assert.equal((await call('GET', '/v1/inbox?agent=bob')).body.messages.length, 0);
  });

  await t.test('the full offer handshake over HTTP', async () => {
    const payload = Buffer.from('data:'.repeat(20000));
    const offered = await call('POST', '/v1/offers', {
      from: 'alice',
      to: 'bob',
      subject: 'dataset',
      size_bytes: payload.length,
      content_type: 'text/csv',
    });
    assert.equal(offered.status, 201);
    const offerId = offered.body.id;

    const bobsOffers = await call('GET', '/v1/offers?agent=bob');
    assert.deepEqual(bobsOffers.body.incoming.map((o) => o.id), [offerId]);

    await call('POST', `/v1/offers/${offerId}/respond`, { agent: 'bob', accept: true });

    const alicesOffers = await call('GET', '/v1/offers?agent=alice');
    assert.deepEqual(alicesOffers.body.answered.map((o) => o.status), ['accepted']);

    const upload = await fetch(`${broker.baseUrl}/v1/offers/${offerId}/payload?agent=alice`, {
      method: 'PUT',
      headers: { 'content-type': 'text/csv' },
      body: payload,
    });
    assert.equal(upload.status, 201);
    const messageId = (await upload.json()).message.id;

    const fetched = await fetch(`${broker.baseUrl}/v1/messages/${messageId}/payload`);
    assert.equal(fetched.headers.get('content-type'), 'text/csv');
    assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), payload);
  });

  await t.test('errors carry a machine-readable code and the right status', async () => {
    assert.equal((await call('GET', '/v1/nope')).status, 404);
    assert.equal((await call('GET', '/v1/messages/msg_missing')).status, 404);

    const noAgent = await call('GET', '/v1/inbox');
    assert.equal(noAgent.status, 400);
    assert.equal(noAgent.body.error, 'missing_param');

    const noSubject = await call('POST', '/v1/messages', { from: 'alice', to: 'bob', body: 'x' });
    assert.equal(noSubject.status, 400);
    assert.equal(noSubject.body.error, 'missing_subject');

    const tooBig = await call('POST', '/v1/messages', {
      from: 'alice',
      to: 'bob',
      subject: 'big',
      body: 'x'.repeat(64 * 1024 + 1),
    });
    assert.equal(tooBig.status, 413);
    assert.equal(tooBig.body.error, 'payload_too_large');

    const badJson = await fetch(`${broker.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).error, 'invalid_json');
  });

  await t.test('agents and threads are listable', async () => {
    const agents = (await call('GET', '/v1/agents')).body.agents.map((a) => a.agent_id);
    assert.ok(agents.includes('alice') && agents.includes('bob'));

    const threads = (await call('GET', '/v1/threads?agent=alice')).body.threads;
    assert.ok(threads.length >= 2);
    const history = (await call('GET', `/v1/threads/${threads[0].thread_id}`)).body.events;
    assert.equal(history[0].type, 'thread.created');
  });
});

// Serial by design: this test mutates process.env for the whole broker.
test('setting BROKER_TOKEN closes every route except health', async (t) => {
  const broker = await startBroker();
  t.after(() => {
    delete process.env.BROKER_TOKEN;
    return broker.stop();
  });

  process.env.BROKER_TOKEN = 'sekret';

  assert.equal((await api(broker.baseUrl, 'GET', '/v1/health')).status, 200, 'health stays open');
  assert.equal((await api(broker.baseUrl, 'GET', '/v1/agents')).status, 401);
  assert.equal((await api(broker.baseUrl, 'GET', '/v1/health')).body.auth, 'bearer');

  const authed = await fetch(`${broker.baseUrl}/v1/agents`, {
    headers: { authorization: 'Bearer sekret' },
  });
  assert.equal(authed.status, 200);

  const wrong = await fetch(`${broker.baseUrl}/v1/agents`, {
    headers: { authorization: 'Bearer nope' },
  });
  assert.equal(wrong.status, 401);
});
