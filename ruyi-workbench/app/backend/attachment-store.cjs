'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const { decodeTextFileBytes } = require('./text-codecs.cjs');

// 117w-W1 提交②(27 号文 §11.19.2):Windows 文件系统非法字符的【唯一一份】替换表 —— 尖括号、
// 冒号、双引号、两种斜杠、竖线、问号、星号、控制字符,一律换成下划线;中文与其它可见字符原样保留。
// 修前它是 makeAttachmentRecord 里的一条内联正则,提交② 的派生子工作区(13k stewardWorkspaceSlug)
// 要用同一张表 —— 抄第二份迟早分叉(一边补了新字符另一边没补,于是「附件名安全、目录名不安全」)。
// 抽成函数是为了让两处【共用同一个正则字面量】,不是为了复用一行代码。
function sanitizeFsSegmentName(fsSegmentRaw) {
  return String(fsSegmentRaw == null ? '' : fsSegmentRaw).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}

function createAttachmentStore({ paths, ensureDirs, makeId, nowIso }) {
  async function makeAttachmentRecord(input) {
    await ensureDirs();
    const id = makeId('file');
    // 代码走查 C8:名字按 Windows 形取文件名(认 \ 与 /);非字符串、空、「.」「..」、全是点和空格(Windows 会吃掉
    // 结尾的点与空格)一律回落 upload.bin。修前「..」会写到目录本身上:EISDIR 500、报错带出数据目录绝对路径。
    const rawName = typeof input.name === 'string' ? input.name : '';
    let safeName = sanitizeFsSegmentName(path.win32.basename(rawName)).replace(/[. ]+$/, '').slice(0, 200);
    if (!safeName || /^[. ]*$/.test(safeName)) safeName = 'upload.bin';
    const targetDir = path.join(paths.uploads, id);
    await fsp.mkdir(targetDir, { recursive: true });
    const target = path.join(targetDir, safeName);
    const base64 = String(input.data || '').includes(',')
      ? String(input.data).split(',').pop()
      : String(input.data || '');
    const buffer = Buffer.from(base64, 'base64');
    try { await fsp.writeFile(target, buffer); }
    catch (error) { await fsp.rm(targetDir, { recursive: true, force: true }).catch(() => {}); throw error; }   // 不留空的 uploads/<id>/

    let textPreview = '';
    // v1.9:svg 是文本(矢量图源码)进 textPreview;像素图(png/jpg/…)不进,打 kind:'image' 走图片预处理。
    const textLike = /\.(txt|md|json|js|ts|tsx|jsx|py|ps1|bat|cmd|csv|xml|svg|html|css|yaml|yml|ini|log)$/i.test(safeName);
    if (textLike && buffer.length <= 256 * 1024) {
      textPreview = decodeTextFileBytes(buffer, true).slice(0, 12000);   // 走查 W1·F4:GBK / UTF-16(带 BOM)按内容判编码,不再一律当 UTF-8
    }
    // 127-114c②(26 号文 §3):音频附件打 kind:'audio'(扩展名白名单)——上传路由凭它触发尽力转写;
    // 非音频不落此字段(与 hiddenModels/caps「空不落字段」同模具,存量记录形状零漂移)。
    const audioLike = /\.(wav|mp3|m4a|webm|ogg|flac)$/i.test(safeName);
    // v1.9:图片附件打 kind:'image'(与 audio 同模具,空不落字段)——上传路由凭它触发图片预处理
    // (OCR 文本兜底 / 超限压缩派生件,见 13b maybeOcrImageAttachment / maybeCompressImageAttachment)。
    const imageLike = /\.(png|jpe?g|gif|webp|bmp)$/i.test(safeName);
    return {
      id,
      name: safeName,
      path: target,
      size: buffer.length,
      createdAt: nowIso(),
      textPreview,
      ...(audioLike ? { kind: 'audio' } : {}),
      ...(imageLike ? { kind: 'image' } : {}),
    };
  }

  return { makeAttachmentRecord };
}

module.exports = { createAttachmentStore, sanitizeFsSegmentName };
