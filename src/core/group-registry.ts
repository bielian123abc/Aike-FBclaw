/**
 * 跨帳號全域社團清冊 — 防止多帳號加入同一社團被 FB 風控判定為協同網路。
 * 任一帳號加過的社團，其它帳號不再加；並提供總覽所需的元資料。
 */
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../config';

const FILE = path.join(DATA_DIR, 'global-joined-groups.json');

export interface GroupMeta {
  url: string;
  name?: string;
  region?: string;   // 判定出的地區（如 台灣/台北）
  members?: string;  // 人數描述
  by: string[];      // 哪些帳號加過
  addedAt: number;
}

function normalizeGroupUrl(url: string): string {
  // 去除 www. 前綴 + 去 query/尾斜線，使 facebook.com 與 www.facebook.com 的同一社團能被去重
  const strip = (s: string) => s.replace(/^https?:\/\/www\./i, '').replace(/^www\./i, '').replace(/\/$/, '');
  try {
    const u = new URL(url);
    const host = u.host.replace(/^www\./i, '').toLowerCase();
    const origin = u.protocol + '//' + host;
    return strip(origin + u.pathname);
  } catch { return strip(url.trim()); }
}

function readAll(): GroupMeta[] {
  try { if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf-8')); } catch {}
  return [];
}

function writeAll(list: GroupMeta[]): void {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
  try { fs.writeFileSync(FILE, JSON.stringify(list, null, 2)); } catch {}
}

export function getGlobalJoinedGroups(): string[] {
  return readAll().map((g) => g.url);
}

export function isGroupGloballyJoined(url: string): boolean {
  const u = normalizeGroupUrl(url);
  return readAll().some((g) => g.url === u);
}

/** 記錄某帳號加入社團（跨帳號去重清冊 + 元資料）。若已存在則補充 by 清單。 */
export function recordGlobalJoinedGroup(url: string, by: string, meta?: { name?: string; region?: string; members?: string }): void {
  const u = normalizeGroupUrl(url);
  const all = readAll();
  const ex = all.find((g) => g.url === u);
  if (ex) {
    if (!ex.by.includes(by)) ex.by.push(by);
    if (meta?.name && !ex.name) ex.name = meta.name;
    if (meta?.region && !ex.region) ex.region = meta.region;
    if (meta?.members && !ex.members) ex.members = meta.members;
  } else {
    all.push({ url: u, name: meta?.name, region: meta?.region, members: meta?.members, by: [by], addedAt: Date.now() });
  }
  writeAll(all);
}

export function getGlobalGroupEntries(): GroupMeta[] {
  return readAll();
}

/** 某帳號的社團中，有哪些是「其它帳號也已加入」（協同風險提示） */
export function getCrossAccountOverlap(accountId: string): GroupMeta[] {
  return readAll().filter((g) => g.by.includes(accountId) && g.by.length > 1);
}
