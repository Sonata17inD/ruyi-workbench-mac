'use strict';

const os = require('node:os');
const path = require('node:path');

// Older configurations can contain duplicate quoted workspace paths. Normalize at the read boundary.
// 117w-W1 提交②(27 号文 §11.19.2):workspaces[].note 的字数上限。备注是给管家的候选表投影用的
// 一句话标签(「股票资料」「客户合同」),不是说明文档 —— 80 字够写清楚,又不至于把到访层撑爆。
const WORKSPACE_NOTE_MAX = 80;
// 117w-W1④(27 号文 §11.19.8 债表第一行的裁决):workspaces[] 的行数上限。
// 20 是 UI 时代手工加文件夹的上限:那时表只会被人一行一行地敲进去,20 已经够多了。117w-W1②
// 起工作台【自己】会往表里追加行(省略 cwd 时在 Ruyi 根下派生子工作区并登记),表因此会自己长
// —— 20 那道帽子于是从「够用的上限」变成一把静默的刀:用户手上已有 20 个工作区时,派生出来的
// 那一行会在下一次 normalizeConfig 时被截掉,而目录已经建好、线程照跑,cwd 于是指向一个【表外】
// 目录,再拿它当 cwd 会被 13k 拒。「目录建了、行没了」是最坏的形状。
// 抬到 64 的两条理由:① 派生根在 ~/Ruyi 下,是 Ruyi 自己的地盘,在那里放宽是有意的;
// ② 06i 的 STEWARD_WORKSPACE_TABLE_MAX(候选表投影的行数上限)保持 20 不动 —— 表能长到 21..64
// 行之后,13o 那句「…另有 N 个工作区未列出」才在【生产形状】下可达、可测。
// W7 起派生不再往 workspaces[] 追加(改登记进 stewardManagedWorkspaces),13k 那道「派生前帽检查」
// 随之退役;64 保持不动 —— 存量用户的表可能已经长过 20,改回去会截掉他们的行。
const WORKSPACE_TABLE_CAP = 64;
// W7:如意自己开的文件夹那张表(stewardManagedWorkspaces)的行数上限。满了从【最老】的那一行起丢 ——
// 不像 workspaces[] 那样拒开线程:这张表用户在界面上看不见、也清不了,拒只会让管家卡死。被挤掉的
// 目录还在磁盘上,线程照常能用,只是不再出现在管家的已知工作区清单里。
const STEWARD_MANAGED_WORKSPACES_CAP = 200;
// 117w-W1 提交② 起派生行写进 workspaces[] 时带的备注。W7 起派生不再写 workspaces[],这个字面量只剩
// 一个用处:认出【老版本】追加进常用工作区的那些行,把它们挪回如意自己那张表(清洗块的「迁出」一支)。
const STEWARD_WORKSPACE_LEGACY_NOTE = 'Ruyi 自动开的';

