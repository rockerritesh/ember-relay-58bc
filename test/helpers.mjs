import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { createServer } from '../server/broker.mjs';

export function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agent-tunnel-${label}-`));
}

// Boots a real broker on an ephemeral port over a throwaway data folder.
export async function startBroker() {
  const dataDir = tempDir('data');
  const store = new Store(dataDir);
  const server = createServer(store);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    store,
    dataDir,
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function api(baseUrl, method, pathname, body) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  return { status: res.status, body: isJson ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}
