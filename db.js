// receipts — IndexedDB wrapper.
// Two stores: `batches` (manifest + status cache + results) and `files` (original
// photo blobs, kept around so we can warp them once batch results arrive).
//
// All blobs stay strictly client-side; nothing in here touches the network.

const DB_NAME = 'receipts';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('batches')) {
        db.createObjectStore('batches', { keyPath: 'batch_id' });
      }
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files', { keyPath: 'file_id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function promisify(req) {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function withStore(name, mode, fn) {
  const db = await openDb();
  const tx = db.transaction(name, mode);
  const store = tx.objectStore(name);
  const result = await fn(store);
  await new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  return result;
}

// ---------- files ----------
export async function putFile(file_id, blob, name, type) {
  return withStore('files', 'readwrite', s =>
    promisify(s.put({ file_id, blob, name, type }))
  );
}
export async function getFile(file_id) {
  return withStore('files', 'readonly', s => promisify(s.get(file_id)));
}
export async function deleteFile(file_id) {
  return withStore('files', 'readwrite', s => promisify(s.delete(file_id)));
}

// ---------- batches ----------
export async function putBatch(record) {
  return withStore('batches', 'readwrite', s => promisify(s.put(record)));
}
export async function getBatchRecord(batch_id) {
  return withStore('batches', 'readonly', s => promisify(s.get(batch_id)));
}
export async function listBatches() {
  return withStore('batches', 'readonly', s => promisify(s.getAll()));
}

// Delete a batch and its associated source files in one transaction.
export async function deleteBatchAndFiles(batch_id) {
  const db = await openDb();
  const tx = db.transaction(['batches', 'files'], 'readwrite');
  const batchStore = tx.objectStore('batches');
  const fileStore = tx.objectStore('files');
  const record = await promisify(batchStore.get(batch_id));
  if (record?.items) {
    for (const item of record.items) {
      if (item.file_id) fileStore.delete(item.file_id);
    }
  }
  batchStore.delete(batch_id);
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

// Estimated total size of stored files for a batch (informational).
export async function batchStorageSize(batch_id) {
  const rec = await getBatchRecord(batch_id);
  if (!rec?.items) return 0;
  let total = 0;
  for (const item of rec.items) {
    const f = await getFile(item.file_id);
    if (f?.blob) total += f.blob.size;
  }
  return total;
}
