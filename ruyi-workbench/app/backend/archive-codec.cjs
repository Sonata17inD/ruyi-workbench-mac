'use strict';
const zlib = require('node:zlib');
const { profileGb18030Decoder } = require('./text-codecs.cjs');

const CRC32_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0 ^ (-1);
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC32_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ (-1)) >>> 0; // >>>0 → 无符号 32 位
}

// ZIP 大小 / 数量护栏（zip 炸弹与体积防御）。
const ZIP_MAX_SINGLE_FILE = 100 * 1024 * 1024;   // 单文件 100MB（打包时）
const ZIP_MAX_TOTAL = 500 * 1024 * 1024;         // 总量 500MB（打包 + 解压累计）
// F9:条目数上限与写入端对齐 —— 经典 zip 的条目数字段是 UInt16(本实现不写 zip64),所以两端都是 65535。
// 修前打包无上限、解包 2000 封顶:archive_zip 打出 2506 个条目的包,archive_unzip 却把它当 zip 炸弹拒收(拒绝自己的产物)。
// 炸弹防御本来就该看体积:解压前先核对中央目录声明的总大小(≤ZIP_MAX_TOTAL),解压时逐条核对实际大小与 CRC。
// 65534 而非 65535:EOCD 的条目数字段 0xFFFF 是 zip64 哨兵,写满 65535 条的包我们自己的 archive_unzip 会当 zip64 拒掉。
const ZIP_MAX_ENTRIES = 65534;

// 让出事件循环一拍(大数据的 CRC / 压缩 / 解压循环之间调用,SSE 与其它会话不被卡住)。
const zipYield = () => new Promise(resolve => setImmediate(resolve));
// 增量 CRC:分片计算,片间让出。Node ≥ 20.15/22.2 有原生 zlib.crc32(C 实现,数百 MB/s 级且不必分片),没有就走 JS 表驱动。
async function crc32Async(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = 0 ^ (-1);
  const STEP = 4 * 1024 * 1024;
  for (let off = 0; off < buf.length; off += STEP) {
    const end = Math.min(buf.length, off + STEP);
    for (let i = off; i < end; i += 1) c = (c >>> 8) ^ CRC32_TABLE[(c ^ buf[i]) & 0xff];
    if (end < buf.length) await zipYield();
  }
  return (c ^ (-1)) >>> 0;
}
const zipDeflateRawAsync = data => new Promise((resolve, reject) => zlib.deflateRaw(data, (err, out) => (err ? reject(err) : resolve(out))));
const zipInflateRawAsync = (data, maxOutputLength) => new Promise((resolve, reject) => zlib.inflateRaw(data, { maxOutputLength }, (err, out) => (err ? reject(err) : resolve(out))));
// 小数据同步压缩更快(线程池往返的开销比压缩本身还大);大数据才走异步。
const ZIP_ASYNC_DEFLATE_MIN = 256 * 1024;

// 顶层输入在包内的名字:默认取 basename;basename 相同(['d1/n.txt','d2/n.txt'] 都叫 n.txt)的几项,
// 逐步补上父目录段(d1/n.txt、d2/n.txt)直到互不相同 —— 解压后各自在各自的子目录里,不会互相覆盖。Windows 盘符的冒号去掉。
function zipTopLevelNames(absPaths) {
  const fold = x => String(x).toLowerCase();   // zip 在 Windows 上解压不分大小写,这里一律按小写判重
  const segs = absPaths.map(a => String(a).split(/[\\/]+/).filter(Boolean).map(x => x.replace(/:/g, '')));
  const names = segs.map(sg => sg[sg.length - 1] || 'root');
  const groups = new Map();
  names.forEach((n, i) => { const k = fold(n); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); });
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    const maxK = Math.max(...idxs.map(i => segs[i].length));
    for (let k = 2; k <= maxK; k += 1) {
      const cand = idxs.map(i => segs[i].slice(-k).join('/'));
      idxs.forEach((i, j) => { names[i] = cand[j]; });
      if (new Set(cand.map(fold)).size === cand.length) break;
    }
  }
  return names;
}

