const DB_NAME = 'household-receipt-db';
const DB_VERSION = 1;

export const STORES = {
  receipts: 'receipts',
  items: 'receipt_items',
  rules: 'classification_rules',
  settings: 'settings',
};

let dbPromise;

export function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORES.receipts)) {
        const store = db.createObjectStore(STORES.receipts, { keyPath: 'id' });
        store.createIndex('monthKey', 'monthKey', { unique: false });
        store.createIndex('purchaseDate', 'purchaseDate', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.items)) {
        const store = db.createObjectStore(STORES.items, { keyPath: 'id' });
        store.createIndex('receiptId', 'receiptId', { unique: false });
        store.createIndex('monthKey', 'monthKey', { unique: false });
        store.createIndex('category', 'category', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.rules)) {
        db.createObjectStore(STORES.rules, { keyPath: 'normalizedName' });
      }

      if (!db.objectStoreNames.contains(STORES.settings)) {
        db.createObjectStore(STORES.settings, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('データベースの更新がブロックされています。アプリを開いている他のタブを閉じてください。'));
  });

  return dbPromise;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('データベース処理に失敗しました。'));
    tx.onabort = () => reject(tx.error || new Error('データベース処理が中断されました。'));
  });
}

export function normalizeItemName(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export async function saveReceipt(receipt, items) {
  const db = await openDb();
  const tx = db.transaction([STORES.receipts, STORES.items, STORES.rules], 'readwrite');
  const receiptStore = tx.objectStore(STORES.receipts);
  const itemStore = tx.objectStore(STORES.items);
  const ruleStore = tx.objectStore(STORES.rules);

  receiptStore.put(receipt);

  for (const item of items) {
    itemStore.put(item);

    const isLearnableManualCorrection =
      item.category !== item.aiCategory &&
      item.category !== '母向け' &&
      item.category !== 'その他';

    if (isLearnableManualCorrection) {
      const normalizedName = normalizeItemName(item.itemName);
      if (normalizedName) {
        ruleStore.put({
          normalizedName,
          itemName: item.itemName,
          category: item.category,
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }

  await transactionDone(tx);
}

export async function findRule(itemName) {
  const db = await openDb();
  const tx = db.transaction(STORES.rules, 'readonly');
  const result = await requestToPromise(tx.objectStore(STORES.rules).get(normalizeItemName(itemName)));
  await transactionDone(tx);
  return result || null;
}

export async function listRules() {
  const db = await openDb();
  const tx = db.transaction(STORES.rules, 'readonly');
  const results = await requestToPromise(tx.objectStore(STORES.rules).getAll());
  await transactionDone(tx);
  return results;
}

export async function listReceiptsByMonth(monthKey) {
  const db = await openDb();
  const tx = db.transaction(STORES.receipts, 'readonly');
  const index = tx.objectStore(STORES.receipts).index('monthKey');
  const rows = await requestToPromise(index.getAll(IDBKeyRange.only(monthKey)));
  await transactionDone(tx);
  return rows.sort((a, b) => b.purchaseDate.localeCompare(a.purchaseDate) || b.createdAt.localeCompare(a.createdAt));
}

export async function listItemsByMonth(monthKey) {
  const db = await openDb();
  const tx = db.transaction(STORES.items, 'readonly');
  const index = tx.objectStore(STORES.items).index('monthKey');
  const rows = await requestToPromise(index.getAll(IDBKeyRange.only(monthKey)));
  await transactionDone(tx);
  return rows;
}

export async function deleteReceipt(receiptId) {
  const db = await openDb();
  const tx = db.transaction([STORES.receipts, STORES.items], 'readwrite');
  tx.objectStore(STORES.receipts).delete(receiptId);

  const itemStore = tx.objectStore(STORES.items);
  const index = itemStore.index('receiptId');
  const itemIds = await requestToPromise(index.getAllKeys(IDBKeyRange.only(receiptId)));
  for (const id of itemIds) itemStore.delete(id);

  await transactionDone(tx);
}

export async function deleteMonth(monthKey) {
  const db = await openDb();
  const tx = db.transaction([STORES.receipts, STORES.items], 'readwrite');

  const receiptStore = tx.objectStore(STORES.receipts);
  const receiptIds = await requestToPromise(receiptStore.index('monthKey').getAllKeys(IDBKeyRange.only(monthKey)));
  for (const id of receiptIds) receiptStore.delete(id);

  const itemStore = tx.objectStore(STORES.items);
  const itemIds = await requestToPromise(itemStore.index('monthKey').getAllKeys(IDBKeyRange.only(monthKey)));
  for (const id of itemIds) itemStore.delete(id);

  await transactionDone(tx);
}

export async function clearPurchaseData() {
  const db = await openDb();
  const tx = db.transaction([STORES.receipts, STORES.items], 'readwrite');
  tx.objectStore(STORES.receipts).clear();
  tx.objectStore(STORES.items).clear();
  await transactionDone(tx);
}

export async function clearRules() {
  const db = await openDb();
  const tx = db.transaction(STORES.rules, 'readwrite');
  tx.objectStore(STORES.rules).clear();
  await transactionDone(tx);
}
