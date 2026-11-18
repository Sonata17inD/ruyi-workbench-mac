'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { apiFailure, json, readJsonBody, send } = require('./http-protocol.cjs');
const { safeJsonParse } = require('./ordinary-json.cjs');
const { computeProviderCost } = require('./provider-pricing.cjs');
const { redact } = require('./secret-redaction.cjs');
const getVoiceLexicon = () => require('./voice-lexicon.cjs').VoiceLexicon;

function createAudioRoutes({
  ASR_MAX_BODY_BYTES, PrivacyGateway, ToolboxHooks, nowIso, logEvent, readConfig, appendUsageLedger,
  voiceLexiconRead, voiceLexiconUpdate, resolveAsrFixProvider, providerFixCompletion, transcribeAudioViaProvider,
  resolveAsrProvider, asrFixModeOf, voiceLexiconAsrPromptFor, asrFixMessages, asrFixSanity, resolveAsrStreamProvider,
}) {
  // ── audio 域:/api/audio/transcribe(127-114b,26 号文 §3/§4 冻结边界,45 号文 §2 ②派单)──────────
  // 全波【唯一出网面】:用户音频字节出网到所配 ASR 端点。ROUTE_AUTH token 级(不给 token-browser)。
  // 判据(45 号文 §4 ②):未配置 409 / 非 audio/* 400 / 超 25 MB 413(早于 128 MB 总闸)/ 成功 200 /
  // 上游 5xx 统一信封 502;记账 kind:'aux', note:'asr',上游无 usage 时 estimated:true。
  // 威胁模型(26 号文 §4):目标 URL 只来自配置(providers[].audioBaseUrl || baseUrl),绝不接受请求体里的
  // URL;filename/language/prompt 全部截断清洗;上游错误回显【先过 04 redact 再】裁到 1000 字符
  // (107-S1 ⑦:会回显请求头的端点能把 Authorization 原样送回来 —— 脱敏落在生产者 05
  // transcribeAudioViaProvider 那一处,本路由与 audio_transcribe 工具两个消费面一起生效)。
  // apiKey 永不出本进程 —— Authorization 只往所配 provider 自己那里发。audioBaseUrl 与 baseUrl【同等对待】:45 号文 §1.6 实证
  // baseUrl 今天没有任何 URL 准入校验,本刀不凭空发明一道(独立安全决定,两条出网面要收一起收,107 记档)。
  // 25 MB 专用闸的读法:Content-Length 预检 + 流式累计双道,任一超 ASR_MAX_BODY_BYTES 即 413,
  // 不经 readBody(那条是 128 MB 总闸)——「早于总闸」是可观测行为,不是注释(见 00-boot 该常量注释)。
  async function readAudioBody(req, limit = ASR_MAX_BODY_BYTES) {
    // 吞掉「提前结束响应」之后 req 上可能再发的 error/aborted(25MB 处判 413 时客户端往往还在续传,
    // 服务端随即拆除这条连接)。挂上空接即可,读取语义不变。
    // 实测备注(127-114b e2e):413 之后新连接会有【瞬态】接受停顿(几百毫秒级,内核清理在途字节),
    // 服务本身不死 —— 客户端侧的正确姿势是等它回来(e2e 里有专门一条断言钉住「服务撑得住」)。
    // 130:limit 可传(流式音频块的闸是 1 MB,不是整段的 25 MB);缺省值与从前逐字节相同。
    req.on('error', () => {});
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) {
      const err = new Error('audio body too large'); err.statusCode = 413; err.code = 'asr.too_large';
      throw err;
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > limit) {
        const err = new Error('audio body too large'); err.statusCode = 413; err.code = 'asr.too_large';
        throw err;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  async function handleAudioApiRoutes(req, res, pathname) {
    // 判定点必须是「方法 + pathname === '...'」肯定形 —— 路由清册扫描器只认这个形状(route-inventory.js
    // 扫 pathname ===),反向 guard(!== 提前 return)会被判成「ROUTE_AUTH 死行」;已实现路由分裂踩过一次。
    if (req.method === 'POST' && pathname === '/api/audio/transcribe') {
      return await handleAudioTranscribe(req, res);
    }
    // 130(51 号文 §2.3):实时识别的代理路由。开会话是裸路径;喂音频／收尾／关会话带会话 id,走前缀判定点。
    if (req.method === 'POST' && pathname === '/api/audio/stream/sessions') {
      return await handleAudioStreamOpen(req, res);
    }
    if (req.method === 'POST' && pathname.startsWith('/api/audio/stream/sessions/')) {
      return await handleAudioStreamSession(req, res, pathname);
    }
    if (req.method === 'DELETE' && pathname.startsWith('/api/audio/stream/sessions/')) {
      return await handleAudioStreamSession(req, res, pathname);
    }
    // 131b(52 号文 §5):句尾改错 —— 一句的第一遍文字(＋音频)→ 重听／大模型改字／两者合成。
    if (req.method === 'POST' && pathname === '/api/audio/correct') {
      return await handleAudioCorrect(req, res);
    }
    // 133f:开录之前的预热闸 —— 本地识别模型装着没有;没装就现在装,装好才回。
    if (req.method === 'POST' && pathname === '/api/audio/warmup') {
      return await handleAudioWarmup(req, res);
    }
    // 59 号文:语音词库 —— 设置页读(?base=1 附原厂表全文)与整份写(个人词那份文本 + 原厂表开关)。
    if (req.method === 'GET' && pathname === '/api/audio/lexicon') {
      return await handleAudioLexiconGet(req, res);
    }
    if (req.method === 'POST' && pathname === '/api/audio/lexicon') {
      return await handleAudioLexiconSave(req, res);
    }
    // 59 号文 §6:从修改里学 —— 发送时前端交来「这次落进输入框的几句机器写的字 ＋ 最终发出去的字」。
    if (req.method === 'POST' && pathname === '/api/audio/lexicon/observe') {
      return await handleAudioLexiconObserve(req, res);
    }
    return false;
  }
  // ── 59 号文:语音词库的两条路由 ─────────────────────────────────────────────────────────────────────
  // 读:{ ok, text(个人词,一行一条「词 = 样子1, 样子2」), count, learned, typed, pending, learn, base:{enabled,count[,text]}, limits }。
  // 写:体 { text?: string, base?: boolean, learn?: boolean } —— text 给了就整份替换个人词(04j applyText:留下的保留来源与次数、
  // 学来的删掉留墓碑),base 开关原厂常用词,learn 开关「从我的修改里学」(59 号文 §6,缺省开);三样都没给 400。
  // 文本超长 413、条数超上限 400 —— 整份拒收,不静默截断。只记条数的审计。
  async function handleAudioLexiconGet(req, res) {
    const VoiceLexicon = getVoiceLexicon();
    const withBase = new URL(req.url, 'http://x').searchParams.get('base') === '1';
    return send(res, json({ ok: true, ...VoiceLexicon.view(await voiceLexiconRead(), { withBase }) }));
  }
  async function handleAudioLexiconSave(req, res) {
    let body;
    try { body = await readJsonBody(req); } catch { return send(res, apiFailure('voice.lexicon_bad_request', {}, '请求体不是合法 JSON', 400)); }
    const hasText = body && typeof body.text === 'string';
    const hasBase = body && typeof body.base === 'boolean';
    const hasLearn = body && typeof body.learn === 'boolean';
    if (!hasText && !hasBase && !hasLearn) return send(res, apiFailure('voice.lexicon_bad_request', {}, 'text(字符串)、base(布尔)、learn(布尔)至少给一个', 400));
    const VoiceLexicon = getVoiceLexicon();
    if (hasText && body.text.length > VoiceLexicon.MAX_TEXT_CHARS) {
      return send(res, apiFailure('voice.lexicon_too_large', { maxChars: VoiceLexicon.MAX_TEXT_CHARS }, '词库文本超过上限', 413));
    }
    let rejected = null, skipped = 0;
    const saved = await voiceLexiconUpdate(state => {
      let next = state;
      if (hasText) {
        const r = VoiceLexicon.applyText(next, body.text, nowIso());
        if (r.overflow) { rejected = { count: r.count + r.overflow }; return null; }
        next = r.state; skipped = r.skipped;
      }
      if (hasBase) next = VoiceLexicon.setBase(next, body.base);
      if (hasLearn) next = VoiceLexicon.setLearn(next, body.learn);
      return next;
    });
    if (rejected) {
      return send(res, apiFailure('voice.lexicon_too_many', { count: rejected.count, maxTerms: VoiceLexicon.MAX_TERMS }, '词条超过上限', 400));
    }
    const view = VoiceLexicon.view(saved);
    logEvent({ kind: 'voice_lexicon_save', terms: view.count, base: view.base.enabled, learn: view.learn, skipped });
    return send(res, json({ ok: true, ...view, skipped }));
  }
  // ── 59 号文 §6:从修改里学 ─────────────────────────────────────────────────────────────────────────
  // 体 { sentences:[{ text(机器最后写进输入框的那一版), first?(第一遍原文) }], final(最终发出去的字) } —— 前端在发送那一刻交来
  // (只有麦克风这一路记 sentences;没用语音的消息 sentences 为空,只从打的字里抽英文专名)。学习关着 → { ok, learn:false },什么都不做。
  // 编排:04j VoiceLearn.extract 抽候选 → 有要判的、且配了改字大模型(与句尾改错同一个端点,resolveAsrFixProvider)就请它判一发
  // (aux/voice-learn 记账;没配/失败就只靠读音规则与次数)→ voiceLexiconUpdate 串行落盘(VoiceLearn.apply)。
  // 回 { ok, learn:true, learned:[{ term, heard }](这次新学会的,前端据此提示一句), reversed(这次被扣分的词数) }。
  // 文本只在内存里走一趟:日志只记条数(几句、对上几句、几处改动、问了几处、学会几个),不记字。
  async function handleAudioLexiconObserve(req, res) {
    const t0 = Date.now();
    let body;
    try { body = await readJsonBody(req); } catch { return send(res, apiFailure('voice.observe_bad_request', {}, '请求体不是合法 JSON', 400)); }
    const final = body && typeof body.final === 'string' ? body.final : null;
    const sentences = body && body.sentences != null ? body.sentences : [];
    if (final == null || !Array.isArray(sentences) || sentences.some(x => !x || typeof x !== 'object' || typeof x.text !== 'string' || (x.first != null && typeof x.first !== 'string'))) {
      return send(res, apiFailure('voice.observe_bad_request', {}, 'final 是字符串,sentences 是 [{ text, first? }]', 400));
    }
    const { VoiceLearn } = require('./voice-learn.cjs');
    if (final.length > VoiceLearn.MAX_FINAL_CHARS || sentences.length > VoiceLearn.MAX_SENTENCES
      || sentences.some(x => x.text.length > VoiceLearn.MAX_SENTENCE_CHARS || String(x.first || '').length > VoiceLearn.MAX_SENTENCE_CHARS)) {
      return send(res, apiFailure('voice.observe_too_large', { maxChars: VoiceLearn.MAX_FINAL_CHARS, maxSentences: VoiceLearn.MAX_SENTENCES }, '要学的文字超过上限', 413));
    }
    const before = await voiceLexiconRead();
    if (!before.learn) return send(res, json({ ok: true, learn: false, learned: [], reversed: 0 }));
    const plan = VoiceLearn.extract({ sentences, final });
    const ask = VoiceLearn.judgeMessages(plan, before);
    let verdicts = null, judge = 'none';
    if (ask) {
      const llmRes = resolveAsrFixProvider(await readConfig());
      if (llmRes.failure) judge = 'off';
      else {
        const r = await providerFixCompletion(llmRes.provider, llmRes.model, ask.messages);
        judge = r.ok ? 'ok' : 'failed';
        if (r.ok) verdicts = VoiceLearn.parseJudge(plan, ask.ids, r.content);
        appendAsrFixUsage(llmRes, r, ask.messages.reduce((n, m) => n + String(m.content).length, 0), 'voice-learn');
      }
    }
    let result = null;
    await voiceLexiconUpdate(state => {
      result = VoiceLearn.apply(state, plan, verdicts, nowIso());
      return result.changed ? result.state : null;
    });
    logEvent({
      kind: 'voice_learn', sentences: plan.stats.sentences, fitted: plan.stats.fitted, edits: plan.items.length, typed: plan.typed.length,
      judge, asked: ask ? ask.ids.length : 0, judged: verdicts ? verdicts.size : 0, learned: result.learned.length, reversed: result.reversed.length,
      pending: result.pending, durationMs: Date.now() - t0,
    });
    return send(res, json({ ok: true, learn: true, learned: result.learned.slice(0, 5).map(x => ({ term: x.term, heard: x.heard })), reversed: result.reversed.length }));
  }
  // ── 133f(用户 2026-09-21「标准/重度第一次又卡又不准」):预热 —— 语音识别的本地模型装好了没,没好就现在装 ─────────────
  // 成因(日志实证,2026-09-21 asr_transcribe_ok):toolbox 的 asr-shim 空转时不 import torch(约定 §2.2「空转要轻」),第一发转写才加载 ——
  // 新进程上首句 12–33 s(隔离实验:import+探设备 7–8 s、载权重 3–4 s、首次推理 2–2.5 s),同一时刻排队的几句全等它,期间屏上只有
  // 第一遍小模型的字;轻度档(asr-stream 里常驻的 SenseVoice)没有这一段。前端在开录之前先 POST 这里:
  //   · 组件的 /health 说这份模型已装着 → 秒回 {warm:true};
  //   · 否则用 1 秒静音走【和真请求同一条】出站路径把它装好、内核热一遍(实验:预热后第一句真话就是稳态 ≈ 0.7 s,静音足够),等它返回才说好了。
  // 只对 toolbox- 服务商有意义(云端没有「装」这回事 → skipped:'remote' 秒回)。同一份模型的并发预热合并成一发(用户取消再点、两个输入框
  // 同时点都不会装两遍)。预热不是用户的一次转写:不记账(transcribeAudioViaProvider 的 warmup 开关),记 asr_warmup 审计(只有元数据)。
  const AUDIO_WARMUP_SILENCE_MS = 1000;
  const audioWarmups = new Map();   // 'providerId|model' → Promise<{ok,warm}|{failure}>:同一份模型同一时刻只装一次
  function silentWav16k(ms) {
    const samples = Math.round(16000 * ms / 1000);
    const wav = Buffer.alloc(44 + samples * 2);   // 全零 = 静音
    wav.write('RIFF', 0); wav.writeUInt32LE(36 + samples * 2, 4); wav.write('WAVE', 8); wav.write('fmt ', 12);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24);
    wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
    return wav;
  }
  // 组件报「已装着」且装的正是要用的这份:loaded 为真,并且 要的模型名 = 已装那份的真名(auto 挑中的)／组件缺省名／它内置的离线识别模型名。
  // 拿不准(没有 loaded 字段、名字对不上)一律当没装 —— 多打一发静音的代价是几百毫秒,判错成「已装」的代价是用户又等半分钟。
  function audioWarmupLoaded(body, model) {
    if (!body || body.loaded !== true) return false;
    const want = String(model || '').trim().toLowerCase();
    if (!want) return false;
    const names = [body.resolvedModel, body.model, body.offline && body.offline.model].map(x => String(x || '').trim().toLowerCase()).filter(Boolean);
    return names.includes(want);
  }
  async function runAudioWarmup(provider, asrModel) {
    const t0 = Date.now();
    await ToolboxHooks.ensureForProvider(provider.id);   // 组件这会儿没在跑(崩了／上次没起来)→ 就地再起,与转写同一条路
    const health = typeof ToolboxHooks.healthForProvider === 'function' ? await ToolboxHooks.healthForProvider(provider.id) : { running: false, body: null };
    if (audioWarmupLoaded(health.body, asrModel)) {
      logEvent({ kind: 'asr_warmup', provider: provider.id, model: asrModel, warm: true, durationMs: Date.now() - t0 });
      return { ok: true, warm: true };
    }
    const r = await transcribeAudioViaProvider(provider, asrModel, { audio: silentWav16k(AUDIO_WARMUP_SILENCE_MS), contentType: 'audio/wav', filename: 'warmup.wav', language: '', prompt: '', warmup: true });
    logEvent({ kind: 'asr_warmup', provider: provider.id, model: asrModel, warm: false, ok: !r.failure, ...(r.failure ? { code: r.failure.code } : {}), durationMs: Date.now() - t0 });
    return r.failure ? { failure: r.failure } : { ok: true, warm: false };
  }
  async function handleAudioWarmup(req, res) {
    try { await readAudioBody(req, 4096); } catch { /* 请求体没用(前端发 {}),读不读得完都不影响 */ }
    const t0 = Date.now();
    const resolved = resolveAsrProvider(await readConfig());
    if (resolved.failure) { const f = resolved.failure; return send(res, apiFailure(f.code, f.params, f.message, f.status)); }
    const { provider, asrModel } = resolved;
    if (!String(provider.id || '').startsWith('toolbox-')) return send(res, json({ ok: true, ready: true, skipped: 'remote', durationMs: 0 }));
    const key = provider.id + '|' + asrModel;
    let job = audioWarmups.get(key);
    if (!job) { job = runAudioWarmup(provider, asrModel).finally(() => { audioWarmups.delete(key); }); audioWarmups.set(key, job); }
    let r;
    try { r = await job; }
    catch (err) { return send(res, apiFailure('asr.warmup_failed', {}, '预热失败: ' + String(err && err.message || err).slice(0, 200), 502)); }
    if (r.failure) { const f = r.failure; return send(res, apiFailure(f.code, f.params, f.message, f.status)); }
    return send(res, json({ ok: true, ready: true, warm: r.warm, durationMs: Date.now() - t0 }));
  }
  // ── 131b(52 号文 §3/§5;用户 2026-09-21 拍板 2):句尾改错的编排 ────────────────────────────────────────────
  // 输入 JSON {text: 第一遍文字, audio?: base64 WAV(这一句), contentType?};按 asrFixMode 决定走哪几条路:
  //   auto  = 配了整段识别且带音频 → 重听;配了大模型 → 改字(有重听结果就给它两版合成);
  //   audio = 只重听;llm = 只改字;off = 409。
  // 结果优先级:大模型改出来的(过了合理性)> 重听的 > 空(两条路都没成 → 502,前端保留第一遍)。
  // 上游地址只来自配置;音频只在内存;日志只记元数据(模式、两条路各自成没成、字数、耗时),不记文本。记账:大模型一发 aux/asr-fix。
  // 改字大模型一发的记账(aux;句尾改错 note:'asr-fix'、从修改里学的复核 note:'voice-learn'):与 /api/audio/transcribe 同口径 ——
  // 有 usage 记真数,没有就按字数估算(inChars ≈ 送出去的字数)并标 estimated。正文为空那一发也花了钱,照记;连 usage 都没有的失败不记。
  function appendAsrFixUsage(llmRes, r, inChars, note) {
    if (!r.usage && !r.ok) return;
    const u = r.usage && typeof r.usage === 'object' ? r.usage : null;
    const num = n => { const v = Number(u && u[n]); return Number.isFinite(v) && v > 0 ? Math.round(v) : 0; };
    const realIn = num('prompt_tokens') || num('input_tokens'), realOut = num('completion_tokens') || num('output_tokens');
    const hasUsage = (realIn + realOut) > 0;
    const inTok = hasUsage ? realIn : Math.max(1, Math.ceil(inChars / 2));
    const outTok = hasUsage ? realOut : Math.max(1, Math.ceil(String((r.ok && r.content) || '').length / 2));
    const { cost, currency } = computeProviderCost(llmRes.provider, inTok, outTok, 0, llmRes.model);
    appendUsageLedger({
      sessionId: '', engine: 'openai', provider: llmRes.provider.id, model: llmRes.model,
      inTok, outTok, cachedInTok: 0, cost, currency, costTrusted: cost != null, estimated: !hasUsage, kind: 'aux', note,
    });
  }
  const AUDIO_FIX_MAX_TEXT = 4000;
  const AUDIO_FIX_MAX_AUDIO_B64 = 2 * 1024 * 1024;   // 一句 ≤ 20 s 的 16 kHz WAV 约 640 KB,base64 后约 860 KB
  async function handleAudioCorrect(req, res) {
    const t0 = Date.now();
    let body;
    try { body = await readJsonBody(req); } catch { return send(res, apiFailure('asr.fix_bad_request', {}, '请求体不是合法 JSON', 400)); }
    const text = String((body && body.text) || '').trim().slice(0, AUDIO_FIX_MAX_TEXT);
    // 133a:这句前面已经落到输入框里的字(只给大模型当参考,重听那一路用不上);服务端只取尾巴,前端多给也不多花
    const context = String((body && body.context) || '').slice(-AUDIO_FIX_MAX_TEXT);
    const audioB64 = body && typeof body.audio === 'string' ? body.audio : '';
    if (!text && !audioB64) return send(res, apiFailure('asr.fix_bad_request', {}, 'text 与 audio 至少给一个', 400));
    if (audioB64.length > AUDIO_FIX_MAX_AUDIO_B64) {
      return send(res, apiFailure('asr.fix_audio_too_large', { maxBytes: AUDIO_FIX_MAX_AUDIO_B64 }, '一句的音频超过上限', 413));
    }
    const config = await readConfig();
    const mode = asrFixModeOf(config);
    if (mode === 'off') return send(res, apiFailure('asr.fix_disabled', { mode }, '句尾改错已关闭', 409));
    const audioRes = (mode !== 'llm' && audioB64) ? resolveAsrProvider(config) : null;
    const llmRes = mode !== 'audio' ? resolveAsrFixProvider(config) : null;
    const canAudio = Boolean(audioRes && !audioRes.failure);
    const canLlm = Boolean(llmRes && !llmRes.failure);
    if (!canAudio && !canLlm) {
      return send(res, apiFailure('asr.fix_not_configured', { mode }, '句尾改错没有可用的端点(整段识别与大模型都没配)', 409));
    }
    // 59 号文:语音词库 —— 重听那一路带 prompt(按第一遍文字挑出来的词),改字那一路带 <glossary>(按两版文字挑)。
    const lexicon = await voiceLexiconRead();
    let audioText = null, audioErr = '';
    if (canAudio) {
      let audio = null;
      try { audio = Buffer.from(audioB64, 'base64'); } catch { audio = null; }
      if (audio && audio.length) {
        const ct = String((body && body.contentType) || 'audio/wav').split(';')[0].trim().toLowerCase();
        const prompt = await voiceLexiconAsrPromptFor(audioRes.provider, text, lexicon);
        const r = await transcribeAudioViaProvider(audioRes.provider, audioRes.asrModel, {
          audio, contentType: ct.startsWith('audio/') ? ct : 'audio/wav', filename: 'voice.wav', language: '', prompt,
        });
        if (r.failure) audioErr = String(r.failure.code || 'failed'); else audioText = String(r.text || '').trim();
      } else audioErr = 'asr.fix_bad_audio';
    }
    let llmText = null, llmErr = '', glossaryLen = 0;
    if (canLlm && (text || audioText)) {
      const VoiceLexicon = getVoiceLexicon();
      const glossary = VoiceLexicon.glossaryLines(VoiceLexicon.pick({ text: [text, audioText || ''].join('\n'), state: lexicon }));
      glossaryLen = glossary.length;
      const r = await providerFixCompletion(llmRes.provider, llmRes.model, asrFixMessages(text, audioText, context, glossary));
      if (!r.ok) llmErr = String(r.error || 'failed').slice(0, 200);
      else {
        llmText = asrFixSanity((audioText && audioText.length > text.length) ? audioText : text, r.content) || null;
        if (!llmText) llmErr = 'sanity';
      }
      appendAsrFixUsage(llmRes, r, text.length + (audioText || '').length + 320, 'asr-fix');
    }
    const final = llmText || audioText || '';
    logEvent({
      kind: 'asr_fix', mode, audio: canAudio ? (audioText != null ? 'ok' : (audioErr || 'skip')) : 'off',
      llm: canLlm ? (llmText ? 'ok' : (llmErr || 'skip')) : 'off', inLen: text.length, ctxLen: context.length, outLen: final.length, glossary: glossaryLen, durationMs: Date.now() - t0,
    });
    if (!final) return send(res, apiFailure('asr.fix_failed', { audio: audioErr, llm: llmErr }, '两条路都没改出结果', 502));
    return send(res, json({ ok: true, text: final, used: { audio: audioText != null, llm: Boolean(llmText) }, durationMs: Date.now() - t0 }));
  }
  // ── 130(51 号文 §2):实时识别代理 —— 浏览器每 250 ms 一块 PCM 打到这里,这里转给配置里那条 asr-stream 服务商 ─────
  // 威胁模型与 /api/audio/transcribe 同:上游地址【只来自配置】(providers[].baseUrl),绝不收请求体里的 URL;
  // 浏览器只拿到一个本进程发的会话 id,上游会话 id 不出本进程;单块 ≤ 1 MB;每进程 ≤ 4 个活会话;60 s 没音频服务端回收
  // (浏览器页被关掉不会来 finish)。上游错误体先过 04 redact 再裁 500 字。不记账:本地组件不花钱(云端流式暂不支持)。
  const AUDIO_STREAM_MAX_SESSIONS = 4;
  const AUDIO_STREAM_IDLE_MS = 60000;
  const AUDIO_STREAM_CHUNK_MAX_BYTES = 1024 * 1024;
  const AUDIO_STREAM_UPSTREAM_TIMEOUT_MS = 15000;
  const audioStreamSessions = new Map();   // 本进程会话 id → { upstream, upstreamId, providerId, at }
  function audioStreamReap() {
    const now = Date.now();
    for (const [id, s] of audioStreamSessions) {
      if (now - s.at > AUDIO_STREAM_IDLE_MS) {
        audioStreamSessions.delete(id);
        logEvent({ kind: 'asr_stream', action: 'reap', provider: s.providerId });
        void audioStreamUpstream(s, 'DELETE', '/' + s.upstreamId).catch(() => {});
      }
    }
  }
  async function audioStreamUpstream(s, method, suffix, body, contentType) {
    // Re-read at every outbound chunk: the session may predate enabling protection.
    if (method !== 'DELETE' && typeof PrivacyGateway !== 'undefined') PrivacyGateway.assertMediaAllowed(await readConfig());
    const headers = body ? { 'content-type': contentType || 'application/json' } : {};
    const res = await fetch(s.upstream + '/stream/sessions' + suffix, { method, headers, body, signal: AbortSignal.timeout(AUDIO_STREAM_UPSTREAM_TIMEOUT_MS) });
    const text = await res.text();
    return { status: res.status, body: safeJsonParse(text, null), text };
  }
  function audioStreamFailure(up) {
    const message = redact(String((up && up.body && up.body.error && up.body.error.message) || (up && up.text) || '')).slice(0, 500);
    return apiFailure('asr.stream_upstream', { status: up ? up.status : 0 }, message || '实时识别服务报错', 502);
  }
  async function handleAudioStreamOpen(req, res) {
    const config = await readConfig();
    if (typeof PrivacyGateway !== 'undefined') PrivacyGateway.assertMediaAllowed(config);
    let resolved = resolveAsrStreamProvider(config);
    if (resolved.failure) { const f = resolved.failure; return send(res, apiFailure(f.code, f.params, f.message, f.status)); }
    // 指着 toolbox 组件而它这会儿没在跑 → 就地再起(与 transcribeAudioViaProvider 同一条路);端口若变了配置已改写,重取一次。
    if (String(resolved.provider.id || '').startsWith('toolbox-') && typeof ToolboxHooks.ensureForProvider === 'function') {
      await ToolboxHooks.ensureForProvider(resolved.provider.id);
      resolved = resolveAsrStreamProvider(await readConfig());
      if (resolved.failure) { const f = resolved.failure; return send(res, apiFailure(f.code, f.params, f.message, f.status)); }
    }
    let raw;
    try { raw = await readAudioBody(req, 64 * 1024); }
    catch (err) { if (err && err.statusCode === 413) return send(res, apiFailure('asr.stream_bad_request', {}, '请求体过大', 413)); throw err; }
    const parsed = raw.length ? safeJsonParse(raw.toString('utf8'), null) : {};
    if (raw.length && (!parsed || typeof parsed !== 'object')) return send(res, apiFailure('asr.stream_bad_request', {}, '请求体不是合法 JSON', 400));
    let hotwords = Array.isArray(parsed.hotwords) ? parsed.hotwords.filter(w => typeof w === 'string').map(w => w.trim().slice(0, 40)).filter(Boolean).slice(0, 200) : [];
    // 59 号文:前端没给热词(今天它开会话只发 {})就用语音词库里的个人词。原厂通用词不当热词(52 号文 §2:几乎没用)。
    if (!hotwords.length) hotwords = getVoiceLexicon().hotwords(await voiceLexiconRead());
    audioStreamReap();
    if (audioStreamSessions.size >= AUDIO_STREAM_MAX_SESSIONS) return send(res, apiFailure('asr.stream_busy', { max: AUDIO_STREAM_MAX_SESSIONS }, '实时识别会话太多,稍后再试', 429));
    const upstream = String(resolved.provider.baseUrl || '').replace(/\/+$/, '');
    const s = { upstream, upstreamId: '', providerId: resolved.provider.id, at: Date.now() };
    let up;
    try { up = await audioStreamUpstream(s, 'POST', '', JSON.stringify({ hotwords }), 'application/json'); }
    catch (err) {
      logEvent({ kind: 'asr_stream', action: 'open-failed', provider: s.providerId, error: String(err && err.message || err).slice(0, 200) });
      return send(res, apiFailure('asr.stream_unreachable', { providerId: s.providerId }, '连不上实时识别服务', 502));
    }
    if (up.status !== 200 || !up.body || !/^[0-9a-f]{32}$/.test(String(up.body.id || ''))) return send(res, audioStreamFailure(up));
    s.upstreamId = String(up.body.id);
    const id = crypto.randomBytes(16).toString('hex');
    audioStreamSessions.set(id, s);
    logEvent({ kind: 'asr_stream', action: 'open', provider: s.providerId, hotwords: hotwords.length, active: audioStreamSessions.size });
    return send(res, json({ ok: true, id, sampleRate: Number(up.body.sampleRate) || 16000 }));
  }
  async function handleAudioStreamSession(req, res, pathname) {
    // 只从上面的 POST／DELETE 前缀判定点进来;这里手工拆段(不用 pathname.match —— 路由清册扫描器会把它当成一条独立的正则路由)。
    const parts = pathname.slice('/api/audio/stream/sessions/'.length).split('/');
    const id = parts[0] || '';
    const action = parts.length === 2 ? parts[1] : '';
    if (!/^[0-9a-f]{32}$/.test(id) || parts.length > 2 || (action && action !== 'audio' && action !== 'finish')) return send(res, apiFailure('asr.stream_bad_request', {}, '没有这条路径', 404));
    const s = audioStreamSessions.get(id);
    if (!s) return send(res, apiFailure('asr.stream_session_missing', { id }, '没有这个实时识别会话(可能已超时)', 404));
    if (req.method === 'DELETE') {
      if (action) return send(res, apiFailure('asr.stream_bad_request', {}, '没有这条路径', 404));
      audioStreamSessions.delete(id);
      try { await audioStreamUpstream(s, 'DELETE', '/' + s.upstreamId); } catch { /* 上游没了也算关了 */ }
      logEvent({ kind: 'asr_stream', action: 'delete', provider: s.providerId });
      return send(res, json({ ok: true }));
    }
    if (typeof PrivacyGateway !== 'undefined') PrivacyGateway.assertMediaAllowed(await readConfig());
    if (action === 'audio') {
      const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (contentType !== 'audio/l16' && contentType !== 'application/octet-stream') {
        return send(res, apiFailure('asr.stream_bad_request', { contentType }, 'Content-Type 须是 audio/L16; rate=16000', 400));
      }
      let pcm;
      try { pcm = await readAudioBody(req, AUDIO_STREAM_CHUNK_MAX_BYTES); }
      catch (err) { if (err && err.statusCode === 413) return send(res, apiFailure('asr.stream_chunk_too_large', { maxBytes: AUDIO_STREAM_CHUNK_MAX_BYTES }, '音频块超过 1 MB', 413)); throw err; }
      if (pcm.length % 2) return send(res, apiFailure('asr.stream_bad_request', {}, 'PCM16 字节数必须是偶数', 400));
      s.at = Date.now();
      let up;
      try { up = await audioStreamUpstream(s, 'POST', '/' + s.upstreamId + '/audio', pcm, 'audio/L16; rate=16000'); }
      catch (err) {
        audioStreamSessions.delete(id);
        logEvent({ kind: 'asr_stream', action: 'audio-failed', provider: s.providerId, error: String(err && err.message || err).slice(0, 200) });
        return send(res, apiFailure('asr.stream_unreachable', { providerId: s.providerId }, '连不上实时识别服务', 502));
      }
      if (up.status === 404) { audioStreamSessions.delete(id); return send(res, apiFailure('asr.stream_session_missing', { id }, '实时识别会话已失效', 404)); }
      if (up.status !== 200 || !up.body || typeof up.body !== 'object') return send(res, audioStreamFailure(up));
      const finals = Array.isArray(up.body.finals) ? up.body.finals.filter(f => f && typeof f === 'object').map(f => ({ text: String(f.text || '').slice(0, 4000), startMs: Number(f.startMs) || 0, endMs: Number(f.endMs) || 0 })) : [];
      return send(res, json({ ok: true, partial: String(up.body.partial || '').slice(0, 4000), finals }));
    }
    if (action === 'finish') {
      audioStreamSessions.delete(id);
      let up;
      try { up = await audioStreamUpstream(s, 'POST', '/' + s.upstreamId + '/finish', '', 'application/octet-stream'); }
      catch (err) {
        logEvent({ kind: 'asr_stream', action: 'finish-failed', provider: s.providerId, error: String(err && err.message || err).slice(0, 200) });
        return send(res, apiFailure('asr.stream_unreachable', { providerId: s.providerId }, '连不上实时识别服务', 502));
      }
      if (up.status === 404) return send(res, apiFailure('asr.stream_session_missing', { id }, '实时识别会话已失效', 404));
      if (up.status !== 200 || !up.body || typeof up.body !== 'object') return send(res, audioStreamFailure(up));
      const finals = Array.isArray(up.body.finals) ? up.body.finals.filter(f => f && typeof f === 'object').map(f => ({ text: String(f.text || '').slice(0, 4000), startMs: Number(f.startMs) || 0, endMs: Number(f.endMs) || 0 })) : [];
      logEvent({ kind: 'asr_stream', action: 'finish', provider: s.providerId, finals: finals.length });
      return send(res, json({ ok: true, finals }));
    }
    return send(res, apiFailure('asr.stream_bad_request', {}, '没有这条路径', 404));
  }

  async function handleAudioTranscribe(req, res) {
    const config = await readConfig();
    if (typeof PrivacyGateway !== 'undefined') PrivacyGateway.assertMediaAllowed(config);
    const resolved = resolveAsrProvider(config);
    if (resolved.failure) {
      const f = resolved.failure;
      return send(res, apiFailure(f.code, f.params, f.message, f.status));
    }
    const { provider, asrModel } = resolved;
    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('audio/')) {
      return send(res, apiFailure('asr.content_type', { contentType }, 'Content-Type 必须是 audio/*', 400));
    }
    const q = new URL(req.url, 'http://x').searchParams;
    // filename 只许纯 basename(与 /api/upload/content 同域),缺省按 content-type 给个正经扩展名。
    const rawName = String(q.get('filename') || '').trim();
    const filename = (rawName && rawName.length <= 255 && rawName === path.basename(rawName) && rawName !== '.' && rawName !== '..')
      ? rawName : ('audio' + ({ 'audio/webm': '.webm', 'audio/wav': '.wav', 'audio/wave': '.wav', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/ogg': '.ogg', 'audio/flac': '.flac' }[contentType] || '.bin'));
    const language = String(q.get('language') || '').trim().slice(0, 40);
    // 调用方给了 prompt 就用它的;没给(麦克风按停顿切段那条路今天都不给)就用语音词库里的个人词(59 号文)。
    const hint = String(q.get('prompt') || '').slice(0, 4000) || await voiceLexiconAsrPromptFor(provider, '');
    let audio;
    try {
      audio = await readAudioBody(req);
    } catch (err) {
      if (err && err.statusCode === 413) {
        return send(res, apiFailure('asr.too_large', { maxBytes: ASR_MAX_BODY_BYTES }, '音频超过 25 MB 上限', 413));
      }
      throw err;
    }
    if (!audio.length) return send(res, apiFailure('asr.empty', {}, '空音频体', 400));
    const result = await transcribeAudioViaProvider(provider, asrModel, { audio, contentType, filename, language, prompt: hint });
    if (result.failure) {
      const f = result.failure;
      return send(res, apiFailure(f.code, f.params, f.message, f.status));
    }
    return send(res, json({
      ok: true, text: result.text,
      ...(result.outLanguage ? { language: result.outLanguage } : {}),
      durationMs: result.durationMs, providerId: result.providerId, model: result.model, estimated: result.estimated,
    }));
  }

  return handleAudioApiRoutes;
}

module.exports = { createAudioRoutes };
