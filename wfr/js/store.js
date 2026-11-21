// Offline storage: IndexedDB, every patient record encrypted with AES-GCM-256.
//
// Key handling:
//  - A random data key encrypts all records.
//  - The data key is stored only in wrapped (AES-KW) form.
//  - No PIN: wrapped by a non-extractable device key that lives in IndexedDB
//    (protects against casual file-level reads / backups, not a rooted device).
//  - PIN set: wrapped by a key derived from the PIN with PBKDF2; the data key
//    exists only in memory while unlocked. A wrong PIN fails the AES-KW
//    integrity check, so the PIN is verified cryptographically.

const DB_NAME = 'wfr-field-log';
const DB_VERSION = 1;
const PBKDF2_ITER = 310000;

let dbp = null;
let dataKey = null;

function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('patients')) db.createObjectStore('patients', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    // durability: 'strict' asks the browser to flush to disk before reporting
    // completion, so a battery death right after "Saved" does not lose data.
    const t = db.transaction(store, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('aborted'));
  }));
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const metaGet = (k) => tx('meta', 'readonly', (s) => reqP(s.get(k)));
export const metaSet = (k, v) => tx('meta', 'readwrite', (s) => { s.put(v, k); });

// ---- keys ----
async function deriveKEK(pin, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' },
    base, { name: 'AES-KW', length: 256 }, false, ['wrapKey', 'unwrapKey']);
}
const unwrapData = (wrapped, kek) => crypto.subtle.unwrapKey('raw', wrapped, kek, 'AES-KW',
  { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);

async function getKeyring() {
  let kr = await metaGet('keyring');
  if (!kr) {
    const deviceKey = await crypto.subtle.generateKey({ name: 'AES-KW', length: 256 }, false, ['wrapKey', 'unwrapKey']);
    const dk = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    kr = { mode: 'device', deviceKey, wrapped: await crypto.subtle.wrapKey('raw', dk, deviceKey, 'AES-KW') };
    await metaSet('keyring', kr);
  }
  return kr;
}

export async function needsPin() {
  const kr = await getKeyring();
  return kr.mode === 'pin';
}

// Returns true if unlocked.
export async function unlock(pin) {
  const kr = await getKeyring();
  try {
    if (kr.mode === 'pin') {
      if (!pin) return false;
      dataKey = await unwrapData(kr.wrapped, await deriveKEK(pin, kr.salt));
    } else {
      dataKey = await unwrapData(kr.wrapped, kr.deviceKey);
    }
    return true;
  } catch {
    dataKey = null;
    return false;
  }
}

export function lock() { dataKey = null; }
export const isUnlocked = () => !!dataKey;

export async function setPin(pin) {
  if (!dataKey) throw new Error('locked');
  const kr = await getKeyring();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const wrapped = await crypto.subtle.wrapKey('raw', dataKey, await deriveKEK(pin, salt), 'AES-KW');
  await metaSet('keyring', { ...kr, mode: 'pin', salt, wrapped });
}

export async function removePin() {
  if (!dataKey) throw new Error('locked');
  const kr = await getKeyring();
  const wrapped = await crypto.subtle.wrapKey('raw', dataKey, kr.deviceKey, 'AES-KW');
  await metaSet('keyring', { mode: 'device', deviceKey: kr.deviceKey, wrapped });
}

// ---- records ----
async function encrypt(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dataKey, new TextEncoder().encode(JSON.stringify(obj)));
  return { iv, data };
}
async function decrypt(rec) {
  const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, dataKey, rec.data);
  return JSON.parse(new TextDecoder().decode(buf));
}

export async function putPatient(p) {
  if (!dataKey) throw new Error('locked');
  const enc = await encrypt(p); // encrypt before opening the transaction (it must not idle)
  await tx('patients', 'readwrite', (s) => { s.put({ id: p.id, updated: p.updated, ...enc }); });
}

export async function getAllPatients() {
  if (!dataKey) throw new Error('locked');
  const recs = await tx('patients', 'readonly', (s) => reqP(s.getAll()));
  const out = [];
  for (const r of recs) {
    try { out.push(await decrypt(r)); } catch (e) { console.error('decrypt failed', r.id, e); }
  }
  return out;
}

export const deletePatient = (id) => tx('patients', 'readwrite', (s) => { s.delete(id); });
export const deleteAllPatients = () => tx('patients', 'readwrite', (s) => { s.clear(); });

// Serialised, coalescing saver: at most one write in flight per patient,
// and the newest state always wins. onState('saving'|'saved'|'error').
const pending = new Map();
export function createSaver(onState) {
  return function save(p) {
    let st = pending.get(p.id);
    if (!st) { st = { busy: false, next: null }; pending.set(p.id, st); }
    st.next = p;
    onState && onState('saving');
    if (st.busy) return st.promise;
    st.busy = true;
    st.promise = (async () => {
      try {
        while (st.next) {
          const cur = st.next;
          st.next = null;
          await putPatient(structuredClone(cur));
        }
        onState && onState('saved');
      } catch (e) {
        console.error(e);
        onState && onState('error', e);
      } finally {
        st.busy = false;
      }
    })();
    return st.promise;
  };
}

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch { /* ignore */ }
  return false;
}

export async function storageInfo() {
  const info = { persisted: false, usage: null, quota: null };
  try {
    if (navigator.storage) {
      info.persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      if (navigator.storage.estimate) Object.assign(info, await navigator.storage.estimate());
    }
  } catch { /* ignore */ }
  return info;
}