// 把 {name,data,isDir} 条目数组写成一个 ZIP Buffer。deflate 压缩（空数据 stored）。手写 local header +
// central directory + EOCD。返回完整 Buffer。文件名用 UTF-8 字节 + flag bit 11。
// prepared[i] = { crc, method, comp }:压缩与 CRC 由调用方算好(zipWrite 同步算、zipWriteAsync 异步算),这里只装配。
function zipAssemble(entries, prepared) {
  if (entries.length > ZIP_MAX_ENTRIES) throw new Error(`条目数超过 zip 格式上限（${ZIP_MAX_ENTRIES}）`);
  const localParts = []; // 各条目的 [localHeader, filename, compressedData]
  const central = [];    // central directory 记录
  let offset = 0;        // 当前 local header 的绝对偏移（EOCD/central 用）
  for (let idx = 0; idx < entries.length; idx += 1) {
    const e = entries[idx];
    const { crc, method, comp } = prepared[idx];
    const nameBuf = Buffer.from(e.name, 'utf8');
    // ---- local file header (0x04034b50) ----
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);            // version needed
    lh.writeUInt16LE(0x0800, 6);        // general purpose flag: bit 11 = UTF-8 文件名
    lh.writeUInt16LE(method, 8);        // compression method
    lh.writeUInt16LE(0, 10);            // mod time（不记录 → 0）
    lh.writeUInt16LE(0x21, 12);         // mod date（0 非法, 用一个合法占位 1980-01-01）
    lh.writeUInt32LE(crc, 14);          // crc32
    lh.writeUInt32LE(comp.length, 18);  // compressed size
    lh.writeUInt32LE(e.data.length, 22);// uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);            // extra field length
    localParts.push(lh, nameBuf, comp);
    // ---- central directory header (0x02014b50) ----
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);            // version made by
    cd.writeUInt16LE(20, 6);            // version needed
    cd.writeUInt16LE(0x0800, 8);        // flag bit 11 UTF-8
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);            // mod time
    cd.writeUInt16LE(0x21, 14);         // mod date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);            // extra len
    cd.writeUInt16LE(0, 32);            // comment len
    cd.writeUInt16LE(0, 34);            // disk number
    cd.writeUInt16LE(0, 36);            // internal attrs
    cd.writeUInt32LE(e.isDir ? 0x10 : 0, 38); // external attrs: 目录置 FILE_ATTRIBUTE_DIRECTORY
    cd.writeUInt32LE(offset, 42);       // 相对 local header 偏移
    central.push(Buffer.concat([cd, nameBuf]));
    offset += lh.length + nameBuf.length + comp.length;
  }
  const localBlob = Buffer.concat(localParts);
  const centralBlob = Buffer.concat(central);
  // ---- EOCD (0x06054b50) ----
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);            // disk
  eocd.writeUInt16LE(0, 6);            // cd start disk
  eocd.writeUInt16LE(entries.length, 8);  // entries this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralBlob.length, 12); // central dir size
  eocd.writeUInt32LE(localBlob.length, 16);   // central dir offset (= 所有 local 之后)
  eocd.writeUInt16LE(0, 20);          // comment len
  return Buffer.concat([localBlob, centralBlob, eocd]);
}
function zipWrite(entries) {
  return zipAssemble(entries, entries.map(e => {
    const crc = crc32(e.data);
    if (e.data.length === 0) return { crc, method: 0, comp: Buffer.alloc(0) };   // 空文件/目录 → stored, size 0
    return { crc, method: 8, comp: zlib.deflateRawSync(e.data) };                // deflate（内建 zlib）
  }));
}
// F9:archive_zip 走这条 —— 大文件的 deflate 与 CRC 不再在主线程同步跑(实测 5×40MB 随机文件同步压缩让事件循环停顿 6.8 s,
// SSE/其它会话/API 全卡住);压缩交给 libuv 线程池,条目之间让出事件循环。产物与 zipWrite 字节一致。
async function zipWriteAsync(entries) {
  const prepared = [];
  let sinceYield = 0;
  for (const e of entries) {
    const n = e.data.length;
    if (n === 0) { prepared.push({ crc: 0, method: 0, comp: Buffer.alloc(0) }); continue; }
    if (n < ZIP_ASYNC_DEFLATE_MIN) {
      prepared.push({ crc: crc32(e.data), method: 8, comp: zlib.deflateRawSync(e.data) });
      sinceYield += n;
      if (sinceYield >= 4 * 1024 * 1024) { sinceYield = 0; await zipYield(); }
      continue;
    }
    const crc = await crc32Async(e.data);
    prepared.push({ crc, method: 8, comp: await zipDeflateRawAsync(e.data) });
    sinceYield = 0;
  }
  return zipAssemble(entries, prepared);
}

