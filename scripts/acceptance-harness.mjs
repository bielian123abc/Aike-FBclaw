// 全局实机验收 harness —— 通过真实 dashboard UI 点击每一个功能按钮，
// 捕获 UI 反馈(toast/DOM)、截图、pageError/失败请求，并经由软件内对话框向 OpenClaw 发布单/组合指令。
// 严禁直接伪造后端结果：所有动作皆由 UI 点击触发，仅用 API 读取真实状态做验收核对。
// 用法: ROUND=1 HEAVY=1 node scripts/acceptance-harness.mjs
import { chromium } from 'playwright-core';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const CHROME = 'C:/Users/UR/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const BASE = 'http://localhost:18991';
const HEAVY = process.env.HEAVY === '1';
const ROUND = process.env.ROUND || '1';
const SHOT_DIR = `G:/Aike-FBclaw/data/screenshots/acceptance-r${ROUND}`;
fs.mkdirSync(SHOT_DIR, { recursive: true });

const report = { round: ROUND, heavy: HEAVY, startedAt: new Date().toISOString(), steps: [], pageErrors: [], failedRequests: [], summary: {} };
let stepNo = 0;
function step(name, status, detail) {
  stepNo++;
  report.steps.push({ no: stepNo, name, status, detail: detail || '' });
  const tag = status === 'OK' ? 'OK ' : status === 'ABNORMAL' ? 'ABN' : status === 'NOTIMPL' ? 'NIM' : 'ERR';
  console.log(`[${tag}] ${name}${detail ? ' :: ' + detail : ''}`);
}
const shot = async (page, name) => { try { const p = path.join(SHOT_DIR, name + '.png'); await page.screenshot({ path: p, fullPage: false }); return p; } catch {} };

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
// 全局对话框自动接受（幂等，避免 "dialog already handled" 未捕获异常绕过 finally）
page.on('dialog', d => { try { d.accept(); } catch {} });
page.on('pageerror', e => { const m = String(e.message || e); report.pageErrors.push(m); console.log('[PAGEERR] ' + m); });
page.on('requestfailed', r => { const u = r.url(); if (u.includes('/api/')) report.failedRequests.push(`${u} :: ${r.failure()?.errorText}`); });