function createWorkspaceConfig({ platform }) {
  function normalizeWorkspacePathString(value) {
    const raw = String(value == null ? '' : value);
    let s = platform === 'darwin' && raw.startsWith('/') ? raw : raw.trim();
    const pairs = [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’']];
    for (let guard = 0; guard < 3; guard++) {
      const pair = pairs.find(([open, close]) => s.length >= 2 && s.startsWith(open) && s.endsWith(close));
      if (!pair) break;
      s = s.slice(pair[0].length, s.length - pair[1].length).trim();
    }
    // 代码走查 C14:去掉结尾分隔符(盘符根 C:\ 与单独的 / 保留)—— 修前带不带结尾「\」存成两条常用文件夹。
    const stripped = s.replace(platform === 'darwin' && s.startsWith('/') ? /\/+$/ : /[\\/]+$/, '');
    if (stripped && !/^[A-Za-z]:$/.test(stripped)) s = stripped;
    else if (s) s = s.slice(0, stripped.length + 1);
    return s.slice(0, 1000);
  }

  // W7:如意自己开的文件夹那张表(stewardManagedWorkspaces)的清洗,外加它与常用工作区 workspaces[] 之间
  // 的两条迁移。只在 normalizeConfig 的工作区清洗块里调一次;wsRows 是那一块刚清洗完的常用工作区行。
  // 返回 { kept, managed }:kept 是留在常用工作区里的行(顺序不变),managed 是清洗后的如意那张表。
  //   · 迁出 —— 老版本(117w-W1 ② 起)把派生目录追加进了常用工作区,用户在「常用工作区」里看到一串
  //     自己没开过的文件夹(真机 2026-09-24:两条股票分析线程各留下一行)。认法两条,满足其一即挪回如意那张表:
  //     ① 行上还带着老备注「Ruyi 自动开的」;② 备注已经被前端保存时剥掉(顶栏与设置页存工作区只写
  //     path/read/write/execute 四个字段,真机那两行就是这样),但它是【出厂 Ruyi 根】的直接子目录。
  //     第 ② 条只在 stewardWorkspaceRoot 仍是出厂值时认 —— 用户把根改到自己的项目父目录时,那下面的
  //     子目录多半是他自己的项目,不能按路径猜。第 0 行(默认工作区)永远不动:用户把它设成了默认,就是他的。
  //   · 收编(以用户为准)—— 一个如意目录又出现在常用工作区里 = 用户亲手把它加了回去(W7 起工作台自己
  //     不再往常用工作区写任何一行),这一行留下,如意那张表里对应的条目标 adopted:true。迁出只认
  //     「不在如意那张表里」的行,所以收编过的行下一次读配置不会再被挪走(否则两条迁移会来回拉锯)。
  function stewardManagedWorkspaceKey(value) {
    const normalized = String(value == null ? '' : value).replace(/[\\/]+/g, '/').replace(/\/+$/, '');
    return normalized;
  }
  function normalizeStewardManagedWorkspaces(config, wsRows) {
    const rawList = Array.isArray(config.stewardManagedWorkspaces) ? config.stewardManagedWorkspaces : [];
    const managed = [];
    const byKey = new Map();
    for (const raw of rawList) {
      const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : (typeof raw === 'string' ? { path: raw } : null);
      if (!src) continue;
      const p = normalizeWorkspacePathString(src.path);
      if (!p || !path.isAbsolute(p)) continue;
      const key = stewardManagedWorkspaceKey(p);
      const prev = byKey.get(key);
      if (prev) { if (src.adopted === true) prev.adopted = true; continue; }
      const entry = { path: p, at: typeof src.at === 'string' ? src.at.trim().slice(0, 40) : '' };
      if (src.adopted === true) entry.adopted = true;
      managed.push(entry);
      byKey.set(key, entry);
    }
    const factoryRoot = path.join(os.homedir(), 'Ruyi');
    const rootRaw = normalizeWorkspacePathString(config.stewardWorkspaceRoot);
    const rootIsFactory = !rootRaw || !path.isAbsolute(rootRaw) || stewardManagedWorkspaceKey(rootRaw) === stewardManagedWorkspaceKey(factoryRoot);
    const kept = [];
    (Array.isArray(wsRows) ? wsRows : []).forEach((row, index) => {
      const key = stewardManagedWorkspaceKey(row.path);
      const known = byKey.get(key);
      if (known) { known.adopted = true; kept.push(row); return; }
      const underFactoryRoot = rootIsFactory && stewardManagedWorkspaceKey(path.dirname(row.path)) === stewardManagedWorkspaceKey(factoryRoot);
      const legacy = index > 0 && path.isAbsolute(row.path) && (row.note === STEWARD_WORKSPACE_LEGACY_NOTE || underFactoryRoot);
      if (!legacy) { kept.push(row); return; }
      const entry = { path: row.path, at: '' };
      managed.push(entry);
      byKey.set(key, entry);
    });
    return { kept, managed: managed.slice(-STEWARD_MANAGED_WORKSPACES_CAP) };
  }

  return { normalizeWorkspacePathString, normalizeStewardManagedWorkspaces };
}

module.exports = { createWorkspaceConfig, WORKSPACE_NOTE_MAX, WORKSPACE_TABLE_CAP };
