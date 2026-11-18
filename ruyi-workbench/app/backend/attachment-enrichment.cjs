'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

function createAttachmentEnrichment({
  ASR_MAX_BODY_BYTES, readConfig, PrivacyGateway, activeOpenAiProvider,
  collectBridgedTools, resolveBridge, getBridgedClient,
  resolveAsrProvider, voiceLexiconAsrPromptFor, transcribeAudioViaProvider,
}) {
  // ④ 音频附件尽力转写:kind:'audio' 的上传件,ASR 已配置就出站转写并把文本挂上 record.transcript
  // (裁 12000,同 textPreview 上限);未配置 = 零行为(连 transcribeError 都不落,与 ① 同口径);
  // 超 25 MB / 配置缺腿 / 上游失败 → 只落 transcribeError 代码,绝不挡上传 —— 文件已落盘可下载,
  // 转写是增量(26 号文 §3「原文件保留可下载」)。本函数绝不 throw:上传主路径不能被转写故障打翻。
  async function maybeTranscribeAudioAttachment(file) {
    try {
      if (!file || file.kind !== 'audio' || !file.path) return;
      const config = await readConfig();
      const resolved = resolveAsrProvider(config);
      if (resolved.failure) {
        if (resolved.failure.code !== 'asr.not_configured') file.transcribeError = resolved.failure.code;
        return;
      }
      if (!(file.size > 0) || file.size > ASR_MAX_BODY_BYTES) { file.transcribeError = 'asr.too_large'; return; }
      const audio = await fsp.readFile(file.path);
      if (!audio.length) return;
      const ext = String(file.name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
      const mime = { wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', webm: 'audio/webm', ogg: 'audio/ogg', flac: 'audio/flac' }[(ext && ext[1]) || ''] || 'application/octet-stream';
      const prompt = await voiceLexiconAsrPromptFor(resolved.provider, '');   // 59 号文:个人词当提示(会议录音里的人名、项目名)
      const result = await transcribeAudioViaProvider(resolved.provider, resolved.asrModel, { audio, contentType: mime, filename: file.name, language: '', prompt });
      if (result.failure) { file.transcribeError = result.failure.code; return; }
      file.transcript = String(result.text || '').slice(0, 12000);
    } catch { file.transcribeError = 'asr.internal'; }
  }
  // v1.9 图片输入增强(与上面音频转写同模具:尽力而为、绝不 throw、未配置/缺席零行为):
  //   ① maybeOcrImageAttachment —— OCR 文本兜底。当前主端点【不收图】(provider.vision !== true)时,上传即经
  //      桥接的 ai_computer_control__ocr_image 把图里的文字落 record.ocrText;进提示词由 03 buildAttachmentPrompt
  //      打 <attachment kind="image-ocr" untrusted> 围栏,纯文本模型也能拿到图内文字。端点收图(vision=true)时
  //      不 OCR —— 像素随消息直达模型,OCR 是纯开销。
  //   ② maybeCompressImageAttachment —— 超限压缩。图片 >5MB 且端点收图时,用桥接的 ai_computer_control__image_resize
  //      重采样出 ≤5MB 的派生件 record.sendPath(uploads/<id>/send.jpg);04-visual-pipeline 发送时优先读它,
  //      超限大图不再直接降级占位。两条都要求桥接 MCP 在场;缺席/失败 = 零行为(存量 record 形状零漂移)。
  const IMAGE_OCR_MAX_CHARS = 12000;           // 与 textPreview 上限同值
  const IMAGE_SEND_MAX_BYTES = 5 * 1024 * 1024; // 与 04-visual-pipeline 的 IMAGE_ATTACH_MAX 同值(那边是发送闸,这边是压缩目标)

  async function bridgedToolClient(config, toolName) {
    const { route } = await collectBridgedTools(config);
    const bridge = resolveBridge(route, toolName);
    if (!bridge) return null;
    const client = await getBridgedClient(bridge.serverId, config);
    return client ? { client, toolName: bridge.toolName } : null;
  }

  async function maybeOcrImageAttachment(file) {
    try {
      if (!file || file.kind !== 'image' || !file.path) return;
      const config = await readConfig();
      if (typeof PrivacyGateway !== 'undefined') PrivacyGateway.assertMediaAllowed(config);
      const provider = activeOpenAiProvider(config);
      if (provider && provider.vision === true) return; // 收图端点:像素直达,不需要 OCR 文本
      const target = await bridgedToolClient(config, 'ai_computer_control__ocr_image');
      if (!target) return;
      if (typeof PrivacyGateway !== 'undefined') PrivacyGateway.assertMediaAllowed(await readConfig());
      const result = await target.client.callTool(target.toolName, { path: file.path, lang: 'zh' });
      if (!result || result.ok === false) return;
      const text = typeof result.text === 'string' ? result.text
        : (typeof result.content === 'string' ? result.content : '');
      if (text.trim()) file.ocrText = text.slice(0, IMAGE_OCR_MAX_CHARS);
    } catch (error) { file.ocrError = error.code === 'privacy.media_not_supported' ? error.code : 'ocr.internal'; }
  }

  async function maybeCompressImageAttachment(file) {
    try {
      if (!file || file.kind !== 'image' || !file.path) return;
      if (!(file.size > IMAGE_SEND_MAX_BYTES)) return;
      const config = await readConfig();
      if (typeof PrivacyGateway !== 'undefined') PrivacyGateway.assertMediaAllowed(config);
      const provider = activeOpenAiProvider(config);
      if (!provider || provider.vision !== true) return; // 不发像素的路径压缩了也没人看
      const target = await bridgedToolClient(config, 'ai_computer_control__image_resize');
      if (!target) return;
      const outPath = path.join(path.dirname(file.path), 'send.jpg');
      // 文件大小≈像素数:按面积开方缩一档再留 15% 余量给 JPEG 编码差;一轮不行再缩一次(共≤2 趴,
      // 仍超限就零行为 —— 发送侧的 5MB 闸会走原有占位降级,绝不发超限大包)。
      let scale = Math.min(1, Math.sqrt((IMAGE_SEND_MAX_BYTES * 0.85) / file.size));
      for (let i = 0; i < 2; i++) {
        if (typeof PrivacyGateway !== 'undefined') PrivacyGateway.assertMediaAllowed(await readConfig());
        const result = await target.client.callTool(target.toolName, { path: file.path, output_path: outPath, scale: Number(scale.toFixed(4)) });
        if (!result || result.ok === false || result.success === false) return;
        const st = await fsp.stat(outPath).catch(() => null);
        if (!st) return;
        if (st.size <= IMAGE_SEND_MAX_BYTES) { file.sendPath = outPath; file.sendSize = st.size; return; }
        scale *= 0.7;
      }
    } catch (error) { file.compressError = error.code === 'privacy.media_not_supported' ? error.code : 'image.compress_failed'; }
  }

  return { maybeTranscribeAudioAttachment, maybeOcrImageAttachment, maybeCompressImageAttachment };
}

module.exports = { createAttachmentEnrichment };
