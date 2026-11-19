'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');
const { apiFailure } = require('./http-protocol.cjs');

// 项目级写入(.ruyi/agents.json、.ruyi/workflows.json)的 cwd 来自请求体:目录不存在或是个文件时,下面的 mkdir 会抛
// ENOTDIR / EEXIST,路由兜底成 500,还把带宿主路径的 errno 原文回给前端。写前先 stat 一下:不是目录就回 400 人话
// (不回显路径)。返回 null = 可写;否则是一份 apiFailure 响应,调用方直接 send。
async function projectCwdDirectoryFailure(cwd) {
  try { if ((await fsp.stat(path.resolve(String(cwd || '')))).isDirectory()) return null; } catch { /* 不存在:同样按「不是目录」答 */ }
  return apiFailure('project.cwd_not_directory', {}, '工作文件夹不存在或不是目录,无法保存项目级配置', 400);
}

module.exports = { projectCwdDirectoryFailure };