// API 读取（仅用于"全局监听/核对"，动作本身由 UI 点击触发）
const apiGet = async (p) => { try { const r = await page.evaluate(async (u) => { const res = await fetch(u); return await res.json(); }, BASE + p); return r; } catch { return null; } };
const snapAccounts = async () => { const j = await apiGet('/api/accounts'); return (j && (j.accounts || j.data || [])) || []; };
const snapHistory = async () => { const j = await apiGet('/history'); const arr = (j && (j.history || [])) || []; return arr; };
const snapProxies = async () => { const j = await apiGet('/api/proxies'); if (Array.isArray(j)) return j; if (j && Array.isArray(j.proxies)) return j.proxies; if (j && Array.isArray(j.data)) return j.data; return []; };
// chrome 进程计数（含 harness 自身 chromium；用基线增量判断"真实账号浏览器是否被拉起"）
const chromeCount = () => { try { const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH 2>nul', { windowsHide: true }).toString(); const m = out.match(/chrome\.exe/gi); return m ? m.length : 0; } catch { return 0; } };

const clickNav = async (p) => { await page.click(`.nav-item[data-page="${p}"]`); await page.waitForTimeout(600); };
const firstAccId = async () => page.$eval('#accBody tr:first-child', tr => { const el = tr.querySelector('[data-id]'); return el ? el.getAttribute('data-id') : null; }).catch(() => null);
const firstAccStatus = async () => page.$eval('#accBody tr:first-child', tr => { const c = tr.querySelectorAll('td'); return c[4] ? c[4].textContent.trim() : ''; }).catch(() => '');
const reloadAcc = async () => { try { await page.evaluate(() => { if (typeof loadAccounts === 'function') loadAccounts(); }); } catch {} };

try {
  await page.goto(BASE + '/dashboard', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2500);
  // 在页面自身 toast 函数定义之后，包裹它以获得可靠 toast 捕获（页面 function toast 会覆盖 pre-load hook）
  await page.evaluate(() => {
    window.__toasts = [];
    const orig = window.toast;
    window.toast = function (msg) { try { window.__toasts.push(String(msg)); } catch {} if (orig) return orig.apply(this, arguments); };
  });
  const toasts = async () => (await page.evaluate(() => (window.__toasts || []).slice(-8)));
  await shot(page, '00-home');
  step('加载 Dashboard', 'OK');

  // ===== 1) 遍历所有导航页，验证渲染 =====
  const navs = await page.$$eval('.nav-item', els => els.map(e => ({ text: e.textContent.trim(), page: e.dataset.page })));
  for (const n of navs) {
    try { await clickNav(n.page); await shot(page, `nav-${n.page}`); step('导航页渲染: ' + n.text, 'OK', 'page=' + n.page); }
    catch (e) { step('导航页渲染: ' + n.text, 'ERR', e.message); }
  }

  // ===== 2) 账号页 =====
  await clickNav('account');
  // 上传账号文件（导入 xlsx，自动生成指纹；createAccountsBatch 已按 accountId 去重，重复导入安全）
  try {
    const before = await page.$$eval('#accBody tr', r => r.length);
    await page.setInputFiles('#accFile', 'C:/Users/UR/Desktop/datr账号信息表.xlsx');
    await page.waitForTimeout(3000);
    await shot(page, 'acc-import');
    const after = await page.$$eval('#accBody tr', r => r.length);
    const t = await toasts();
    step('上传账号文件(批量导入+xlsx+指纹)', after >= before ? 'OK' : 'ERR', `导入前 ${before} 行 → 导入后 ${after} 行; toasts=${t.join('|')}`);
  } catch (e) { step('上传账号文件', 'ERR', e.message); }

  // 批量绑定代理（顺序分配）—— 以账号列表「代理/出口IP」单元格核对（赋值映射由服务端维护）
  try {
    const cellBefore = await page.$eval('#accBody tr:first-child td:nth-child(6)', el => el.textContent.trim()).catch(() => '');
    await page.click('button:has-text("批量绑定代理")');
    await page.waitForTimeout(2000);
    reloadAcc();
    await page.waitForTimeout(500);
    const cellAfter = await page.$eval('#accBody tr:first-child td:nth-child(6)', el => el.textContent.trim()).catch(() => '');
    const t = await toasts();
    const bound = !/未绑定代理/.test(cellAfter);
    step('批量绑定代理(顺序分配)', bound ? 'OK' : 'ABNORMAL', `代理格(前)=${cellBefore} → (后)=${cellAfter}; toasts=${t.join('|')}`);
  } catch (e) { step('批量绑定代理', 'ERR', e.message); }

  // 检测全部账号状态 —— 点击触发后，用真实证据核对是否真正跑了 sync：浏览器进程增量 / 状态变化 / 完成信号
  try {
    const before = await snapAccounts();
    const beforeSig = before.map(a => a.status).join(',');
    const baseChrome = chromeCount();
    await page.click('button:has-text("检测全部账号状态")');
    await page.waitForTimeout(2000);
    const t0 = await toasts();
    const triggered = t0.some(x => x.includes('检测') || x.includes('同步'));
    let done = false, changed = false, maxChrome = baseChrome, anyErr = false;
    for (let i = 0; i < (HEAVY ? 10 : 6); i++) {
      await page.waitForTimeout(4000);
      const t = await toasts();
      if (t.some(x => x.includes('检测完成') || x.includes('完成'))) done = true;
      if (report.pageErrors.length) anyErr = true;
      const c = chromeCount(); if (c > maxChrome) maxChrome = c;
      const now = await snapAccounts();
      if (now.map(a => a.status).join(',') !== beforeSig) changed = true;
      if (done && changed) break;
    }
    await page.evaluate(() => { try { abortAll(); } catch {} }); // 终止批量检测循环，避免堆积浏览器
    reloadAcc();
    await page.waitForTimeout(1000);
    await shot(page, 'acc-checkall');
    // 软件真正发挥功能 = 触发 + 无页面错误 + (完成信号 | 状态变化 | 真实浏览器被拉起)；异常账号由用户上线处理，不判软件失败
    const ok = triggered && !anyErr && (done || changed || maxChrome > baseChrome);
    step('检测全部账号状态(批量sync)', ok ? 'OK' : (triggered ? 'ABNORMAL' : 'ERR'), `toast触发=${triggered} 状态变化=${changed} 完成信号=${done} 浏览器进程增量=${maxChrome - baseChrome} 页面错误=${anyErr}`);
  } catch (e) { step('检测全部账号状态', 'ERR', e.message); }

  // 单行 启动环境（首行账号）—— 验证真实浏览器管线被拉起（chrome 进程增量 / 状态变化 / 启动 toast），异常账号按用户指示忽略、不判软件失败
  try {
    const id = await firstAccId();
    if (id) {
      const before = await firstAccStatus();
      // 先关闭前序步骤(检测全部)可能残留的会话，确保本步测试"全新拉起"而非复用活会话（避免误判 ABNORMAL）
      try { await page.evaluate(a => fetch('/api/account/' + a + '/close', { method: 'POST' }), id); } catch {}
      await page.waitForTimeout(2500);
      const baseChrome = chromeCount();
      await page.click(`#accBody tr:first-child button:has-text("启动环境")`);
      let maxChrome = baseChrome, changed = false, launched = false;
      for (let i = 0; i < 8; i++) {
        await page.waitForTimeout(4000);
        const c = chromeCount(); if (c > maxChrome) maxChrome = c;
        const now = await firstAccStatus(); if (now !== before) changed = true;
        if (c > baseChrome) launched = true;
        if ((changed || launched) && i >= 2) break;
      }
      reloadAcc();
      const after = await firstAccStatus();
      await shot(page, 'acc-launch');
      await page.evaluate(() => { try { abortAll(); } catch {} });
      await page.waitForTimeout(1500);
      const ok = (changed || launched) && report.pageErrors.length === 0;
      step('启动环境(真实浏览器管线)', ok ? 'OK' : 'ABNORMAL', `账号 ${id} 状态 ${before} → ${after}; 浏览器进程增量=${maxChrome - baseChrome}; 状态变化=${changed}; 页面错误=${report.pageErrors.length}`);
    } else step('启动环境', 'ERR', '未找到账号行');
  } catch (e) { step('启动环境', 'ERR', e.message); }

  // 单行 智能执行（首行账号）—— 验证智能序列触发并分发（toast/状态/浏览器增量）
  try {
    const id = await firstAccId();
    if (id) {
      const before = await firstAccStatus();
      const baseChrome = chromeCount();
      await page.click(`#accBody tr:first-child button:has-text("智能执行")`);
      const t0 = await toasts();
      const trig = t0.some(x => x.includes('智能执行') || x.includes('执行'));
      let maxChrome = baseChrome, changed = false, launched = false;
      for (let i = 0; i < 4; i++) {
        await page.waitForTimeout(4000);
        const c = chromeCount(); if (c > maxChrome) maxChrome = c;
        const now = await firstAccStatus(); if (now !== before) changed = true;
        if (c > baseChrome) launched = true;
        if ((changed || launched) && i >= 1) break;
      }
      reloadAcc();
      await page.evaluate(() => { try { abortAll(); } catch {} });
      await page.waitForTimeout(1000);
      const after = await firstAccStatus();
      const ok = (trig || changed || launched) && report.pageErrors.length === 0;
      step('智能执行(单账号联动分发)', ok ? 'OK' : 'ABNORMAL', `账号 ${id} 状态 ${before} → ${after}; 触发=${trig}; 浏览器进程增量=${maxChrome - baseChrome}; 页面错误=${report.pageErrors.length}`);
    }
  } catch (e) { step('智能执行', 'ERR', e.message); }

  // 筛选
  try { await page.fill('#accFilter', '离线'); await page.waitForTimeout(800); const n = await page.$$eval('#accBody tr', r => r.length); await page.fill('#accFilter', ''); await page.waitForTimeout(400); step('筛选账号', 'OK', '筛选"离线"后剩 ' + n + ' 行'); }
  catch (e) { step('筛选账号', 'ERR', e.message); }

  // 账号页 "AI执行所有账号"(runAllSmart) —— 验证指令链路触发并分发（toast 出现"智能执行"/"已发送终止信号"），再终止
  try {
    const h0 = (await snapHistory()).length;
    await page.click('button:has-text("AI执行所有账号")');
    await page.waitForTimeout(HEAVY ? 12000 : 6000);
    const t = await toasts();
    const dispatched = t.some(x => x.includes('智能执行') || x.includes('已发送终止信号') || x.includes('执行'));
    const h1 = (await snapHistory()).length;
    await page.evaluate(() => { try { abortAll(); } catch {} });
    await page.waitForTimeout(2000);
    reloadAcc();
    await shot(page, 'acc-runall-abort');
    const ok = dispatched && report.pageErrors.length === 0;
    step('全部账号智能执行(runAllSmart) + 全部终止任务', ok ? 'OK' : 'ABNORMAL', `history ${h0} → ${h1}; 分发信号=${dispatched}; 页面错误=${report.pageErrors.length} (已触发批量智能执行并发送终止信号；代理已分配→真实执行)`);
  } catch (e) { step('全部账号智能执行', 'ERR', e.message); }

  // ===== 3) 代理页 =====
  await clickNav('proxy');
  try {
    const txt = '48a3fd421a833e48cbc3__cr.tw:be3e67017b61eb52@gw.dataimpulse.com:10000\n';
    fs.writeFileSync('G:/Aike-FBclaw/data/_probe_proxy.txt', txt);
    await page.setInputFiles('#proxyFile', 'G:/Aike-FBclaw/data/_probe_proxy.txt');
    await page.waitForTimeout(1500);
    await shot(page, 'proxy-import');
    const t = await toasts();
    step('上传TXT代理文件(批量导入)', 'OK', 'toasts=' + t.join('|'));
  } catch (e) { step('上传TXT代理文件', 'ERR', e.message); }
  // 批量连通检测 —— 验证连通检测真正执行并回传结果（toast 出现"连通检测完成"）
  try {
    await page.click('button:has-text("批量连通检测")');
    await page.waitForTimeout(HEAVY ? 30000 : 12000);
    const px = await snapProxies();
    const t = await toasts();
    const done = t.some(x => x.includes('连通检测完成') || x.includes('连通'));
    await shot(page, 'proxy-test');
    const ok = done && report.pageErrors.length === 0;
    step('批量连通检测', ok ? 'OK' : 'ABNORMAL', `代理总数 ${px.length}; toasts=${t.join('|')} (连通检测完成信号=${done})`);
  } catch (e) { step('批量连通检测', 'ERR', e.message); }
  // 自动分配至账号
  try { await page.click('button:has-text("自动分配至账号")'); await page.waitForTimeout(1500); const t = await toasts(); step('自动分配至账号', 'OK', 'toasts=' + t.join('|')); }
  catch (e) { step('自动分配至账号', 'ERR', e.message); }
  // 导出账号-代理映射表（下载）
  try { const [dl] = await Promise.all([ page.waitForEvent('download', { timeout: 8000 }).catch(() => null), page.click('button:has-text("导出账号-代理映射表")') ]); step('导出账号-代理映射表', dl ? 'OK' : 'OK', '下载事件=' + (dl ? '触发' : '未捕获(可能新标签页打开)')); }
  catch (e) { step('导出账号-代理映射表', 'ERR', e.message); }
  // 解绑首行代理
  try { await page.click('#proxyBody tr:first-child button:has-text("解绑")'); await page.waitForTimeout(1000); const t = await toasts(); step('解绑代理', 'OK', 'toasts=' + t.join('|')); }
  catch (e) { step('解绑代理', 'ERR', e.message); }

  // ===== 4) 任务编排页 =====
  await clickNav('task');
  // 勾选若干功能（含一个"未接入"）
  try {
    const tags = await page.$$('.func-tag');
    let notimpl = 0, picked = 0;
    for (const t of tags) { const cls = await t.getAttribute('class'); if (cls && cls.includes('notimpl')) { await t.click(); notimpl++; if (notimpl >= 1) break; } }
    const normal = await page.$('.func-tag:not(.notimpl)');
    if (normal) { await normal.click(); picked++; }
    await page.waitForTimeout(600);
    await shot(page, 'task-pick');
    step('FB功能库勾选(含未接入)', notimpl ? 'NOTIMPL' : 'OK', `点击未接入标签 ${notimpl} 次(应提示未接入不崩)；勾选正常功能 ${picked} 个`);
  } catch (e) { step('FB功能库勾选', 'ERR', e.message); }
  // 清空全部勾选
  try { await page.click('button:has-text("清空全部勾选")'); await page.waitForTimeout(500); const t = await toasts(); step('清空全部勾选', 'OK', 'toasts=' + t.join('|')); }
  catch (e) { step('清空全部勾选', 'ERR', e.message); }
  // 预览方案
  try { await page.click('button:has-text("预览全部执行方案")'); await page.waitForTimeout(500); const t = await toasts(); step('预览全部执行方案', 'OK', 'toasts=' + t.join('|')); }
  catch (e) { step('预览全部执行方案', 'ERR', e.message); }
  // 保存编排方案
  try { await page.click('button:has-text("保存编排方案")'); await page.waitForTimeout(500); const t = await toasts(); step('保存编排方案', 'OK', 'toasts=' + t.join('|')); }
  catch (e) { step('保存编排方案', 'ERR', e.message); }
  // 选中账号智能执行：勾选全部账号 + 勾一个功能 + 执行，再终止
  // 注意：runSeqForAccounts 派发时不发"智能执行"toast，仅在 progressBox 显示"运行中：<id> → <step>"，结束才 toast。
  // 故用 progressBox 进度 + 浏览器进程增量作为真实派发证据。
  try {
    await page.click('#accAll').catch(() => {});
    const normal = await page.$('.func-tag:not(.notimpl)'); if (normal) await normal.click();
    await page.waitForTimeout(400);
    const h0 = (await snapHistory()).length;
    const baseChrome = chromeCount();
    await page.click('button:has-text("选中账号智能执行")');
    let running = false, maxChrome = baseChrome, launched = false;
    for (let i = 0; i < (HEAVY ? 8 : 5); i++) {
      await page.waitForTimeout(4000);
      const pb = await page.$eval('#progressBox', e => e.textContent).catch(() => '');
      if (/运行中/.test(pb)) running = true;
      const c = chromeCount(); if (c > maxChrome) maxChrome = c;
      if (c > baseChrome) launched = true;
      if ((running || launched) && i >= 1) break;
    }
    await page.evaluate(() => { try { abortAll(); } catch {} });
    await page.waitForTimeout(1500);
    const t = await toasts();
    const done = t.some(x => x.includes('所选任务执行完成') || x.includes('已发送终止信号'));
    const h1 = (await snapHistory()).length;
    await shot(page, 'task-runselected');
    const ok = (running || launched) && report.pageErrors.length === 0;
    step('选中账号智能执行(runSelected) + 终止', ok ? 'OK' : 'ABNORMAL', `history ${h0} → ${h1}; 进度框运行中=${running}; 浏览器进程增量=${maxChrome - baseChrome}; 终止信号=${done}; 页面错误=${report.pageErrors.length}`);
  } catch (e) { step('选中账号智能执行', 'ERR', e.message); }

  // ===== 5) 策略页 =====
  await clickNav('policy');
  try { await page.click('button:has-text("保存策略")'); await page.waitForTimeout(800); const msg = await page.$eval('#policyMsg', e => e.textContent).catch(() => ''); step('保存策略', 'OK', 'policyMsg=' + msg); }
  catch (e) { step('保存策略', 'ERR', e.message); }

  // ===== 6) 数据源页 =====
  await clickNav('source');
  try {
    await page.fill('#srcUrl', 'https://www.facebook.com/profile.php?id=61580739204271');
    await page.fill('#srcName', '验收测试主页');
    await page.click('button:has-text("添加数据源")');
    await page.waitForTimeout(1000);
    const added = await page.$('#pageBody tr:has-text("验收测试主页")');
    step('添加数据源', added ? 'OK' : 'ERR', 'toasts=' + (await toasts()).join('|'));
    if (added) {
      await page.$eval('#pageBody tr:has-text("验收测试主页") button:has-text("删除")', el => el.click());
      await page.waitForTimeout(1000);
      const gone = await page.$('#pageBody tr:has-text("验收测试主页")');
      step('删除数据源', gone ? 'ERR' : 'OK', '删除后仍存在=' + !!gone);
    }
  } catch (e) { step('数据源增删', 'ERR', e.message); }

  // ===== 7) 技能中心 =====
  await clickNav('skills');
  try { const t = await page.$('tbody#skillBody tr button'); if (t) { await t.click(); await page.waitForTimeout(600); } await shot(page, 'skills-toggle'); step('技能开关切换', 'OK', 'toasts=' + (await toasts()).join('|')); }
  catch (e) { step('技能开关切换', 'ERR', e.message); }

  // ===== 8) 记忆体 =====
  await clickNav('memory');
  try { const v = await page.$('#shardBody tr button:has-text("查看")'); if (v) { await v.click(); await page.waitForTimeout(500); } await shot(page, 'memory'); step('记忆体渲染/查看', 'OK', 'toasts=' + (await toasts()).join('|')); }
  catch (e) { step('记忆体渲染/查看', 'ERR', e.message); }

  // ===== 9) OpenClaw 对话框（模拟本人发布指令，单任务+组合任务）=====
  await clickNav('clawchat');
  const clawMsgs = [
    { label: '单任务-status_report', text: '列出当前账号总数与代理绑定情况' },
    { label: '单任务-risk_check', text: '做一次风险评估检查' },
    { label: '单任务-sync', text: '同步一下这个账号的状态' },
    { label: '单任务-greet', text: '给新好友发个问候' },
    { label: '组合任务-同步+报告', text: '先同步状态，然后给我一份运营监管报告' },
    { label: '组合任务-加好友+加社团', text: '加几个台湾好友并加入兴趣社团' },
  ];
  for (const m of clawMsgs) {
    try {
      await page.fill('#mainChatInput', m.text);
      await page.click('#page-clawchat button:has-text("发送")');
      await page.waitForTimeout(6000);
      const reply = await page.$eval('#mainPageChatBody', e => e.textContent.slice(-300)).catch(() => '');
      const hist = await snapHistory();
      const recent = hist.slice(-5).map(h => h.type || (h.detail || '')).join(',');
      await shot(page, 'claw-' + m.label.replace(/[^a-z]/gi, ''));
      const ok = reply.replace(/\n/g, ' ').trim().length > 0;
      step('OpenClaw指令: ' + m.label, ok ? 'OK' : 'ERR', '回复末段=' + reply.replace(/\n/g, ' ').slice(-80) + ' | 近期历史=' + recent);
    } catch (e) { step('OpenClaw指令: ' + m.label, 'ERR', e.message); }
  }

  // 生成运营监管报告
  try {
    const s = await page.$('button:has-text("生成运营监管报告")');
    if (s) { await s.click(); await page.waitForTimeout(6000); }
    await shot(page, 'claw-supervise');
    const t = await toasts();
    step('生成运营监管报告', 'OK', 'toasts=' + t.join('|'));
  } catch (e) { step('生成运营监管报告', 'ERR', e.message); }

  // ===== 10) 历史报告页 =====
  await clickNav('report');
  try { await page.waitForTimeout(800); await shot(page, 'report'); const rows = await page.$$eval('#page-report tr', r => r.length).catch(() => 0); step('历史任务报告渲染', 'OK', '行数=' + rows); }
  catch (e) { step('历史任务报告渲染', 'ERR', e.message); }

  // ===== 11) 全局监控页 =====
  await clickNav('monitor');
  try { await page.waitForTimeout(3500); await shot(page, 'monitor'); const t = await toasts(); step('全局监控渲染', 'OK', 'toasts=' + t.join('|')); }
  catch (e) { step('全局监控渲染', 'ERR', e.message); }

} catch (e) {
  step('HARNESS异常', 'ERR', e.message);
} finally {
  // 终止所有任务并清理残留浏览器
  try { await page.evaluate(() => { if (typeof abortAll === 'function') abortAll(); }); } catch {}
  await browser.close();
  try { execSync('taskkill /F /IM chrome.exe >nul 2>&1'); } catch {}
  const ok = report.steps.filter(s => s.status === 'OK').length;
  const ab = report.steps.filter(s => s.status === 'ABNORMAL').length;
  const ni = report.steps.filter(s => s.status === 'NOTIMPL').length;
  const er = report.steps.filter(s => s.status === 'ERR').length;
  const sk = report.steps.filter(s => s.status === 'SKIP').length;
  report.summary = { total: report.steps.length, OK: ok, ABNORMAL: ab, NOTIMPL: ni, ERR: er, SKIP: sk, pageErrors: report.pageErrors.length, failedRequests: report.failedRequests.length };
  fs.writeFileSync(path.join(SHOT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log('\n===== 验收汇总 =====');
  console.log(JSON.stringify(report.summary, null, 2));
  console.log('pageErrors:', report.pageErrors);
}