// F9:条目名解码。flag bit 11 = UTF-8;没置位时(Windows 资源管理器在中文系统上、旧版 WinRAR/7-Zip 打的包)名字是本地代码页
// (中文 Windows = GBK)—— 纯 ASCII 照旧,严格 UTF-8 能解就按 UTF-8,否则按 GB18030(运行时支持时)。
// 返回 { name, encoding }。
function zipDecodeName(nameBuf, utf8Flag) {
  let ascii = true;
  for (let i = 0; i < nameBuf.length; i += 1) if (nameBuf[i] > 0x7f) { ascii = false; break; }
  if (ascii || utf8Flag) return { name: nameBuf.toString('utf8'), encoding: 'utf-8' };
  try { return { name: new TextDecoder('utf-8', { fatal: true }).decode(nameBuf), encoding: 'utf-8' }; } catch { /* 不是 UTF-8 */ }
  const gb = profileGb18030Decoder();
  if (gb) { try { return { name: gb.decode(nameBuf), encoding: 'gb18030' }; } catch { /* 也不是 */ } }
  return { name: nameBuf.toString('utf8'), encoding: 'utf-8', lossy: true };
}

// 从 ZIP Buffer 解析 central directory → [{name, method, compSize, uncompSize, crc, localOffset, isDir}]。
// 手动找 EOCD（从尾部倒扫 0x06054b50），读 central dir 偏移与条目数，逐条读 central header。只读元数据，不解压。
// 损坏/非 ZIP → 抛人话错误。
function zipReadCentralDir(buf) {
  // 从尾部倒扫 EOCD 签名。EOCD 后只可能跟不超过 65535 字节的 comment,所以只扫最后 65557 字节
  // (修前对 500MB 的非 zip 文件逐字节倒扫到头)。
  let eocdPos = -1;
  const scanFloor = Math.max(0, buf.length - 22 - 0xFFFF);
  for (let i = buf.length - 22; i >= scanFloor; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdPos = i; break; }
  }
  if (eocdPos < 0) throw new Error('不是有效的 ZIP 文件（找不到结尾记录）');
  const totalEntries = buf.readUInt16LE(eocdPos + 10);
  const cdSize = buf.readUInt32LE(eocdPos + 12);
  const cdOffset = buf.readUInt32LE(eocdPos + 16);
  if (totalEntries === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) throw new Error('不支持 zip64 格式的压缩包（条目数或体积超出经典 zip 范围）');
  if (cdOffset + cdSize > buf.length) throw new Error('ZIP 目录结构越界（文件可能损坏）');
  const out = [];
  let p = cdOffset;
  for (let n = 0; n < totalEntries; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP 目录记录签名错误（文件可能损坏）');
    const flag = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const nameBuf = buf.slice(p + 46, p + 46 + nameLen);
    const decoded = zipDecodeName(nameBuf, (flag & 0x0800) !== 0);
    const name = decoded.name;
    const isDir = name.endsWith('/') || (externalAttrs & 0x10) !== 0;
    // Unix 符号链接：external attrs 高 16 位是 st_mode，S_IFLNK = 0xA000。跳过（安全）。
    const unixMode = (externalAttrs >>> 16) & 0xffff;
    const isSymlink = (unixMode & 0xF000) === 0xA000;
    out.push({ name, nameEncoding: decoded.encoding, method, crc, compSize, uncompSize, localOffset, isDir, isSymlink, flag });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// 定位一条记录的压缩数据区并做解压前的格式核对(加密 / zip64 哨兵 / 头签名)。返回压缩后的字节切片。
function zipEntryCompressedSlice(buf, rec) {
  if (rec.flag & 0x0001) throw new Error(`条目已加密（${rec.name}），不支持加密的压缩包`);
  if (rec.compSize === 0xFFFFFFFF || rec.uncompSize === 0xFFFFFFFF || rec.localOffset === 0xFFFFFFFF) throw new Error(`条目使用 zip64 扩展（${rec.name}），不支持`);
  // local header：签名 4 + 26 字节固定 → name/extra 长度在 26/28 偏移。
  const lo = rec.localOffset;
  if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('ZIP 条目头签名错误（文件可能损坏）');
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const dataStart = lo + 30 + nameLen + extraLen;
  if (dataStart + rec.compSize > buf.length) throw new Error(`条目数据越界（${rec.name}，文件可能被截断）`);
  return buf.slice(dataStart, dataStart + rec.compSize);
}
const ZIP_BOMB_MSG = `单个条目解压后超过大小上限（${Math.round(ZIP_MAX_TOTAL / 1024 / 1024)}MB）或与声明大小不符，疑似 zip 炸弹，已拒绝`;
// F9:解压后核对大小与 CRC32(修前 rec.crc 解析了却从不比对:被改坏的包照样「解压成功」)。
function zipVerifyEntry(rec, data, crc) {
  if (data.length !== rec.uncompSize) throw new Error(`条目大小与目录声明不符（${rec.name}：声明 ${rec.uncompSize} 字节，实际 ${data.length} 字节），压缩包可能已损坏`);
  if ((crc >>> 0) !== (rec.crc >>> 0)) throw new Error(`CRC32 校验失败（${rec.name}），压缩包可能已损坏`);
}

// 从 ZIP Buffer + 一条 central 记录取出解压后的数据 Buffer。读 local header 定位数据区，按 method 解压。
// method 0 = stored（原样切片）；method 8 = deflate（inflateRawSync）；其它 → 抛「不支持」。累计解压字节由调用方卡上限。
function zipReadEntryData(buf, rec) {
  const comp = zipEntryCompressedSlice(buf, rec);
  let data;
  if (rec.method === 0) data = comp; // stored
  else if (rec.method === 8) {
    // 把关加固(收官复核):单条目 inflate 硬上限。没有它,高压缩比的【单个】条目(zip 炸弹,几百 KB 压缩
    // 体可展开出数十 GB)会在调用方的累计限额检查【之前】就被 inflateRawSync 全量展开吃爆内存——累计上限
    // 只防多条目,不防单条目。maxOutputLength 让 zlib 在超限处即刻中止,这里映射成人话。
    // F9:上限收紧到该条目声明的大小(声明本身已在解压前核对过 ≤ ZIP_MAX_TOTAL):实际输出超过声明就是撒谎。
    try { data = zlib.inflateRawSync(comp, { maxOutputLength: Math.max(1, Math.min(ZIP_MAX_TOTAL, rec.uncompSize)) }); }
    catch (e) {
      if (e && (e.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|output.*length|too (large|big)/i.test(String(e && e.message || '')))) throw new Error(ZIP_BOMB_MSG);
      throw e;
    }
  } else throw new Error(`不支持的压缩方式（method ${rec.method}），仅支持 stored/deflate`);
  zipVerifyEntry(rec, data, crc32(data));
  return data;
}
// 异步版(archive_unzip 用):inflate 走线程池、CRC 分片,解一个大条目不再卡住事件循环。语义与 zipReadEntryData 相同。
async function zipReadEntryDataAsync(buf, rec) {
  const comp = zipEntryCompressedSlice(buf, rec);
  let data;
  if (rec.method === 0) data = comp;
  else if (rec.method === 8) {
    try { data = await zipInflateRawAsync(comp, Math.max(1, Math.min(ZIP_MAX_TOTAL, rec.uncompSize))); }
    catch (e) {
      if (e && (e.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|output.*length|too (large|big)/i.test(String(e && e.message || '')))) throw new Error(ZIP_BOMB_MSG);
      throw e;
    }
  } else throw new Error(`不支持的压缩方式（method ${rec.method}），仅支持 stored/deflate`);
  zipVerifyEntry(rec, data, await crc32Async(data));
  return data;
}

module.exports = { crc32, crc32Async, ZIP_MAX_SINGLE_FILE, ZIP_MAX_TOTAL, ZIP_MAX_ENTRIES, zipWrite, zipWriteAsync, zipReadCentralDir, zipReadEntryData, zipReadEntryDataAsync, zipTopLevelNames };
