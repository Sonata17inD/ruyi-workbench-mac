'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathWithinRoot } = require('./path-containment.cjs');
const { kimiAcpContentText, kimiAcpRequestError, kimiAcpAssertSession, awaitKimiAcpWithSignal } = require('./kimi-acp-rpc.cjs');
const { contextResetKimiAcpPlanApproval, kimiAcpPlanApprovalGrantsCurrentTurn } = require('./kimi-acp-session.cjs');

function kimiAcpSamePath(left, right) {
  const a = path.resolve(String(left || ''));
  const b = path.resolve(String(right || ''));
  return a === b;
}

function createKimiAcpInterventions({
  dataRoot, fileAllowedRoots, workspaceWriteRoots, guardFileToolPath, realpathForContainment,
  makeId, requestNativePermission, requestUserQuestion, permissionWaitMs, runAutomaticInterventionDecision,
  buildOpenSpawn, spawnDetachedChecked, process = globalThis.process,
}) {
  // hunt2-engines#13:结算【一条】如意侧待决(权限拒绝 / 提问取消 / 计划驳回),走与 04 clearPending* 同一个命令核心
  // (runAutomaticInterventionDecision → 同一份 CAS 与收尾顺序)。命令核心失败时不另做兜底:回合收尾那三句 clearPending*
  // 一定会把它清掉,最坏只是卡片多挂到回合结束,不会误清同会话里别的待决。
  function cancelKimiAcpIntervention(sessionId, interventionId, kind, note) {
    const message = String(note || 'Kimi cancelled the request').slice(0, 500);
    const payload = kind === 'permission' ? { action: 'deny', message }
      : kind === 'question' ? { action: 'answer', normalizedAnswer: { ok: false, answers: [], content: message } }
        : kind === 'plan' ? { action: 'reject', feedback: message } : null;
    if (!payload) return;
    runAutomaticInterventionDecision({
      missionId: sessionId, interventionId, source: `clear_${kind}`, decidedBy: 'clear',
      idempotencyKey: `clear:${interventionId}`, payload,
    }, () => { /* 回合收尾兜底,见上 */ });
  }

  function kimiAcpToolTier(toolCall) {
    const kind = String(toolCall && toolCall.kind || '').toLowerCase();
    if (kind === 'read' || kind === 'search' || kind === 'fetch') return 'read';
    if (kind === 'edit' || kind === 'delete' || kind === 'move') return 'edit';
    const name = String(toolCall && toolCall.title || '').replace(/^.+?__/, '').toLowerCase();
    if (/^(read|glob|grep|readmediafile|websearch|fetchurl|tasklist|taskoutput|todolist|getgoal)$/.test(name)) return 'read';
    if (/^(write|edit)$/.test(name)) return 'edit';
    return 'exec';
  }

  function kimiAcpNormalizedToolName(toolCall) {
    return String(toolCall && toolCall.title || '').trim().replace(/^.+?__/, '').toLowerCase();
  }

  function kimiAcpObjectInput(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  // rawInput is authoritative when it is concrete; args is the older ACP spelling, and input is
  // retained as a final compatibility spelling. Empty objects are missing concrete input, so a later
  // content recovery may still fill them without overriding a real explicit payload.
  function kimiAcpExplicitToolInput(toolCall) {
    let empty = null;
    for (const key of ['rawInput', 'args', 'input']) {
      const value = kimiAcpObjectInput(toolCall && toolCall[key]);
      if (!value) continue;
      if (Object.keys(value).length) return value;
      if (!empty) empty = value;
    }
    return empty || {};
  }

  // ACP's reverse permission request is a second gate after the host-side fs/terminal guard. Kimi marks
  // real file mutations with kind=edit, but title alone is not a safe capability signal: an arbitrary
  // MCP/tool title containing "write" must remain interactive. Keep the acceptEdits auto-path narrow to
  // the two native file tools and a concrete path-shaped rawInput.
  async function kimiAcpConcreteEditGuard(toolCall, context) {
    if (String(toolCall && toolCall.kind || '').trim().toLowerCase() !== 'edit') return { ok: false, reason: 'ACP permission kind is not edit' };
    // The permission request title comes from req.toolName. Do not recover a permissive name from a
    // prefixed/description-like string: MCP tools and arbitrary descriptions containing "write" stay manual.
    const exactName = String(toolCall && toolCall.title || '').trim().toLowerCase();
    if (exactName !== 'write' && exactName !== 'edit') return { ok: false, reason: 'ACP permission title is not the native Write/Edit tool' };
    const input = toolCall && toolCall.rawInput && typeof toolCall.rawInput === 'object' && !Array.isArray(toolCall.rawInput)
      ? toolCall.rawInput : null;
    if (!input) return { ok: false, reason: 'ACP permission rawInput is missing' };
    const filePath = input.path || input.file_path || input.filePath;
    if (typeof filePath !== 'string' || !filePath.trim()) return { ok: false, reason: 'ACP permission rawInput has no file path' };
    if (Object.prototype.hasOwnProperty.call(input, 'command') || Object.prototype.hasOwnProperty.call(input, 'cmd')) return { ok: false, reason: 'ACP permission rawInput contains a command' };
    const base = context && context.session && (context.session.cwd || context.session.claudeSessionCwd)
      || context && context.workingDir
      || context && context.config && context.config.defaultWorkspace
      || process.cwd();
    const resolved = path.isAbsolute(filePath.trim()) ? path.resolve(filePath.trim()) : path.resolve(base, filePath.trim());
    const guard = await guardFileToolPath(resolved, { session: context.session, config: context.config }, { tool: 'kimi_acp_accept_edits', write: true });
    if (!guard || !guard.ok) return { ok: false, reason: String(guard && guard.error || 'normal write guard denied the path') };
    return { ok: true, absPath: guard.absPath };
  }

  function kimiAcpContentJsonTexts(value, out = [], depth = 0) {
    if (depth > 12 || value == null) return out;
    if (typeof value === 'string') { out.push(value); return out; }
    if (Array.isArray(value)) {
      for (const item of value) kimiAcpContentJsonTexts(item, out, depth + 1);
      return out;
    }
    if (typeof value !== 'object') return out;
    if (typeof value.text === 'string') out.push(value.text);
    for (const key of ['content', 'children', 'items']) {
      if (Object.prototype.hasOwnProperty.call(value, key)) kimiAcpContentJsonTexts(value[key], out, depth + 1);
    }
    return out;
  }

  function kimiAcpInferConcreteToolInput(toolCall) {
    const title = String(toolCall && (toolCall.nativeName || toolCall.title || toolCall.name) || '').trim().toLowerCase();
    const kind = String(toolCall && toolCall.kind || '').trim().toLowerCase();
    const isEdit = (title === 'write' || title === 'edit') && kind === 'edit';
    const isBash = title === 'bash' && kind === 'execute';
    if (!isEdit && !isBash) return null;
    const parsed = [];
    let invalidObjectJson = false;
    for (const text of kimiAcpContentJsonTexts(toolCall && toolCall.content)) {
      const source = String(text || '').trim();
      if (!source.startsWith('{') || !source.endsWith('}')) continue;
      let value;
      try { value = JSON.parse(source); } catch { invalidObjectJson = true; continue; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      if (isEdit) {
        const pathKeys = ['path', 'file_path', 'filePath'];
        const paths = pathKeys.filter(key => Object.prototype.hasOwnProperty.call(value, key));
        if (paths.length !== 1 || typeof value[paths[0]] !== 'string' || !value[paths[0]].trim()
          || pathKeys.some(key => key !== paths[0] && Object.prototype.hasOwnProperty.call(value, key))
          || Object.prototype.hasOwnProperty.call(value, 'command') || Object.prototype.hasOwnProperty.call(value, 'cmd')) continue;
        parsed.push(value);
      } else {
        const commandKeys = ['command', 'cmd'];
        const commands = commandKeys.filter(key => Object.prototype.hasOwnProperty.call(value, key));
        if (commands.length !== 1 || typeof value[commands[0]] !== 'string' || !value[commands[0]].trim()
          || commandKeys.some(key => key !== commands[0] && Object.prototype.hasOwnProperty.call(value, key))
          || Object.prototype.hasOwnProperty.call(value, 'path')
          || Object.prototype.hasOwnProperty.call(value, 'file_path') || Object.prototype.hasOwnProperty.call(value, 'filePath')) continue;
        parsed.push(value);
      }
    }
    if (invalidObjectJson) return null;
    const unique = new Map(parsed.map(value => [JSON.stringify(value), value]));
    return unique.size === 1 ? [...unique.values()][0] : null;
  }

  function kimiAcpPermissionToolCall(params, context) {
    const raw = params && params.toolCall && typeof params.toolCall === 'object' ? params.toolCall : {};
    const id = String(raw.toolCallId || params && params.toolCallId || '');
    const state = context && context.state;
    const prior = id && state && state.toolMap && typeof state.toolMap.get === 'function'
      ? state.toolMap.get(id) : null;
    const activePrior = prior && !prior.__settled ? prior : null;
    const priorInput = activePrior ? kimiAcpObjectInput(activePrior.input) : null;
    const rawInput = kimiAcpExplicitToolInput(raw);
    const inferred = activePrior && (!priorInput || !Object.keys(priorInput).length) && !Object.keys(rawInput).length
      ? kimiAcpInferConcreteToolInput({ nativeName: activePrior.nativeName, kind: activePrior.kind, content: activePrior.content })
      : null;
    if (activePrior && inferred) activePrior.input = inferred;
    const stableName = activePrior && activePrior.nativeName ? String(activePrior.nativeName) : '';
    const mergedInput = Object.keys(rawInput).length
      ? rawInput
      : (inferred || (priorInput && Object.keys(priorInput).length ? priorInput : {}));
    // ACP 0.37 sends kind/rawInput on tool_call, then permission only carries toolCallId/title/content.
    // Merge only the same id; never borrow the latest/another tool's input.
    return {
      ...(activePrior && typeof activePrior === 'object' ? {
        ...(stableName ? { title: stableName, name: stableName } : {}),
        kind: activePrior.kind, rawInput: mergedInput, content: activePrior.content,
      } : {}),
      ...raw,
      ...(stableName ? { title: stableName, name: stableName } : {}),
      ...(raw.kind == null && activePrior ? { kind: activePrior.kind } : {}),
      ...(Object.keys(rawInput).length ? { rawInput: rawInput } : { rawInput: mergedInput }),
      ...(raw.content == null && activePrior ? { content: activePrior.content } : {}),
      ...(id ? { toolCallId: id } : {}),
    };
  }

  function kimiAcpQuestionKind(params) {
    const options = Array.isArray(params && params.options) ? params.options : [];
    const ids = options.map(option => String(option && option.optionId || ''));
    const title = String(params && params.toolCall && params.toolCall.title || '');
    if (title === 'AskUserQuestion' || ids.some(id => /^q\d+_(?:opt_\d+|skip)$/.test(id))) return 'question';
    if (ids.some(id => /^plan_(?:opt_\d+|approve|revise|reject_and_exit)$/.test(id))) return 'plan';
    return 'permission';
  }

  async function handleKimiAcpPermissionRequest(params, context) {
    const options = (Array.isArray(params && params.options) ? params.options : []).filter(Boolean);
    const toolCall = kimiAcpPermissionToolCall(params, context);
    const kind = kimiAcpQuestionKind(params);
    context.reg.pausePending = true;
    context.reg.lastEventAt = Date.now();
    try {
      if (kind === 'question' || kind === 'plan') {
        const text = kimiAcpContentText(toolCall.content).trim()
          || (kind === 'plan' ? '请选择如何处理 Kimi 的计划。' : 'Kimi 需要你的选择。');
        const answer = await requestUserQuestion(
          context.session.id,
          String(toolCall.toolCallId || makeId('kimi_question')),
          [{
            id: kind === 'plan' ? 'kimi_plan' : 'kimi_question',
            header: kind === 'plan' ? 'Kimi 计划确认' : 'Kimi 提问',
            question: text,
            answerMode: 'single',
            allowOther: false,
            options: options.map(option => ({
              id: String(option.optionId || ''),
              label: String(option.name || option.optionId || ''),
              description: String(option.description || ''),
            })).filter(option => option.id && option.label),
          }],
          context.onEvent,
          context.config.questionTimeoutMs,
          context.state.assistantText,
        );
        const selected = answer && answer.ok !== false && answer.answers && answer.answers[0]
          && answer.answers[0].selectedOptionIds && answer.answers[0].selectedOptionIds[0];
        if (!selected) return { outcome: { outcome: 'cancelled' } };
        if (kind === 'plan') {
          const selectedOption = options.find(option => String(option.optionId || '') === String(selected));
          if (!selectedOption) return { outcome: { outcome: 'cancelled' } };
          const title = String(toolCall.title || '').trim().toLowerCase();
          if (title === 'enterplanmode' && String(selectedOption.kind || '').startsWith('allow')) {
            contextResetKimiAcpPlanApproval(context.reg);
            context.reg.kimiAcpNativeMode = 'plan';
            context.reg.kimiAcpPlanFile = '';
          } else if (title !== 'enterplanmode' && kimiAcpPlanApprovalGrantsCurrentTurn(selected)) {
            // This is deliberately turn-local. Do not persist it in config.permissionMode or infer it from
            // current_mode_update/config_option_update; the next user turn must re-enter plan mode when its
            // Ruyi config still says plan.
            context.reg.kimiAcpPlanApproved = true;
            context.reg.kimiAcpPlanApprovalTurn = Number(context.session.turnSeq) || 0;
          }
          context.onEvent({ type: 'kimi_plan_decision', planId: String(toolCall.toolCallId || ''), optionId: String(selected) });
        }
        return { outcome: { outcome: 'selected', optionId: String(selected) } };
      }
      const title = String(toolCall.title || 'KimiTool');
      const input = kimiAcpPermissionInput(toolCall, context);
      const tier = kimiAcpToolTier(toolCall);
      // The fs guard uses canonical paths too, including macOS /var -> /private/var aliases.
      if (tier === 'edit' && input.path) input.path = await realpathForContainment(input.path);
      const nativeBash = kimiAcpNativeBashApprovalDescriptor(toolCall, input, context);
      const acceptEditsCandidate = String(context.config && context.config.permissionMode || '') === 'acceptEdits'
        ? await kimiAcpConcreteEditGuard(toolCall, context)
        : null;
      let acceptEditsAuto = Boolean(acceptEditsCandidate && acceptEditsCandidate.ok === true);
      const autoEditRequested = acceptEditsAuto;
      // Native ACP still expects a permission outcome even though Ruyi's acceptEdits policy has already
      // authorized this exact Write/Edit operation. Return allow_once only; never manufacture a session
      // grant, and leave question/plan/exec/unknown requests on the normal interactive path.
      let decision = acceptEditsAuto
        ? { behavior: 'allow', scope: 'once', kimiAutoEdit: true }
        : await requestNativePermission(
          context.session.id, title, input, context.onEvent, permissionWaitMs(context.session.id, context.config, context.session), tier   // 128f-⑪
        );
      // A native agent that omits allow_once cannot be safely auto-approved: selecting allow_always would
      // widen the scope beyond Ruyi's acceptEdits policy. Fall back to the ordinary UI permission request.
      const autoEditFallback = autoEditRequested
        && !options.some(option => String(option && option.kind || '') === 'allow_once');
      if (autoEditFallback) {
        acceptEditsAuto = false;
        decision = await requestNativePermission(
          context.session.id, title, input, context.onEvent, permissionWaitMs(context.session.id, context.config, context.session), tier   // 128f-⑪
        );
      }
      if (!decision || decision.behavior !== 'allow') {
        const reject = options.find(option => String(option.kind || '').startsWith('reject'))
          || options.find(option => String(option.optionId || '') === 'reject');
        return reject
          ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
          : { outcome: { outcome: 'cancelled' } };
      }
      const explicitSession = !autoEditRequested && decision.scope === 'session'
        || autoEditFallback && decision.scope === 'session';
      const wantedKind = autoEditRequested ? 'allow_once' : (explicitSession ? 'allow_always' : 'allow_once');
      // Exact scope matching is fail-closed for a once decision: never turn a user's one-shot approval into
      // an ACP allow_always merely because that is the only advertised option. A requested session scope may
      // conservatively degrade to allow_once when the agent has no session option.
      const allow = options.find(option => String(option && option.kind || '') === wantedKind)
        || (explicitSession ? options.find(option => String(option && option.kind || '') === 'allow_once') : null);
      if (!allow) return { outcome: { outcome: 'cancelled' } };
      if (!acceptEditsAuto) {
        if (!Array.isArray(context.reg.kimiAcpApprovals)) context.reg.kimiAcpApprovals = [];
        context.reg.kimiAcpApprovals.push({
          title: title.toLowerCase(), tier: kimiAcpToolTier(toolCall), input,
          toolCallId: String(toolCall.toolCallId || ''),
          nativeBash: nativeBash || null,
          scope: String(allow && allow.kind || '') === 'allow_always' && decision.scope === 'session' ? 'session' : 'once', at: Date.now(),
        });
        if (context.reg.kimiAcpApprovals.length > 32) context.reg.kimiAcpApprovals.splice(0, context.reg.kimiAcpApprovals.length - 32);
      }
      return { outcome: { outcome: 'selected', optionId: allow.optionId } };
    } finally {
      context.reg.pausePending = false;
      context.reg.lastEventAt = Date.now();
    }
  }

  function kimiAcpApprovalValue(input, kind) {
    if (!input || typeof input !== 'object') return '';
    if (kind === 'terminal') return String(input.command || input.cmd || '').trim();
    return String(input.path || input.file_path || input.filePath || '').trim();
  }

  function consumeKimiAcpApproval(context, kind, input) {
    const approvals = context && context.reg && Array.isArray(context.reg.kimiAcpApprovals) ? context.reg.kimiAcpApprovals : [];
    const expectedTier = kind === 'write' ? 'edit' : 'exec';
    let wanted = kimiAcpApprovalValue(input, kind);
    if (kind === 'write' && wanted) {
      const base = context.session && (context.session.cwd || context.session.claudeSessionCwd)
        || context.workingDir || context.config && context.config.defaultWorkspace || process.cwd();
      wanted = path.resolve(path.isAbsolute(wanted) ? wanted : path.resolve(base, wanted));
    }
    const titlePattern = kind === 'terminal' ? /bash|shell|terminal/ : /write|edit|file/;
    const nativeWrapper = input && input.__kimiAcpNativeBashWrapper;
    const sessionMatches = [];
    const onceMatches = [];
    const toolMap = context && context.state && context.state.toolMap;
    for (let index = approvals.length - 1; index >= 0; index--) {
      const row = approvals[index];
      if (!row || Date.now() - Number(row.at || 0) > 10 * 60 * 1000) {
        if (row) approvals.splice(index, 1);
        continue;
      }
      if (String(row.tier || '') !== expectedTier || !titlePattern.test(String(row.title || ''))) continue;
      const isSession = row.scope === 'session';
      if (!isSession) {
        const toolCallId = String(row.toolCallId || '');
        const nativeTool = toolCallId && toolMap && typeof toolMap.get === 'function' ? toolMap.get(toolCallId) : null;
        // A one-shot decision is owned by its live native tool call. Missing/settled owners are stale,
        // never a wildcard for a later tool with the same path or command.
        if (!toolCallId || !nativeTool || nativeTool.__settled) {
          approvals.splice(index, 1);
          continue;
        }
      }
      let granted = kimiAcpApprovalValue(row.input, kind);
      if (kind === 'write' && granted) {
        const base = context.session && (context.session.cwd || context.session.claudeSessionCwd)
          || context.workingDir || context.config && context.config.defaultWorkspace || process.cwd();
        granted = path.resolve(path.isAbsolute(granted) ? granted : path.resolve(base, granted));
      }
      let sameValue = Boolean(granted && wanted && granted === wanted);
      if (kind === 'write' && granted && wanted) {
        sameValue = granted === wanted;
      }
      if (kind === 'terminal') {
        if (nativeWrapper) {
          if (!kimiAcpNativeBashWrapperMatches(row, nativeWrapper)) continue;
          sameValue = true;
        } else if (row.nativeBash) {
          continue;
        }
      }
      // Both scopes require a concrete exact value. Session remains reusable only because the user
      // explicitly selected session scope; it still cannot cross tier or become a wildcard.
      if (!wanted || !granted || !sameValue) continue;
      if (isSession) sessionMatches.push(row);
      else onceMatches.push({ index, row });
    }
    if (sessionMatches.length) return true;
    // Two live one-shot approvals for the same value are ambiguous: do not guess the latest owner.
    if (onceMatches.length !== 1) return false;
    approvals.splice(onceMatches[0].index, 1);
    return true;
  }

  function kimiAcpToolUpdateHasError(value, depth = 0) {
    if (depth > 8 || value == null || typeof value !== 'object') return false;
    if (value.isError === true) return true;
    if (value.error != null && value.error !== '' && value.error !== false) return true;
    if (typeof value.status === 'string' && /^(?:error|failed)$/i.test(value.status.trim())) return true;
    for (const child of Object.values(value)) if (kimiAcpToolUpdateHasError(child, depth + 1)) return true;
    return false;
  }

  function kimiAcpToolUpdateSucceeded(update) {
    return String(update && update.status || '') === 'completed' && !kimiAcpToolUpdateHasError(update);
  }

  function kimiAcpSuccessfulEnterPlanMode(toolCall, update) {
    return String(toolCall && toolCall.nativeName || '').trim().toLowerCase() === 'enterplanmode'
      && kimiAcpToolUpdateSucceeded(update);
  }

  function kimiAcpEffectiveCwd(rawCwd, context) {
    const base = context && context.session && (context.session.cwd || context.session.claudeSessionCwd)
      || context && context.workingDir
      || context && context.config && context.config.defaultWorkspace
      || process.cwd();
    let value = String(rawCwd || '').trim() || String(base || '').trim();
    if (!value) return '';
    if (!path.isAbsolute(value)) value = path.resolve(base, value);
    return path.isAbsolute(value) ? path.resolve(value) : '';
  }

  function kimiAcpNativeShellQuote(value) {
    return "'" + String(value).replaceAll("'", "'\\''") + "'";
  }

  function kimiAcpNativeBashWrapperCwdTexts(cwd) { return [String(cwd)]; }

  function kimiAcpNativeBashWrapperTexts(command, cwd) {
    return kimiAcpNativeBashWrapperCwdTexts(cwd).map(cwdText =>
      'cd ' + kimiAcpNativeShellQuote(cwdText) + ' && ' + String(command));
  }

  function kimiAcpCanonicalExecutable(rawPath) {
    try {
      const absolute = path.resolve(String(rawPath));
      const real = fs.realpathSync(absolute);
      return fs.statSync(real).isFile() ? real : '';
    } catch { return ''; }
  }

  function kimiAcpNativeBashRootPairs(context) {
    const rawRoots = [];
    const add = value => { if (typeof value === 'string' && value.trim()) rawRoots.push(value.trim()); };
    const addMany = values => { for (const value of (Array.isArray(values) ? values : [])) add(value); };
    const session = context && context.session;
    const config = context && context.config;
    add(session && session.cwd);
    add(session && session.claudeSessionCwd);
    add(context && context.workingDir);
    add(config && config.defaultWorkspace);
    add(context && context.dataRoot);
    add(context && context.paths && context.paths.data);
    addMany(context && context.additionalDirectories);
    addMany(context && context.additionalDirs);
    addMany(config && config.additionalDirectories);
    addMany(context && context.allowedRoots);
    addMany(context && context.writeRoots);
    if (typeof fileAllowedRoots === 'function') {
      try { addMany(fileAllowedRoots(session, config)); } catch { /* fail closed through explicit roots */ }
    }
    if (typeof workspaceWriteRoots === 'function') {
      try { addMany(workspaceWriteRoots(session, config)); } catch { /* fail closed through explicit roots */ }
    }
    if (typeof dataRoot === 'function') {
      try { add(dataRoot()); } catch { /* fail closed through explicit roots */ }
    }
    const seen = new Set();
    const pairs = [];
    for (const raw of rawRoots) {
      let lexical;
      try { lexical = path.resolve(raw); } catch { continue; }
      let canonical = lexical;
      try { canonical = fs.realpathSync(lexical); } catch { /* root may not exist yet */ }
      const key = lexical + '\0' + canonical;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ lexical, canonical });
    }
    return pairs;
  }

  function kimiAcpNativeBashPathExcluded(rawPath, canonical, context) {
    const candidates = [];
    for (const value of [rawPath, canonical]) {
      if (!value) continue;
      try { candidates.push(path.resolve(String(value))); } catch { return true; }
    }
    if (!candidates.length) return true;
    try {
      return kimiAcpNativeBashRootPairs(context).some(root =>
        candidates.some(candidate => pathWithinRoot(candidate, root.lexical) || pathWithinRoot(candidate, root.canonical))
      );
    } catch { return true; }
  }

  function kimiAcpTrustedNativeBashPath(canonical, context, rawPath) {
    if (!canonical) return false;
    if (kimiAcpNativeBashPathExcluded(rawPath, canonical, context)) return false;
    const name = path.basename(canonical).toLowerCase();
    if (name !== 'bash') return false;
    const standard = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'];
    const configured = String(process.env.KIMI_SHELL_PATH || '').trim();
    const configuredCanonical = configured && kimiAcpCanonicalExecutable(configured);
    return standard.some(candidate => kimiAcpSamePath(candidate, canonical))
      || Boolean(configuredCanonical && kimiAcpSamePath(configuredCanonical, canonical));
  }

  function kimiAcpTrustedNativeBashExecutable(command, context) {
    const raw = String(command || '').trim();
    if (!raw) return '';
    const absolute = path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw);
    if (!absolute) return '';
    const canonical = kimiAcpCanonicalExecutable(raw);
    return kimiAcpTrustedNativeBashPath(canonical, context, raw) ? canonical : '';
  }

  function kimiAcpNativeBashEnvSafe(rawEnv, canonicalExecutable) {
    if (rawEnv === undefined) return true;
    if (!Array.isArray(rawEnv)) return false;
    const safeNames = new Set(['NO_COLOR', 'TERM', 'GIT_TERMINAL_PROMPT', 'SHELL']);
    const seen = new Set();
    for (const item of rawEnv) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const name = String(item.name || '');
      const value = String(item.value || '');
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value.length > 32768 || value.includes('\0')) return false;
      const upper = name.toUpperCase();
      if (seen.has(upper) || !safeNames.has(upper)) return false;
      seen.add(upper);
      if (upper === 'SHELL') {
        const shell = kimiAcpCanonicalExecutable(value);
        if (!shell || !canonicalExecutable || !kimiAcpSamePath(shell, canonicalExecutable)) return false;
      }
    }
    return true;
  }

  function kimiAcpNativeBashApprovalDescriptor(toolCall, input, context) {
    if (String(toolCall && toolCall.title || '').trim().toLowerCase() !== 'bash'
      || String(toolCall && toolCall.kind || '').trim().toLowerCase() !== 'execute') return null;
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const keys = ['command', 'cmd'].filter(key => Object.prototype.hasOwnProperty.call(source, key));
    if (keys.length !== 1 || typeof source[keys[0]] !== 'string' || !source[keys[0]].trim()) return null;
    const cwd = kimiAcpEffectiveCwd(source.cwd, context);
    return cwd ? { command: source[keys[0]], cwd } : null;
  }

  function kimiAcpNativeBashWrapperCandidate(value, context) {
    const command = String(value && value.command || '');
    const args = value && Array.isArray(value.args) ? value.args : null;
    if (!command || !args || args.length !== 2 || args[0] !== '-c' || typeof args[1] !== 'string'
      || !args[1].trim() || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) return null;
    const executable = kimiAcpTrustedNativeBashExecutable(command, context);
    const cwd = kimiAcpEffectiveCwd(value && value.cwd, context);
    if (!executable || !cwd || !kimiAcpNativeBashEnvSafe(value && value.env, executable)) return null;
    return { executable: command, canonicalExecutable: executable, argv: args.slice(), cwd };
  }

  function kimiAcpNativeBashWrapperMatches(row, candidate) {
    const approved = row && row.nativeBash;
    if (!approved || !candidate || typeof approved.command !== 'string' || !approved.command.trim()
      || !approved.cwd || !kimiAcpSamePath(approved.cwd, candidate.cwd)) return false;
    if (candidate.argv.length !== 2 || candidate.argv[0] !== '-c') return false;
    return kimiAcpNativeBashWrapperTexts(approved.command, approved.cwd).includes(candidate.argv[1]);
  }

  function kimiAcpPermissionInput(toolCall, context) {
    const source = kimiAcpExplicitToolInput(toolCall);
    const input = { ...source };
    const name = String(toolCall && toolCall.title || '').trim().toLowerCase();
    if (name === 'write' || name === 'edit' || String(toolCall && toolCall.kind || '').trim().toLowerCase() === 'edit') {
      const key = ['path', 'file_path', 'filePath'].find(candidate => typeof input[candidate] === 'string' && input[candidate].trim());
      if (key) {
        const base = context && context.session && (context.session.cwd || context.session.claudeSessionCwd)
          || context && context.workingDir
          || context && context.config && context.config.defaultWorkspace
          || process.cwd();
        input.path = path.resolve(path.isAbsolute(input[key].trim()) ? input[key].trim() : path.resolve(base, input[key].trim()));
      }
    }
    return input;
  }

  async function ensureKimiAcpOperationPermission(context, kind, input) {
    const mode = String(context.config && context.config.permissionMode || 'default');
    if (mode === 'bypass' || mode === 'auto' || (mode === 'acceptEdits' && kind === 'write')) return;
    if (mode === 'plan') {
      const approvedThisTurn = context.reg && context.reg.kimiAcpPlanApproved === true
        && Number(context.reg.kimiAcpPlanApprovalTurn) === (Number(context.session && context.session.turnSeq) || 0);
      if (!approvedThisTurn) throw kimiAcpRequestError(-32000, `Kimi ${kind === 'terminal' ? 'terminal execution' : 'file write'} is disabled in plan mode; approve ExitPlanMode in this turn first`);
      // Approval only lifts the host plan block for this turn. Continue through the ordinary manual gate;
      // it must not silently become bypass/auto execution authorization.
    }
    if (consumeKimiAcpApproval(context, kind === 'write' ? 'write' : 'terminal', input)) return;
    const visibleInput = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : input;
    if (visibleInput && typeof visibleInput === 'object') delete visibleInput.__kimiAcpNativeBashWrapper;
    const decision = await requestNativePermission(
      context.session.id, kind === 'terminal' ? 'Bash' : 'Write', visibleInput,
      context.onEvent, permissionWaitMs(context.session.id, context.config, context.session), kind === 'terminal' ? 'exec' : 'edit'   // 128f-⑪
    );
    if (!decision || decision.behavior !== 'allow') throw kimiAcpRequestError(-32000, 'Operation denied by user');
    if (decision.scope === 'session') {
      if (!Array.isArray(context.reg.kimiAcpApprovals)) context.reg.kimiAcpApprovals = [];
      context.reg.kimiAcpApprovals.push({
        title: kind === 'terminal' ? 'bash' : 'write', tier: kind === 'terminal' ? 'exec' : 'edit',
        input: visibleInput, scope: 'session', at: Date.now(), toolCallId: '', nativeBash: null,
      });
    }
  }

  function kimiAcpElicitationOptions(schema) {
    if (!schema || typeof schema !== 'object') return [];
    if (Array.isArray(schema.oneOf)) return schema.oneOf.map(row => ({ value: String(row && row.const || ''), label: String(row && row.title || row && row.const || ''), description: String(row && row.description || '') }));
    if (Array.isArray(schema.enum)) return schema.enum.map(value => ({ value: String(value), label: String(value), description: '' }));
    const items = schema.items && typeof schema.items === 'object' ? schema.items : {};
    if (Array.isArray(items.anyOf)) return items.anyOf.map(row => ({ value: String(row && row.const || ''), label: String(row && row.title || row && row.const || ''), description: String(row && row.description || '') }));
    if (Array.isArray(items.enum)) return items.enum.map(value => ({ value: String(value), label: String(value), description: '' }));
    return [];
  }

  function kimiAcpElicitationQuestion(key, schema, required, message, fieldIndex) {
    const type = String(schema && schema.type || 'string');
    const title = String(schema && schema.title || key);
    const description = [String(schema && schema.description || ''), schema && schema.default != null ? `默认值：${JSON.stringify(schema.default)}` : ''].filter(Boolean).join('\n');
    const row = { key, type, schema, required, values: new Map(), skipId: `kimi_skip_${key}` };
    let choices = kimiAcpElicitationOptions(schema);
    if (type === 'boolean') choices = [{ value: true, label: '是', description: '' }, { value: false, label: '否', description: '' }];
    const options = choices.slice(0, 11).map((choice, index) => {
      const id = `kimi_${key}_${index}`.slice(0, 80);
      row.values.set(id, choice.value);
      return { id, label: choice.label, description: choice.description };
    });
    if (!required) options.push({ id: row.skipId.slice(0, 80), label: '跳过此项', description: '不提交这个可选字段' });
    const hasChoices = options.length > (required ? 0 : 1);
    row.ui = {
      id: `kimi_field_${fieldIndex}`.slice(0, 80), header: title.slice(0, 80),
      question: [message, title, description].filter(Boolean).join('\n').slice(0, 1000),
      answerMode: type === 'array' ? 'multiple' : (hasChoices || !required ? 'single' : 'text'),
      allowOther: !hasChoices && !required, options,
    };
    return row;
  }

  function kimiAcpElicitationValue(row, answer) {
    if (!answer || typeof answer !== 'object') {
      if (!row.required) return { present: false };
      throw kimiAcpRequestError(-32602, `${row.key} is required`);
    }
    const selected = Array.isArray(answer && answer.selectedOptionIds) ? answer.selectedOptionIds : [];
    if (selected.includes(row.skipId.slice(0, 80))) return { present: false };
    let value;
    if (row.type === 'array') value = selected.filter(id => row.values.has(id)).map(id => row.values.get(id));
    else if (selected.length && row.values.has(selected[0])) value = row.values.get(selected[0]);
    else value = String(answer && answer.otherText || (answer && answer.answer && answer.answer[0]) || '');
    if (row.type !== 'array' && row.values.size && !selected.some(id => row.values.has(id))) {
      throw kimiAcpRequestError(-32602, `${row.key} must use one of the offered values`);
    }
    const schema = row.schema || {};
    if (row.type === 'number' || row.type === 'integer') {
      const number = Number(value);
      if (!Number.isFinite(number) || (row.type === 'integer' && !Number.isInteger(number))) throw kimiAcpRequestError(-32602, `${row.key} must be a valid ${row.type}`);
      if (schema.minimum != null && number < Number(schema.minimum)) throw kimiAcpRequestError(-32602, `${row.key} is below its minimum`);
      if (schema.maximum != null && number > Number(schema.maximum)) throw kimiAcpRequestError(-32602, `${row.key} exceeds its maximum`);
      value = number;
    } else if (row.type === 'string') {
      value = String(value);
      if (schema.minLength != null && value.length < Number(schema.minLength)) throw kimiAcpRequestError(-32602, `${row.key} is shorter than minLength`);
      if (schema.maxLength != null && value.length > Number(schema.maxLength)) throw kimiAcpRequestError(-32602, `${row.key} exceeds maxLength`);
      if (schema.pattern) { let pattern; try { pattern = new RegExp(String(schema.pattern)); } catch { pattern = null; } if (pattern && !pattern.test(value)) throw kimiAcpRequestError(-32602, `${row.key} does not match the requested pattern`); }
      if (schema.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw kimiAcpRequestError(-32602, `${row.key} must be an email address`);
      if (schema.format === 'uri') { try { new URL(value); } catch { throw kimiAcpRequestError(-32602, `${row.key} must be a URI`); } }
      if (schema.format === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))) throw kimiAcpRequestError(-32602, `${row.key} must be a date`);
      if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) throw kimiAcpRequestError(-32602, `${row.key} must be a date-time`);
    } else if (row.type === 'boolean') {
      if (value !== true && value !== false) throw kimiAcpRequestError(-32602, `${row.key} must be a boolean`);
    } else if (row.type === 'array') {
      if (schema.minItems != null && value.length < Number(schema.minItems)) throw kimiAcpRequestError(-32602, `${row.key} has too few selections`);
      if (schema.maxItems != null && value.length > Number(schema.maxItems)) throw kimiAcpRequestError(-32602, `${row.key} has too many selections`);
    }
    return { present: true, value };
  }

  async function handleKimiAcpElicitation(params, context, requestMeta) {
    const mode = String(params && params.mode || 'form');
    const message = String(params && params.message || 'Kimi 需要你的输入。');
    if (params && params.sessionId != null) kimiAcpAssertSession(params, context);
    else if (!params || params.requestId == null) throw kimiAcpRequestError(-32602, 'Elicitation requires sessionId or requestId scope');
    context.reg.pausePending = true;
    context.reg.lastEventAt = Date.now();
    try {
      if (mode === 'url') {
        let url;
        try { url = new URL(String(params.url || '')); } catch { throw kimiAcpRequestError(-32602, 'Invalid elicitation URL'); }
        if (!/^https?:$/.test(url.protocol)) throw kimiAcpRequestError(-32602, 'Only HTTP(S) elicitation URLs are supported');
        const answer = await awaitKimiAcpWithSignal(requestUserQuestion(
          context.session.id, String(params.elicitationId || makeId('kimi_elicitation')),
          [{ id: 'kimi_url_elicitation', header: 'Kimi 外部授权', question: `${message}\n\n完整地址：${url.href}`, answerMode: 'single', allowOther: false,
            options: [{ id: 'open', label: '同意并打开', description: `将在系统浏览器打开 ${url.hostname}` }, { id: 'decline', label: '拒绝', description: '不打开此地址' }] }],
          context.onEvent, context.config.questionTimeoutMs, context.state.assistantText
        ), requestMeta && requestMeta.signal);
        const selected = answer && answer.ok !== false && answer.answers && answer.answers[0] && answer.answers[0].selectedOptionIds && answer.answers[0].selectedOptionIds[0];
        if (selected !== 'open') return { action: selected === 'decline' ? 'decline' : 'cancel' };
        try {
          // 异步启动失败(ENOENT/EPERM)也要落进下面的 catch 回 -32000,而不是成为 uncaughtException 带崩服务。
          const open = buildOpenSpawn(url.href);
          const started = await spawnDetachedChecked(open.command, open.args, { detached: true, stdio: 'ignore' });
          if (!started.ok) throw new Error(started.error);
        }
        catch (error) { throw kimiAcpRequestError(-32000, `Unable to open elicitation URL: ${error && error.message || error}`); }
        context.reg.kimiAcpElicitations.set(String(params.elicitationId || ''), { url: url.href, at: Date.now() });
        return { action: 'accept' };
      }
      if (mode !== 'form') throw kimiAcpRequestError(-32602, `Unsupported elicitation mode: ${mode}`);
      const requested = params && params.requestedSchema && typeof params.requestedSchema === 'object' ? params.requestedSchema : {};
      const required = new Set(Array.isArray(requested.required) ? requested.required.map(String) : []);
      const properties = Object.entries(requested.properties && typeof requested.properties === 'object' ? requested.properties : {});
      if (properties.length > 60) throw kimiAcpRequestError(-32602, 'Elicitation form exceeds the 60-field Ruyi limit');
      const rows = properties.map(([key, schema], index) => kimiAcpElicitationQuestion(key, schema || {}, required.has(key), message, index));
      const content = Object.create(null);
      for (let start = 0; start < rows.length; start += 3) {
        const batch = rows.slice(start, start + 3);
        const answer = await awaitKimiAcpWithSignal(requestUserQuestion(
          context.session.id, String(params.toolCallId || makeId('kimi_elicitation')), batch.map(row => row.ui),
          context.onEvent, context.config.questionTimeoutMs, context.state.assistantText
        ), requestMeta && requestMeta.signal);
        if (!answer || answer.ok === false) return { action: 'cancel' };
        for (const row of batch) {
          const result = kimiAcpElicitationValue(row, (answer.answers || []).find(item => item && item.questionId === row.ui.id));
          if (result.present) content[row.key] = result.value;
        }
      }
      return { action: 'accept', content };
    } finally {
      context.reg.pausePending = false;
      context.reg.lastEventAt = Date.now();
    }
  }

  return {
    cancelKimiAcpIntervention, kimiAcpExplicitToolInput, kimiAcpInferConcreteToolInput, kimiAcpPermissionToolCall,
    handleKimiAcpPermissionRequest, consumeKimiAcpApproval, kimiAcpSuccessfulEnterPlanMode,
    kimiAcpNativeShellQuote, kimiAcpNativeBashWrapperTexts, kimiAcpNativeBashWrapperCandidate,
    ensureKimiAcpOperationPermission, handleKimiAcpElicitation,
  };
}

module.exports = { createKimiAcpInterventions, kimiAcpSamePath };
