'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const { apiFailure, contentTypeFor, json, readJsonBody, send } = require('./http-protocol.cjs');
const { pathWithinRoot } = require('./path-containment.cjs');

function createAttachmentRoutes({
  paths, tokenOk, makeAttachmentRecord,
  maybeTranscribeAudioAttachment, maybeOcrImageAttachment, maybeCompressImageAttachment,
}) {
  async function handleAttachmentApiRoutes(req, res, pathname) {
    if (req.method === 'POST' && pathname === '/api/upload') {
      const body = await readJsonBody(req);
      const file = await makeAttachmentRecord(body);
      // 127-114c②:音频附件尽力转写(函数内部绝不 throw —— 未配置零行为,失败只落 transcribeError,
      // 文件已落盘可下载,转写是增量)。13→13b 既有边,委派行形状同下楼几条域路由。
      await maybeTranscribeAudioAttachment(file);
      // v1.9:图片附件预处理(OCR 文本兜底 / 超限压缩派生件;两函数内部各自零 throw,绝不挡上传)。
      await maybeOcrImageAttachment(file);
      await maybeCompressImageAttachment(file);
      return send(res, json({ ok: true, file }));
    }
    // 图片/附件回显:读取 makeAttachmentRecord 写下的上传件原字节(聊天气泡里的图片缩略图/大图)。
    // 只读内容型 GET:token 门 + handler 自查(同 /api/file/preview 纵深);第二道闸把目标锁死在
    // uploads 根内(词法 + realpath 双校验,符号链接也逃不出),服务面 = 工作台自己写过的上传目录。
    if (req.method === 'GET' && pathname === '/api/upload/content') {
      if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
      const q = new URL(req.url, 'http://x').searchParams;
      const id = String(q.get('id') || '');
      const name = String(q.get('name') || '');
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return send(res, apiFailure('upload.id_invalid', {}, 'invalid upload id', 400));
      // name 只许纯 basename(无分隔符/无 ..);与 makeAttachmentRecord 的 safeName 同域。
      if (!name || name.length > 255 || name !== path.basename(name) || name === '.' || name === '..') {
        return send(res, apiFailure('upload.name_invalid', {}, 'invalid attachment name', 400));
      }
      const uploadsRoot = await fsp.realpath(paths.uploads).catch(() => paths.uploads);
      const target = path.resolve(path.join(paths.uploads, id, name));
      if (!pathWithinRoot(target, path.normalize(paths.uploads))) return send(res, apiFailure('upload.not_found', {}, 'attachment not found', 404));
      const real = await fsp.realpath(target).catch(() => null);
      if (!real || !pathWithinRoot(real, uploadsRoot)) return send(res, apiFailure('upload.not_found', {}, 'attachment not found', 404));
      let buffer = null;
      try { buffer = await fsp.readFile(real); } catch { buffer = null; }
      if (!buffer) return send(res, apiFailure('upload.not_found', {}, 'attachment not found', 404));
      return send(res, { status: 200, headers: { 'content-type': contentTypeFor(name), 'cache-control': 'private, max-age=86400' }, body: buffer });
    }
  }
  return handleAttachmentApiRoutes;
}

module.exports = { createAttachmentRoutes };
