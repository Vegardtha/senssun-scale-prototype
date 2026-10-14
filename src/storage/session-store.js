// Local-only session persistence (IndexedDB in this browser profile). Nothing leaves the machine.

const DB_NAME = 'senssun-scale-prototype';
const STORE = 'sessions';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const sessionStore = {
  save: (session) => run('readwrite', (s) => s.put(session)),
  get: (id) => run('readonly', (s) => s.get(id)),
  remove: (id) => run('readwrite', (s) => s.delete(id)),
  async list() {
    const all = (await run('readonly', (s) => s.getAll())) ?? [];
    return all
      .map(({ id, name, createdAt, updatedAt, device, events }) => ({
        id, name, createdAt, updatedAt, deviceName: device?.name ?? null, eventCount: events.length,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },
};
