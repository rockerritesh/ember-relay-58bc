// Thin HTTP client for the broker. One place that knows the wire format.

export class BrokerError extends Error {
  constructor(status, code, message) {
    super(`${code}: ${message}`);
    this.status = status;
    this.code = code;
  }
}

export class BrokerClient {
  constructor({ baseUrl, agentId, token = null, timeoutMs = 20000 }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.agentId = agentId;
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async #request(method, pathname, { body, raw, contentType } = {}) {
    const headers = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let payload;
    if (raw !== undefined) {
      payload = raw;
      headers['content-type'] = contentType ?? 'application/octet-stream';
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }

    let res;
    try {
      res = await fetch(`${this.baseUrl}${pathname}`, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new BrokerError(0, 'broker_unreachable', `${this.baseUrl} — ${err.message}`);
    }

    const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
    if (!res.ok) {
      const detail = isJson ? await res.json().catch(() => ({})) : {};
      throw new BrokerError(res.status, detail.error ?? 'http_error', detail.message ?? res.statusText);
    }
    if (!isJson) return Buffer.from(await res.arrayBuffer());
    return res.json();
  }

  health() {
    return this.#request('GET', '/v1/health');
  }

  heartbeat() {
    return this.#request('POST', '/v1/agents/heartbeat', { body: { agent: this.agentId } });
  }

  listAgents() {
    return this.#request('GET', '/v1/agents');
  }

  sendMessage({ to, subject, body, contentType, threadId, replyTo }) {
    return this.#request('POST', '/v1/messages', {
      body: {
        from: this.agentId,
        to,
        subject,
        body,
        content_type: contentType,
        thread_id: threadId,
        reply_to: replyTo,
      },
    });
  }

  getMessage(id) {
    return this.#request('GET', `/v1/messages/${encodeURIComponent(id)}`);
  }

  ackMessage(id) {
    return this.#request('POST', `/v1/messages/${encodeURIComponent(id)}/ack`, {
      body: { agent: this.agentId },
    });
  }

  getPayload(id) {
    return this.#request('GET', `/v1/messages/${encodeURIComponent(id)}/payload`);
  }

  inbox() {
    return this.#request('GET', `/v1/inbox?agent=${encodeURIComponent(this.agentId)}`);
  }

  createOffer({ to, subject, sizeBytes, contentType, threadId, replyTo }) {
    return this.#request('POST', '/v1/offers', {
      body: {
        from: this.agentId,
        to,
        subject,
        size_bytes: sizeBytes,
        content_type: contentType,
        thread_id: threadId,
        reply_to: replyTo,
      },
    });
  }

  offers() {
    return this.#request('GET', `/v1/offers?agent=${encodeURIComponent(this.agentId)}`);
  }

  respondOffer({ offerId, accept, reason }) {
    return this.#request('POST', `/v1/offers/${encodeURIComponent(offerId)}/respond`, {
      body: { agent: this.agentId, accept, reason },
    });
  }

  uploadOffer({ offerId, buffer, contentType }) {
    return this.#request(
      'PUT',
      `/v1/offers/${encodeURIComponent(offerId)}/payload?agent=${encodeURIComponent(this.agentId)}`,
      { raw: buffer, contentType },
    );
  }

  closeOffer(offerId) {
    return this.#request('POST', `/v1/offers/${encodeURIComponent(offerId)}/close`, {
      body: { agent: this.agentId },
    });
  }

  listThreads() {
    return this.#request('GET', `/v1/threads?agent=${encodeURIComponent(this.agentId)}`);
  }

  readThread(threadId) {
    return this.#request('GET', `/v1/threads/${encodeURIComponent(threadId)}`);
  }
}
