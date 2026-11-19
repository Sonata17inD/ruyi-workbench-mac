'use strict';
const { copyOrdinaryJsonData } = require('./ordinary-json.cjs');
function createDurableJsonStore({ fs: fsModule, fsp: fspModule, path: pathModule, atomicWriteJson: atomicWriteFn }) {
  function cloneJson(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function storeError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function resolvePath(root, dottedPath) {
    let value = root;
    for (const key of String(dottedPath || '').split('.').filter(Boolean)) {
      if (!value || typeof value !== 'object') return null;
      value = value[key];
    }
    return value;
  }

  function applyCapacity(value, rules) {
    for (const rule of Array.isArray(rules) ? rules : []) {
      const target = resolvePath(value, rule && rule.path);
      const max = Math.max(0, Math.floor(Number(rule && rule.max) || 0));
      if (!target || !max) continue;
      if (Array.isArray(target) && target.length > max) Array.prototype.splice.call(target, 0, target.length - max);
      else if (typeof target === 'object') {
        const keys = Object.keys(target);
        for (const key of keys.slice(0, Math.max(0, keys.length - max))) delete target[key];
      }
    }
    return value;
  }

  function create(options = {}) {
    if (!options.file) throw new TypeError('durable JSON store requires file');
    const id = String(options.id || 'durable-json');
    const schemaKey = String(options.schemaKey || 'schema');
    const schemaVersion = Number.isFinite(options.schemaVersion) ? options.schemaVersion : null;
    const cacheEnabled = options.cache !== false;
    const quarantineEnabled = options.quarantine !== false;
    const maxBytes = options.maxBytes;
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024)) throw new TypeError('invalid durable JSON byte bound');
    if (options.ownedRegular === true && maxBytes === undefined) throw new TypeError('owned durable JSON reads require a byte bound');
    if (options.ownedRegular === true && options.mode !== undefined && options.mode !== 0o600) throw new TypeError('owned durable JSON files require mode 0600');
    let cached = null;
    let hasCache = false;
    let writeChain = Promise.resolve();

    const filePath = () => String(typeof options.file === 'function' ? options.file() : options.file);
    const copyValue = value => options.ordinaryJson === true && value !== undefined ? copyOrdinaryJsonData(value, false) : cloneJson(value);
    const fallback = () => copyValue(typeof options.defaultValue === 'function' ? options.defaultValue() : options.defaultValue);

    function prepare(raw, forWrite) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw storeError('EDURABLE_SHAPE', id + ': root must be an object');
      }
      const sourceValue = options.ordinaryJson === true ? copyOrdinaryJsonData(raw, false) : raw;
      const actualSchema = sourceValue[schemaKey];
      if (schemaVersion !== null && actualSchema !== schemaVersion && (options.strictRead === true || actualSchema !== undefined)) {
        throw storeError('EDURABLE_SCHEMA', id + ': unsupported ' + schemaKey + ' ' + String(actualSchema));
      }
      let value = options.ordinaryJson === true ? sourceValue : cloneJson(raw);
      if (typeof options.sanitize === 'function') value = options.sanitize(value);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw storeError('EDURABLE_SANITIZE', id + ': sanitizer returned a non-object');
      }
      if (options.ordinaryJson === true) value = copyOrdinaryJsonData(value, false);
      if (schemaVersion !== null) value[schemaKey] = schemaVersion;
      applyCapacity(value, options.capacity);
      if (typeof options.validate === 'function' && options.validate(value) !== true) {
        throw storeError('EDURABLE_VALIDATE', id + ': validation failed');
      }
      return options.ordinaryJson === true ? copyOrdinaryJsonData(value) : value;
    }

    function freshDefault() {
      const value = fallback();
      return prepare(value && typeof value === 'object' ? value : {}, false);
    }

    function quarantine(error) {
      const file = filePath();
      const corruptPath = quarantineEnabled ? file + '.corrupt' : ''; // '' = quarantine:false, nothing was copied
      if (quarantineEnabled) { try { fsModule.copyFileSync(file, corruptPath); } catch { /* best effort: original remains untouched */ } }
      if (typeof options.onCorrupt === 'function') {
        try { options.onCorrupt(error, { id, file, corruptPath }); } catch { /* diagnostics never block recovery */ }
      }
    }

    function parseText(text) {
      const value = JSON.parse(text);
      // Opt-in stores own this exact formatter. Equality rejects duplicate keys, alternate
      // numeric lexemes and discarded bytes without maintaining a second JSON parser.
      if (options.canonicalRead === true && JSON.stringify(options.ordinaryJson === true ? copyOrdinaryJsonData(value) : value, null, 2) !== text) {
        throw storeError('EDURABLE_CANONICAL', id + ': noncanonical JSON evidence');
      }
      return prepare(value, false);
    }

    function readFlags() {
      let flags = fsModule.constants.O_RDONLY | (fsModule.constants.O_NONBLOCK || 0);
      if (options.ownedRegular === true) {
        if (!fsModule.constants.O_NOFOLLOW || typeof process.getuid !== 'function') {
          throw storeError('EDURABLE_PLATFORM', id + ': owned descriptor reads unavailable');
        }
        flags |= fsModule.constants.O_NOFOLLOW;
      }
      return flags;
    }
    function checkReadStat(stat) {
      if (!stat.isFile() || stat.size > BigInt(maxBytes)) throw storeError('EDURABLE_CAPACITY', id + ': invalid or oversized JSON file');
      if (options.ownedRegular === true && (stat.uid !== BigInt(process.getuid()) || stat.nlink !== 1n || (stat.mode & 0o077n))) {
        throw storeError('EDURABLE_OWNER', id + ': JSON file is not private and owned');
      }
    }
    function unchangedRead(before, after) {
      if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) {
        throw storeError('EDURABLE_CHANGED', id + ': JSON file changed during read');
      }
    }
    function boundedText(buffer, used) {
      if (used > maxBytes) throw storeError('EDURABLE_CAPACITY', id + ': JSON read exceeds byte bound');
      const data = buffer.subarray(0, used), text = data.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(data)) throw storeError('EDURABLE_ENCODING', id + ': invalid UTF-8 JSON');
      return text;
    }
    function readTextSync() {
      if (maxBytes === undefined) return fsModule.readFileSync(filePath(), 'utf8');
      const fd = fsModule.openSync(filePath(), readFlags());
      try {
        const before = fsModule.fstatSync(fd, { bigint: true }); checkReadStat(before);
        const buffer = Buffer.alloc(maxBytes + 1); let used = 0;
        while (used < buffer.length) {
          const count = fsModule.readSync(fd, buffer, used, buffer.length - used, null);
          if (!count) break;
          used += count;
        }
        if (BigInt(used) !== before.size) throw storeError('EDURABLE_CHANGED', id + ': incomplete JSON read');
        unchangedRead(before, fsModule.fstatSync(fd, { bigint: true }));
        return boundedText(buffer, used);
      } finally { fsModule.closeSync(fd); }
    }
    async function readText() {
      if (maxBytes === undefined) return fspModule.readFile(filePath(), 'utf8');
      const file = await fspModule.open(filePath(), readFlags());
      try {
        const before = await file.stat({ bigint: true }); checkReadStat(before);
        const buffer = Buffer.alloc(maxBytes + 1); let used = 0;
        while (used < buffer.length) {
          const { bytesRead } = await file.read(buffer, used, buffer.length - used, null);
          if (!bytesRead) break;
          used += bytesRead;
        }
        if (BigInt(used) !== before.size) throw storeError('EDURABLE_CHANGED', id + ': incomplete JSON read');
        unchangedRead(before, await file.stat({ bigint: true }));
        return boundedText(buffer, used);
      } finally { await file.close(); }
    }

    function readSync() {
      if (cacheEnabled && hasCache) return cached;
      let value;
      try {
        value = parseText(readTextSync());
      } catch (error) {
        if (options.strictRead === true && error?.code !== 'ENOENT') throw error;
        if (!readErrorIsSettled(error)) return freshDefault();   // hunt2-P8:瞬时读失败不隔离、不进缓存
        value = recover(error);
      }
      if (cacheEnabled) { cached = value; hasCache = true; }
      return value;
    }

    // hunt2-P8:什么样的读失败算「已定论」—— 文件不存在(ENOENT)、内容坏(JSON 语法错)、形状/版本/清洗/校验
    // 不过(EDURABLE_*)。只有这些才隔离 + 用默认值 + 进缓存。EBUSY/EACCES/EMFILE 这类是【这一次】没读到,
    // 不是文件坏了:修前也当损坏处理,拷一份 .corrupt、把默认值钉进进程缓存 —— 此后本进程每次读都拿默认值,
    // 下一次写再把默认值落盘,好好的文件就这么被一次瞬时锁冲掉了。现在只给本次调用一份默认值,下次照常读盘。
    function readErrorIsSettled(error) {
      const code = String((error && error.code) || '');
      return code === 'ENOENT' || code.startsWith('EDURABLE_') || error instanceof SyntaxError;
    }

    function recover(error) {
      if (!(error && error.code === 'ENOENT')) quarantine(error);
      return freshDefault();
    }

    async function read() {
      if (cacheEnabled && hasCache) return cached;
      let value;
      try {
        value = parseText(await readText());
      } catch (error) {
        if (options.strictRead === true && error?.code !== 'ENOENT') throw error;
        if (!readErrorIsSettled(error)) return freshDefault();   // hunt2-P8:同 readSync
        value = recover(error);
      }
      if (cacheEnabled) {
        // A write that was enqueued while this read awaited the disk already advanced the cache: keep the newer value.
        if (hasCache) return cached;
        cached = value; hasCache = true;
      }
      return value;
    }

    function write(value) {
      let snapshot, serialized;
      try {
        snapshot = prepare(value, true);
        if (maxBytes !== undefined) serialized = JSON.stringify(snapshot, null, 2);
        if (maxBytes !== undefined && Buffer.byteLength(serialized, 'utf8') > maxBytes) {
          throw storeError('EDURABLE_CAPACITY', id + ': JSON write exceeds byte bound');
        }
      }
      catch (error) { return Promise.reject(error); }
      // Advance the write-through cache at enqueue time. Updating it on I/O completion lets an older queued
      // write temporarily replace newer in-memory state while the next atomic write is still awaiting disk.
      if (cacheEnabled) { cached = snapshot; hasCache = true; }
      const pending = writeChain.catch(() => {}).then(async () => {
        const file = filePath();
        await fspModule.mkdir(pathModule.dirname(file), { recursive: true });
        const payload = maxBytes === undefined ? snapshot : serialized;
        if (options.ownedRegular === true) await atomicWriteFn(file, payload, { mode: 0o600, exclusiveTemp: true });
        else if (Number.isInteger(options.mode)) await atomicWriteFn(file, payload, { mode: options.mode });
        else await atomicWriteFn(file, payload);
        return snapshot;
      });
      writeChain = pending;
      return pending;
    }

    function invalidate() {
      cached = null;
      hasCache = false;
    }

    return { id, readSync, read, write, invalidate, filePath };
  }

  return { create, applyCapacity };
}
module.exports = { createDurableJsonStore };
