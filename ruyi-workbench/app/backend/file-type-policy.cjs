'use strict';
const path = require('node:path');
const BINARY_READ_SUFFIXES = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'tif', 'tiff',
  'pdf', 'zip', 'gz', 'tar', 'rar', '7z', 'exe', 'dll', 'so', 'dylib', 'bin',
  'mp3', 'mp4', 'avi', 'mov', 'mkv', 'wav', 'flac', 'woff', 'woff2', 'ttf', 'otf', 'eot',
  'class', 'o', 'obj', 'pyc', 'wasm',
  // 2026-10 走查(R2):Office / 压缩容器 / 数据库。它们按 UTF-8 宽松解码是一堆乱码,修前 file_read 回 ok:true 还把乱码当内容交给模型
  // (.docx/.xlsx/.pptx 本质是 zip;.jar/.apk 同理;.sqlite/.db 是二进制页)。按扩展名直接拒,并在 hint 里指向该用的工具。
  'doc', 'docx', 'docm', 'dot', 'dotx', 'xls', 'xlsx', 'xlsm', 'xlsb', 'ppt', 'pptx', 'pptm', 'odt', 'ods', 'odp',
  'jar', 'war', 'ear', 'apk', 'whl', 'nupkg', 'bz2', 'xz', 'zst', 'cab', 'iso', 'msi',
  'sqlite', 'sqlite3', 'db', 'mdb', 'accdb',
]);
function isBinaryReadPath(p) {
  const ext = path.extname(String(p || '')).replace(/^\./, '').toLowerCase();
  return ext !== '' && BINARY_READ_SUFFIXES.has(ext);
}
// 被 file_read 按扩展名拒绝时的下一步:按文件类型指向真正该用的工具(模型据此改道,而不是反复重试 file_read)。
const BINARY_READ_OFFICE = new Set(['doc', 'docx', 'docm', 'dot', 'dotx', 'xls', 'xlsx', 'xlsm', 'xlsb', 'ppt', 'pptx', 'pptm', 'odt', 'ods', 'odp']);
const BINARY_READ_ZIPLIKE = new Set(['zip', 'jar', 'war', 'ear', 'apk', 'whl', 'nupkg']);
const BINARY_READ_DB = new Set(['sqlite', 'sqlite3', 'db', 'mdb', 'accdb']);
function binaryReadHint(p) {
  const ext = path.extname(String(p || '')).replace(/^\./, '').toLowerCase();
  if (BINARY_READ_OFFICE.has(ext)) return '新版 Office/ODF 可直接 file_read 读取文字与内嵌图片,不需要桌面控制;旧 .doc/.xls/.ppt 请先另存为 .docx/.xlsx/.pptx,或用 script_run 解析';
  if (ext === 'pdf') return 'PDF 可直接 file_read {path,pageOffset,pageLimit} 读取文字与页面图像(需要 Python + pdfplumber),不需要桌面控制';
  if (BINARY_READ_ZIPLIKE.has(ext)) return '这是 zip 类压缩包:先用 archive_unzip {list:true} 看条目清单,再解压到工作区后读取需要的文件';
  if (BINARY_READ_DB.has(ext)) return '这是数据库文件,不是文本:没有原生读取工具,请用 script_run 写 python(sqlite3 模块)或命令行查询';
  return '图片可直接 file_read,视觉模型会收到图像;其它二进制文件不能按文本读取';
}

module.exports = { isBinaryReadPath, binaryReadHint };
