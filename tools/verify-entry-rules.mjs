// ===== 专项验证：#1578 入站须知（开屏公告前的一次性入站确认层） =====
// 用例组：
//   A 首次打开（未通过）：须知整页在场、.splash 挂 eqz-active、.splash-box 被收起、进度 0/8
//   B 答题交互：单选覆盖、重点已选项不抖动、进度实时
//   C 有错/漏答提交：结果页列出「未作答」与「本题只有 1 个正确答案」；「重新确认」清空重答
//   D 全对提交：须知层移除、开屏公告恢复可见、根键 xy-home-v2:rules-notice-pass 落盘
//   E 只答一次：刷新后不再出现；reset（模拟改版）后重新出现
//   F 24 题入站问卷不受影响：mochiEntryQuizGate 仍在、mochiEntryQuizPassed()===false、entry-quiz-pass 键未被写
// 注：无头环境需伪装 UA（去 Headless）＋ webdriver=false，否则入口闸的自动化放行会跳过整层（同 #1576 探针坑位）。
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, normalize, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = normalize(dirname(fileURLToPath(import.meta.url)) + '/..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const candidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const chromePath = candidates.find((p) => { try { return statSync(p).isFile(); } catch (e) { return false; } });
if (!chromePath) { console.error('找不到 Chrome/Edge'); process.exit(1); }

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
let cssFiles = [], jsFiles = [];
{
  const bm = readFileSync(join(root, 'build.mjs'), 'utf8');
  cssFiles = (bm.match(/const cssFiles = \[([^\]]+)\]/) || [])[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  jsFiles = (bm.match(/const jsFiles = \[([^\]]+)\]/) || [])[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}
if (!jsFiles.includes('entry-rules.js')) { console.error('✗ entry-rules.js 未登记进 build.mjs jsFiles'); process.exit(1); }
let testHtml = readFileSync(join(root, 'src/template.html'), 'utf8');
testHtml = testHtml.replace('/*__STYLES__*/', cssFiles.map((f) => readFileSync(join(root, 'src/css', f), 'utf8')).join('\n'));
testHtml = testHtml.replace('/*__SCRIPTS__*/', jsFiles.map((f) => '(function () { try {\n' + readFileSync(join(root, 'src/js', f), 'utf8') + '\n} catch (__e) { try { console.error("[JS] ' + f + '", __e && __e.message || __e); } catch (x) {} if (window.__jsErrors) window.__jsErrors.push(String(__e && __e.message || __e)); } })();').join('\n'));
testHtml = testHtml.split('__BUILD_INFO__').join('verify-entry-rules').split('__BUILD_TS__').join(String(Date.now())).split('__APP_VERSION__').join('v0.0.0');
const tmpRoot = join(process.env.TEMP || '/tmp', 'mochi-entry-rules-' + Date.now());
mkdirSync(tmpRoot, { recursive: true });
writeFileSync(join(tmpRoot, 'index.html'), testHtml);
const server = createServer((req, res) => {
  try {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    let p = normalize(join(tmpRoot, rel));
    if (!p.startsWith(tmpRoot)) { res.writeHead(403); res.end(); return; }
    let hit = false;
    try { hit = statSync(p).isFile(); } catch (e) {}
    if (!hit) {
      p = normalize(join(root, rel));
      if (!p.startsWith(root)) { res.writeHead(403); res.end(); return; }
      try { hit = statSync(p).isFile(); } catch (e) {}
    }
    if (!hit) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': types[extname(p)] || 'application/octet-stream' });
    res.end(readFileSync(p));
  } catch (e) { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const baseUrl = 'http://127.0.0.1:' + server.address().port;
const cdpPort = Number(process.env.MOCHI_CDP_PORT) || (9700 + Math.floor(Math.random() * 100));
const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + join(process.env.TEMP || '/tmp', 'mochi-entry-rules-' + Date.now()), '--remote-debugging-port=' + cdpPort, 'about:blank'], { stdio: 'ignore' });

let ws = null, msgId = 0; const pend = new Map();
async function cdpConnect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + cdpPort + '/json')).json();
      const page = list.find((t) => t.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
        return;
      }
    } catch (e) {}
    await sleep(150);
  }
  throw new Error('无法连接');
}
function cdp(method, params = {}) { const id = ++msgId; return new Promise((res) => { pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); }); }
async function evalJs(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r && r.exceptionDetails) { console.error('JS 异常:', JSON.stringify(r.exceptionDetails).slice(0, 400)); return null; }
  return r && r.result ? r.result.value : null;
}
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' —— ' + JSON.stringify(extra) : '')); }
}
async function navigate(url) { await cdp('Page.navigate', { url }); await sleep(3500); }
// 伪装成普通桌面 Chrome（去 Headless 字样）＋ webdriver=false——入口闸的自动化放行按这两项判定
await cdpConnect();
await cdp('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' });
await cdp('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(navigator,'webdriver',{get:function(){return false;}});" });
await cdp('Page.enable');

const CORRECT = [1, 1, 1, 0, 2, 0, 1, 0];
const clickOpt = (i, j) => evalJs(`(function(){var o=document.querySelector('#entry-rules-page .eqz-opt[data-i="${i}"][data-j="${j}"]');if(!o)return 'no-opt';o.click();return 'ok';})()`);
const GATE = `(function(){return {
  page: !!document.getElementById('entry-rules-page'),
  active: !!document.querySelector('#splash.eqz-active'),
  boxHidden: (document.getElementById('splash-box') ? getComputedStyle(document.getElementById('splash-box')).display === 'none' : null),
  progress: (document.getElementById('nrz-progress') || {}).textContent || null,
  resultShown: (function(){var v=document.getElementById('nrz-view-result');return v? !v.hidden : null;})(),
  resultText: (function(){var v=document.getElementById('nrz-view-result');return v? v.textContent : '';})(),
  selCount: document.querySelectorAll('#entry-rules-page .eqz-opt.is-sel').length,
  passKey: (function(){try{return localStorage.getItem('xy-home-v2:rules-notice-pass');}catch(e){return null;}})(),
  quiz24Passed: typeof window.mochiEntryQuizPassed === 'function' ? window.mochiEntryQuizPassed() : null,
  quiz24Gate: typeof window.mochiEntryQuizGate === 'function',
  quiz24Key: (function(){try{return localStorage.getItem('xy-home-v2:entry-quiz-pass');}catch(e){return null;}})(),
  jsErr: (window.__jsErrors || []).length
};})()`;

// ===== A/B：首次打开 + 答题交互 =====
console.log('A/B 首次打开与答题交互');
await navigate(baseUrl + '/index.html');
let s = await evalJs(GATE);
ok('A1 须知整页在场', s.page === true);
ok('A2 .splash 挂 eqz-active（同层收起方案，无新遮罩）', s.active === true);
ok('A3 .splash-box 被收起（公告在须知层下不可见）', s.boxHidden === true);
ok('A4 初始进度 已答 0 / 8', s.progress === '已答 0 / 8');
ok('A0 页面无 JS 异常', s.jsErr === 0, s.jsErr);
s = await evalJs(GATE); // 提交前状态复查
ok('B1 第1题选B（正确项）→ is-sel 且进度 1/8', (await clickOpt(0, 1)) === 'ok');
let s2 = await evalJs(GATE);
ok('B2 选中态 1 个、进度 1/8', s2.selCount === 1 && s2.progress === '已答 1 / 8', s2);
await clickOpt(0, 1);
s2 = await evalJs(GATE);
ok('B3 重点已选单选项不抖动（仍 1 个选中）', s2.selCount === 1 && s2.progress === '已答 1 / 8', s2);
await clickOpt(0, 0); // 改选 A（单选覆盖，后面 C 组当错答用）
s2 = await evalJs(GATE);
ok('B4 单选覆盖：改选 A 后仍只有 1 个选中', s2.selCount === 1 && s2.progress === '已答 1 / 8', s2);

// ===== C：漏答＋错答提交 → 结果页 → 重新确认 =====
console.log('C 漏答/错答提交与重新确认');
for (let i = 1; i < 8; i++) { if (i !== 4) await clickOpt(i, CORRECT[i]); } // 第2题起全对，第5题(i=4)留空
await evalJs(`document.getElementById('nrz-confirm').click(); true`);
s = await evalJs(GATE);
ok('C1 提交后跳结果页', s.resultShown === true);
ok('C2 报「还有 2 题需要重新确认」', s.resultText.indexOf('还有 2 题需要重新确认') > -1, s.resultText.slice(0, 80));
ok('C3 含「未作答」（第5题）', s.resultText.indexOf('未作答') > -1);
ok('C4 含「本题只有 1 个正确答案」（第1题错答，不泄露答案）', s.resultText.indexOf('本题只有 1 个正确答案') > -1);
ok('C5 结果页不含任何正确答案字面', s.resultText.indexOf('正常使用，按站内规则来') === -1);
await evalJs(`document.getElementById('nrz-retry').click(); true`);
s = await evalJs(GATE);
ok('C6 重新确认＝清空重答（回答题页、0 选中、进度 0/8）', s.resultShown === false && s.selCount === 0 && s.progress === '已答 0 / 8', s);

// ===== D：全对提交 → 放行 =====
console.log('D 全对提交放行');
for (let i = 0; i < 8; i++) await clickOpt(i, CORRECT[i]);
await evalJs(`document.getElementById('nrz-confirm').click(); true`);
s = await evalJs(GATE);
ok('D1 须知层移除', s.page === false);
ok('D2 .splash 的 eqz-active 已摘除', s.active === false);
ok('D3 开屏公告恢复可见', s.boxHidden === false);
ok('D4 放行根键落盘（v=2026-10-22）', typeof s.passKey === 'string' && s.passKey.indexOf('"v":"2026-10-22"') > -1, s.passKey);
ok('F1 24题问卷闸未被放行（mochiEntryQuizPassed()===false）', s.quiz24Passed === false, s.quiz24Passed);
ok('F2 24题问卷闸本体仍在（mochiEntryQuizGate）', s.quiz24Gate === true);
ok('F3 24题问卷放行键未被误写', s.quiz24Key === null, s.quiz24Key);

// ===== E：只答一次（刷新不重现；reset 模拟改版后重现） =====
console.log('E 只答一次');
await navigate(baseUrl + '/index.html');
s = await evalJs(GATE);
ok('E1 刷新后须知不再出现', s.page === false && s.active === false);
ok('E2 刷新后公告直接可见', s.boxHidden === false);
// 模拟「须知改版」：写入更旧版本记录（LS＋IDB 双写；reset 只清 LS 会被 idbRestore 从 IDB 回填，
// 与 entry-quiz 的 reset 同一口径）。记录版本 < 本页版本＝拦下重答（#1572 版本比较语义）。
await evalJs(`(function(){var old=JSON.stringify({t:Date.now(),v:'2026-01-01'});try{if(window.xyStore)window.xyStore('xy-home-v2').set('rules-notice-pass',old);}catch(e){}try{localStorage.setItem('xy-home-v2:rules-notice-pass',old);}catch(e){}return true;})()`);
await navigate(baseUrl + '/index.html');
s = await evalJs(GATE);
ok('E3 记录版本更旧（模拟改版）后须知重新出现', s.page === true && s.active === true, s);

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
chrome.kill();
server.close();
process.exit(fail ? 1 : 0);
