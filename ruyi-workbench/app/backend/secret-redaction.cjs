'use strict';

// Redact display strings while preserving structured labels and the original execution input.
const REDACTED_MARKER = '«redacted»';
const REDACT_PATTERNS = [
  // 107-S0(45 号文 §9.6 发现 5):sk- 之后允许 `_`／`-`。修前只认纯字母数字,`sk-proj-…`／`sk-ant-api03-…` 这类
  // 带分段的真 key 在第一个 `-` 处就断到不足 16 字,整把漏掉(真机会话文件里就有一把这样漏的)。
  /\b(sk-[A-Za-z0-9][A-Za-z0-9_-]{15,})/g,
  /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  /\bBearer\s+([A-Za-z0-9._~+/-]{16,}=*)/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g, // JWT
  /\b((?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key)\s*[:=]\s*)([^\s"']{6,})/gi,
  /\b([A-Fa-f0-9]{40,})\b/g, // long hex blobs
  // 127 波 2-quater B1 ③(45 号文 §2-quater.1 取证 7):管家的豁免命令摘录也走这张表(单一来源,不另立一份),
  // 而命令行里的凭据长得和日志里的不一样 —— 下面六种修前全漏。都是「标签 + 值」两组或「整段」一组,沿用上面
  // redact() 按组数决定留不留标签的既有口径;量词都有界或以分隔符收口,长文本上不回溯爆炸。
  /\b([a-z][a-z0-9+.-]{0,20}:\/\/[^\s:@\/]{1,256}:)([^\s@\/]{1,256})(?=@)/gi, // URL 里的 userinfo:https://user:pass@host
  /((?:^|\s)(?:-u|-U|--user|--proxy-user)\s*["']?[^\s:"'@]{2,256}:)([^\s"';&|]+)/g, // curl -u user:pass(用户名至少 2 字:`python -u C:\x.py` 的盘符不算)
  /\b(authorization\s*[:=]\s*basic\s+)([A-Za-z0-9+/=._~-]{4,})/gi, // Authorization: Basic xxx
  /((?:^|\s)--?(?:password|passwd|pwd|pass|token|secret|api[_-]?key)\s+["']?)([^\s"';&|]+)/gi, // --password xxx(空格分隔;值在命令分隔符处收口)
  /((?<=[A-Za-z0-9_])(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*)([^\s"'&;|]+)/gi, // 词中:PGPASSWORD= / DB_PASSWORD= / OPENAI_API_KEY=(上面那条的 \b 在词中失效)
  /\b(AKIA[0-9A-Z]{16})\b/g, // AWS access key id
  // 107-S0(45 号文 §9.6 发现 5:真机会话文件里 58 处真 key 值,旧表 redact 后仍剩 39 处):值带引号的「标签 + 值」。
  // 上面那条标签式要求值紧跟在 `:`／`=` 后、且不以引号开头,于是 JSON `"apiKey": "…"`、JS `apiKey: '…'`、
  // Python／TOML／.env／PowerShell `api_key = "…"` 全漏;模型 file_read 过 config.json 之后,会话文件里存的还是
  // 转义过的 `\"apiKey\": \"…\"`(再嵌一层就是 `\\\"`)。
  //   - 标签:以这几个词【结尾】的键(`accessToken`／`client_secret`／`x-api-key`／`OPENAI_API_KEY` 都算),词后面
  //     紧跟(可选的反斜杠＋)引号或直接 `:`／`=` —— 所以 `"maxTokens"`／`"tokenCount"`／`"token_type"` 不算;
  //   - 值:必须以引号开头(数字、null、对象、数组都不碰),`"Bearer ／Basic ／Token "` 前缀留在标签里;
  //   - 值只收可打印 ASCII 且不含空格、引号、反斜杠 —— 遇到转义引号就收口;中文文案(locale 里 `"…ApiKey": "端点密钥…"`)不误伤。
  // 量词全部有界,值之后没有任何需要回溯的成分,长文本线性。
  /((?:api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|secret|token|password|passwd|authorization)\\{0,8}["']?\s{0,8}[:=]\s{0,8}\\{0,8}["'](?:(?:bearer|basic|token)\s{1,8})?)([!#-&(-\[\]-~]{6,4096})/gi,
];
function redact(input) {
  let s = String(input == null ? '' : input);
  for (const re of REDACT_PATTERNS) {
    re.lastIndex = 0;
    // replace passes (match, p1, …, pN, offset, string). For a label+value pattern (2 capture groups: the
    // `apiKey=`-style label and the secret value) we keep the label and redact only the value. For a
    // single-capture secret pattern (sk-…, ghp_…, JWT, hex blob) we replace the WHOLE match with the marker.
    // (Bugfix: the old `(m,a,b)=> b===undefined?…:`${a}…`` treated the numeric offset as a 2nd group, so
    // single-group secrets leaked as `secret«redacted»`. Detecting group count via arguments fixes it.)
    s = s.replace(re, function () {
      const args = Array.from(arguments);
      // Trailing args are offset(number) then optionally the full string; strip them to get capture groups.
      let end = args.length;
      if (typeof args[end - 1] === 'string' && typeof args[end - 2] === 'number') end -= 2; // …, offset, string
      else if (typeof args[end - 1] === 'number') end -= 1;                                  // …, offset
      const groups = args.slice(1, end); // capture groups only (args[0] is the full match)
      // Two capture groups → label + value: keep the label, redact the value.
      if (groups.length >= 2 && groups[1] !== undefined) return groups[0] + REDACTED_MARKER;
      return REDACTED_MARKER;
    });
  }
  return s;
}

module.exports = { redact, REDACTED_MARKER };
