/* Browser-local release history. IndexedDB is the only persistence boundary.
 * Lists read metadata only; payloads are decoded only for the selected item.
 * bytes measures serialized UTF-8 records, not browser implementation overhead.
 */
'use strict';

const KTReleaseHistory = (() => {
  const TTL = 30 * 24 * 60 * 60 * 1000;
  const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
  const MAX_NODES = 200000, MAX_DEPTH = 64, MAX_RAW_CHARS = 64 * 1024 * 1024;
  const utf8 = value => new TextEncoder().encode(value).byteLength;
  const failure = (code, message) => Object.assign(new Error(message), { code });
  const invalid = () => failure('HISTORY_INVALID', '保存する履歴の形式を確認できません。');
  const conflict = () => failure('HISTORY_CONFLICT', '別の画面で履歴が更新されています。最新の履歴を開き直してください。');
  const storageFailure = error => error?.code?.startsWith?.('HISTORY_') ? error : failure(error?.name === 'QuotaExceededError' ? 'HISTORY_LIMIT' : 'HISTORY_SAVE_FAILED', error?.name === 'QuotaExceededError' ? 'ブラウザの保存容量が不足しています。前回の保存内容は残っています。' : '履歴を保存できませんでした。前回の保存内容は残っています。');
  const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 200;
  const validRevision = revision => Number.isSafeInteger(revision) && revision > 0;
  const expired = (entry, time) => !entry.pinned && entry.completedAt !== null && Number.isFinite(entry.expiresAt) && entry.expiresAt <= time;
  const metadata = entry => entry ? Object.fromEntries(['id', 'revision', 'title', 'updatedAt', 'completedAt', 'pinned', 'expiresAt', 'bytes'].map(key => [key, entry[key]])) : null;

  // Callers supply an allowlisted session snapshot without transport credentials.
  // Field codes are opaque: a property name alone does not identify a secret.
  // Tagged containers cannot collide with user JSON. Only repeated long strings
  // enter the dictionary; code is opaque data and is never evaluated or inferred.
  function encode(payload) {
    let nodes = 0, chars = 0;
    const ancestors = new Set(), counts = new Map();
    function visit(value, depth) {
      if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw invalid();
      if (typeof value === 'string') {
        chars += value.length;
        if (chars > MAX_RAW_CHARS) throw invalid();
        if (value.length >= 256) counts.set(value, (counts.get(value) || 0) + 1);
        return;
      }
      if (value === null || typeof value === 'boolean') return;
      if (typeof value === 'number') { if (!Number.isFinite(value)) throw invalid(); return; }
      if (!value || typeof value !== 'object' || ancestors.has(value)) throw invalid();
      const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
      if (!array && proto !== Object.prototype && proto !== null) throw invalid();
      ancestors.add(value);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(value).some(key => typeof key === 'symbol')) throw invalid();
      if (array) {
        if (value.length > MAX_NODES || Object.keys(value).length !== value.length) throw invalid();
        for (let i = 0; i < value.length; i++) {
          const descriptor = descriptors[i];
          if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw invalid();
          visit(descriptor.value, depth + 1);
        }
      } else {
        for (const [key, descriptor] of Object.entries(descriptors)) {
          if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid();
          chars += key.length;
          if (chars > MAX_RAW_CHARS) throw invalid();
          visit(descriptor.value, depth + 1);
        }
      }
      ancestors.delete(value);
    }
    visit(payload, 0);
    const strings = [...counts].filter(([, count]) => count > 1).map(([value]) => value), refs = new Map(strings.map((value, index) => [value, index]));
    function pack(value) {
      if (typeof value === 'string') return refs.has(value) ? [0, refs.get(value)] : value;
      if (Array.isArray(value)) return [1, ...value.map(pack)];
      if (value && typeof value === 'object') { const out = [2]; for (const key of Object.keys(value)) out.push(key, pack(value[key])); return out; }
      return value;
    }
    return { format: 1, strings, tree: pack(payload) };
  }
  function decode(encoded) {
    if (encoded?.format !== 1 || !Array.isArray(encoded.strings)) throw invalid();
    let nodes = 0;
    function unpack(value, depth) {
      if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw invalid();
      if (!Array.isArray(value)) {
        if (value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value)) return value;
        throw invalid();
      }
      if (value[0] === 0 && value.length === 2 && Number.isSafeInteger(value[1]) && typeof encoded.strings[value[1]] === 'string') return encoded.strings[value[1]];
      if (value[0] === 1) return value.slice(1).map(child => unpack(child, depth + 1));
      if (value[0] === 2 && value.length % 2 === 1) {
        const out = {};
        for (let i = 1; i < value.length; i += 2) {
          if (typeof value[i] !== 'string') throw invalid();
          Object.defineProperty(out, value[i], { value: unpack(value[i + 1], depth + 1), enumerable: true, configurable: true, writable: true });
        }
        return out;
      }
      throw invalid();
    }
    return unpack(encoded.tree, 0);
  }
  function create({ indexedDB = globalThis.indexedDB, scope, now = Date.now, maxBytes = DEFAULT_MAX_BYTES, dbName = 'kt-release-history-v1' } = {}) {
    if (!scope || ['domain', 'appId', 'userId', 'environment'].some(key => typeof scope[key] !== 'string' || !scope[key] || scope[key].length > 512) || typeof now !== 'function' || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || typeof dbName !== 'string' || !dbName) throw invalid();
    const scopeKey = JSON.stringify([scope.domain, scope.appId, scope.userId, scope.environment]);
    const ownerKey = JSON.stringify([scope.domain, scope.userId]);
    let connection = null, opening = null, closed = false;
    const time = () => { const value = now(); if (!Number.isSafeInteger(value) || value < 0) throw invalid(); return value; };
    function open() {
      if (closed || !indexedDB?.open) return Promise.reject(failure('HISTORY_UNAVAILABLE', 'このブラウザでは履歴を保存できません。'));
      if (connection) return Promise.resolve(connection);
      if (opening) return opening;
      opening = new Promise((resolve, reject) => {
        let request;
        try { request = indexedDB.open(dbName, 1); } catch (error) { reject(storageFailure(error)); return; }
        request.onupgradeneeded = () => {
          const db = request.result;
          const entries = db.createObjectStore('entries', { keyPath: 'key' });
          entries.createIndex('scope', 'scope'); entries.createIndex('owner', 'owner');
          db.createObjectStore('payloads', { keyPath: 'key' });
          db.createObjectStore('owners', { keyPath: 'owner' });
        };
        request.onerror = () => reject(storageFailure(request.error));
        request.onblocked = () => reject(failure('HISTORY_UNAVAILABLE', '履歴を開けません。他の Toolkit 画面を閉じてから開き直してください。'));
        request.onsuccess = () => {
          const db = request.result;
          if (closed) { db.close(); reject(failure('HISTORY_UNAVAILABLE', '履歴の保存は終了しています。')); return; }
          connection = db;
          db.onversionchange = () => { db.close(); connection = null; opening = null; };
          resolve(db);
        };
      }).catch(error => { opening = null; throw error; });
      return opening;
    }
    async function transaction(mode, stores, operation) {
      const db = await open();
      return new Promise((resolve, reject) => {
        let tx, result, problem;
        try { tx = db.transaction(stores, mode); } catch (error) { reject(storageFailure(error)); return; }
        const abort = error => { problem = storageFailure(error); try { tx.abort(); } catch { reject(problem); } };
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(problem || storageFailure(tx.error));
        tx.onerror = () => { if (!problem) problem = storageFailure(tx.error); };
        const request = (req, done) => {
          req.onerror = () => { problem = storageFailure(req.error); };
          req.onsuccess = () => { try { done(req.result); } catch (error) { abort(error); } };
        };
        try { operation({ tx, request, done: value => { result = value; }, abort }); } catch (error) { abort(error); }
      });
    }
    const purge = (tx, entries, at) => {
      const keep = [];
      for (const entry of entries) {
        if (expired(entry, at)) { tx.objectStore('entries').delete(entry.key); tx.objectStore('payloads').delete(entry.key); }
        else keep.push(entry);
      }
      return keep;
    };
    function list() {
      const at = time();
      return transaction('readwrite', ['entries', 'payloads'], ({ tx, request, done }) => {
        request(tx.objectStore('entries').index('scope').getAll(scopeKey), entries => done(purge(tx, entries, at).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).map(metadata)));
      });
    }
    function load(id) {
      if (!validId(id)) return Promise.reject(invalid());
      const at = time(), key = [scopeKey, id];
      return transaction('readonly', ['entries', 'payloads'], ({ tx, request, done }) => {
        request(tx.objectStore('entries').get(key), entry => {
          if (!entry || expired(entry, at)) { done(null); return; }
          request(tx.objectStore('payloads').get(key), payload => { if (!payload) throw invalid(); done({ ...metadata(entry), payload: decode(payload.body) }); });
        });
      });
    }
    async function save(input) {
      const at = time();
      if (!input || !validId(input.id) || !(input.revision === null || validRevision(input.revision)) || typeof input.title !== 'string' || input.title.length > 500 || typeof input.pinned !== 'boolean' || !(input.completedAt === null || Number.isSafeInteger(input.completedAt) && input.completedAt >= 0 && input.completedAt <= at)) throw invalid();
      // Snapshot the caller's values before opening the asynchronous transaction.
      const { id, revision, title, completedAt, pinned } = input;
      const body = encode(input.payload), key = [scopeKey, id];
      return transaction('readwrite', ['entries', 'payloads', 'owners'], ({ tx, request, done }) => {
        // One owner budget across all apps/environments. Index lookups never read
        // another user's records. Capacity cleanup only removes expired records.
        request(tx.objectStore('entries').index('owner').getAll(ownerKey), rows => {
          const entries = purge(tx, rows, at), previous = entries.find(row => row.scope === scopeKey && row.id === id);
          if (previous ? previous.revision !== revision : revision !== null) throw conflict();
          request(tx.objectStore('owners').get(ownerKey), owner => {
            let expiresAt = null;
            if (!pinned && completedAt !== null) {
              expiresAt = previous?.pinned ? at + TTL : previous?.completedAt === completedAt && previous.expiresAt !== null ? previous.expiresAt : completedAt + TTL;
            }
            const entry = { key, scope: scopeKey, owner: ownerKey, id, revision: Math.max(owner?.revision || 0, previous?.revision || 0) + 1, title, updatedAt: at, completedAt, pinned, expiresAt, bytes: 0 };
            if (!Number.isSafeInteger(entry.revision)) throw invalid();
            const payload = { key, body };
            const payloadBytes = utf8(JSON.stringify(payload));
            let measured;
            do { measured = entry.bytes; entry.bytes = payloadBytes + utf8(JSON.stringify(entry)); } while (entry.bytes !== measured);
            const used = entries.reduce((sum, row) => sum + (row === previous ? 0 : row.bytes), 0);
            if (used + entry.bytes > maxBytes) throw failure('HISTORY_LIMIT', '履歴の保存上限に達しました。不要な履歴を削除してください。前回の保存内容は残っています。');
            // Monotonic owner revisions also prevent a stale writer after deletion
            // and recreation of the same id (without retaining deleted payloads).
            tx.objectStore('owners').put({ owner: ownerKey, revision: entry.revision });
            tx.objectStore('entries').put(entry); tx.objectStore('payloads').put(payload);
            done(metadata(entry));
          });
        });
      });
    }
    function remove(id, revision) {
      if (!validId(id) || !validRevision(revision)) return Promise.reject(invalid());
      const key = [scopeKey, id];
      return transaction('readwrite', ['entries', 'payloads'], ({ tx, request, done }) => {
        request(tx.objectStore('entries').get(key), entry => {
          if (!entry) { done(false); return; }
          if (entry.revision !== revision) throw conflict();
          tx.objectStore('entries').delete(key); tx.objectStore('payloads').delete(key); done(true);
        });
      });
    }
    function prune() {
      const at = time();
      return transaction('readwrite', ['entries', 'payloads'], ({ tx, request, done }) => {
        request(tx.objectStore('entries').index('scope').getAll(scopeKey), entries => done({ removed: entries.length - purge(tx, entries, at).length }));
      });
    }
    function usage() {
      return transaction('readonly', ['entries'], ({ tx, request, done }) => {
        request(tx.objectStore('entries').index('owner').getAll(ownerKey), entries => {
          const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
          done({ bytes, maxBytes, availableBytes: Math.max(0, maxBytes - bytes), count: entries.length });
        });
      });
    }
    function close() { closed = true; connection?.close(); connection = null; }
    return { list, load, save, remove, prune, usage, close };
  }
  return { create, TTL, DEFAULT_MAX_BYTES };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { KTReleaseHistory };
