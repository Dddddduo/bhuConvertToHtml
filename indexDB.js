const DB_NAME = 'DocumentConverterDB';
const STORE_NAME = 'jsonStore';
const RECORD_ID = 'convertedJson';
// 初始化 IndexedDB
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        };

        request.onsuccess = (event) => {
            resolve(event.target.result);
        };

        request.onerror = (event) => {
            reject(new Error('Failed to open database.'));
        };
    });
}

// 按 id 读取一条记录（convertedJson = 做题记录，attemptStats = 错题统计）
async function getStoreData(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(id);

        request.onsuccess = () => {
            resolve(request.result ? request.result.data : null);
        };
        request.onerror = () => reject(new Error('Failed to get data.'));
    });
}

// 按 id 保存一条记录
async function saveStoreData(id, data) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put({ id, data });

        request.onsuccess = () => resolve();
        request.onerror = () => reject(new Error('Failed to save data.'));
    });
}

// 获取做题记录
async function getJsonData() {
    return getStoreData(RECORD_ID);
}

// 保存做题记录
async function saveJsonData(data) {
    return saveStoreData(RECORD_ID, data);
}

// 删除做题记录
async function deleteJsonData() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.delete(RECORD_ID);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(new Error('Failed to delete data.'));
    });
}
