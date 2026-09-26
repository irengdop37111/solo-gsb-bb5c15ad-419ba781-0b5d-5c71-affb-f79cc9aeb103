/* 轻量 DOM 桩：加载真实 static/audit.js，驱动跨场景资源核查弹窗全流程。
 * 运行：node test_frontend_audit.js（无需浏览器 / 第三方依赖） */
"use strict";
process.on("unhandledRejection", (e) => { console.error("UNHANDLED:", e); process.exit(2); });
const fs = require("fs");
const path = require("path");

// ---- 极简 DOM/事件桩（仅实现 audit.js 用到的接口） ----
const listeners = {};
let uidCounter = 0;
function makeEl(tag = "div") {
  const el = {
    tagName: tag, value: "", textContent: "", innerHTML: "", className: "",
    style: {}, dataset: {}, disabled: false, checked: false,
    children: [], parentNode: null,
    addEventListener(type, fn) { (listeners[this._uid + ":" + type] ||= []).push(fn); },
    removeEventListener() {},
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    classList: null,
    setAttribute() {}, getAttribute() { return null; },
    click() { emit(this, "click"); },
    _uid: ++uidCounter,
  };
  el.classList = {
    _set: new Set(),
    sync() { el.className = Array.from(this._set).join(" "); },
    add(...cs) { cs.forEach((c) => this._set.add(c)); this.sync(); },
    remove(...cs) { cs.forEach((c) => this._set.delete(c)); this.sync(); },
    contains(c) { return this._set.has(c); },
  };
  return el;
}

const registry = new Map();
function $(sel) {
  if (!registry.has(sel)) {
    const el = makeEl(sel[0] === "#" ? "input" : "div");
    if (sel[0] === "#") el.id = sel.slice(1);
    registry.set(sel, el);
  }
  return registry.get(sel);
}
function emit(el, type, ev = {}) {
  let node = ev.target || el;
  ev.target = node;
  const chain = [];
  for (let cur = node; cur; cur = cur.parentNode) chain.push(cur);
  chain.forEach((cur) => {
    (listeners[cur._uid + ":" + type] || []).forEach((fn) => fn(ev));
    if (type === "click" && typeof cur.onclick === "function") cur.onclick(ev);
  });
}

const els = {
  modal: $("#auditModal"), scnList: $("#auditScenarioList"),
  capTable: $("#auditCapTable"), btnAddCap: $("#auditBtnAddCap"),
  btnPrefill: $("#auditBtnPrefill"), btnRun: $("#auditBtnRun"),
  result: $("#auditResult"), btnAudit: $("#btnAudit"), btnClose: $("#auditBtnClose"),
};
els.modal.classList.add("hidden");

// ---- toast 桩（audit.js 经 window.SchedulerApp.toast 调用） ----
const toasts = [];
global.window = { addEventListener() {}, SchedulerApp: null };
global.window.SchedulerApp = { toast: (msg, isErr) => toasts.push({ msg, isErr }) };
global.document = { querySelector: $, querySelectorAll: () => [], createElement: (t) => makeEl(t) };

// ---- 模拟后端 ----
const SCEN_LIST = [
  { id: 1, name: "夜间升级", created_at: "t", updated_at: "2026-09-26T10:00:00" },
  { id: 2, name: "周末迁移", created_at: "t", updated_at: "2026-09-26T11:00:00" },
];
const SCEN_DETAIL = {
  1: { id: 1, name: "夜间升级", data: { resources: [{ name: "DBA", capacity: 1 }], nodes: [] } },
  2: { id: 2, name: "周末迁移", data: { resources: [{ name: "DBA", capacity: 2 }], nodes: [] } },
};
let auditReport = null;   // 各流程阶段替换
let auditBody = null;     // 记录核查请求体

function mockFetch(url, opts = {}) {
  const method = (opts.method || "GET").toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : null;
  const json = (data, status = 200) => ({
    ok: status < 400, status, json: async () => data,
  });
  if (url === "/api/scenarios" && method === "GET") return json(SCEN_LIST);
  let m = url.match(/^\/api\/scenarios\/(\d+)$/);
  if (m && method === "GET") return json(SCEN_DETAIL[+m[1]] || { detail: "场景不存在" },
                                         SCEN_DETAIL[+m[1]] ? 200 : 404);
  if (url === "/api/resource-audit" && method === "POST") {
    auditBody = body;
    return json(auditReport);
  }
  return json({ detail: "unhandled " + url }, 500);
}
global.fetch = async (u, o) => mockFetch(u, o);

// ---- 加载真实 audit.js ----
const code = fs.readFileSync(path.join(__dirname, "app", "static", "audit.js"), "utf8");
new Function(code)();

let passed = 0;
const check = (name, cond, extra = "") => {
  if (!cond) { console.error(`FAIL: ${name}`, extra); process.exit(1); }
  passed++;
  console.log("  ok - " + name);
};
const tick = () => new Promise((r) => setImmediate(r));
// 复选框作为列表子元素，change 事件沿 parentNode 冒泡到委托监听（与真实 DOM 等价）
const checkScn = (id, checked) => {
  const cb = makeEl("input");
  cb.dataset = { auditScn: String(id) };
  cb.checked = checked;
  els.scnList.appendChild(cb);
  emit(cb, "change");
};

(async () => {
  // ---- 流程 1：打开弹窗，场景列表渲染 ----
  await emit(els.btnAudit, "click");
  await tick(); await tick();
  check("弹窗已打开", !els.modal.className.includes("hidden"));
  check("场景列表渲染两项", els.scnList.innerHTML.includes("夜间升级")
        && els.scnList.innerHTML.includes("周末迁移"), els.scnList.innerHTML);
  check("初始已选 0", els.scnList.innerHTML.includes("已选 <b>0</b>"));

  // ---- 流程 2：未选够场景直接核查 → 客户端拦截 ----
  await emit(els.btnRun, "click");
  await tick();
  check("少于 2 个场景被拦截", toasts.some((t) => t.isErr && t.msg.includes("至少勾选 2 个")),
        JSON.stringify(toasts));

  // ---- 流程 3：勾选两个场景 → 预填共享容量（取各场景最大值） ----
  checkScn(1, true);
  checkScn(2, true);
  check("已选计数变为 2", els.scnList.innerHTML.includes("已选 <b>2</b>"),
        els.scnList.innerHTML.slice(-200));
  await emit(els.btnPrefill, "click");
  await tick(); await tick();
  const capHtml = $("#auditCapTable tbody").innerHTML;
  check("预填出 DBA 行", capHtml.includes("DBA"), capHtml);
  check("容量取各场景最大值 2", capHtml.includes('value="2"'), capHtml);
  check("预填有提示", toasts.some((t) => t.msg.includes("预填")), JSON.stringify(toasts));

  // ---- 流程 4：执行核查 → 渲染超限时段（资源/峰值/场景/任务） ----
  auditReport = {
    ok: false, complete: true,
    shared_capacities: { DBA: 2 },
    scenarios: [
      { id: 1, name: "夜间升级", ok: true, feasible: true, error: null,
        scheduled: 2, total: 2, unscheduled: [], diagnostics: [],
        window: { start: "2026-09-26T22:00", end: "2026-09-27T06:00" } },
      { id: 2, name: "周末迁移", ok: true, feasible: true, error: null,
        scheduled: 1, total: 1, unscheduled: [], diagnostics: [],
        window: { start: "2026-09-26T22:00", end: "2026-09-27T06:00" } },
    ],
    conflicts: [{
      resource: "DBA", start: "2026-09-26T22:30", end: "2026-09-26T23:00",
      start_label: "09-26 22:30", end_label: "09-26 23:00", peak: 3, capacity: 2,
      tasks: [
        { scenario_id: 1, scenario_name: "夜间升级", node_id: "a", task_name: "主备切换",
          amount: 1, start: "2026-09-26T22:00", end: "2026-09-26T23:00" },
        { scenario_id: 2, scenario_name: "周末迁移", node_id: "c", task_name: "缓存重启",
          amount: 2, start: "2026-09-26T22:30", end: "2026-09-26T23:30" },
      ],
    }],
    warnings: [],
    stats: { scenarios: 2, scheduled: 3, unscheduled: 0, overlaps: 1 },
  };
  await emit(els.btnRun, "click");
  await tick(); await tick();
  check("请求体含两个场景与容量表",
        auditBody && auditBody.scenario_ids.length === 2
        && auditBody.shared_capacities.DBA === 2, JSON.stringify(auditBody));
  const html = els.result.innerHTML;
  check("红色超限横幅", html.includes("发现 1 个超限时段"), html.slice(0, 200));
  check("超限卡片含资源与峰值", html.includes("DBA") && html.includes("峰值"), html);
  check("涉及场景与任务列出",
        html.includes("夜间升级") && html.includes("主备切换")
        && html.includes("周末迁移") && html.includes("缓存重启"), html);
  check("各场景状态均为可行", (html.match(/计划可行/g) || []).length === 2, html);

  // ---- 流程 5：无超限但存在未排定 → 黄色警告（不当作无冲突） ----
  auditReport = {
    ok: true, complete: false, shared_capacities: { DBA: 2 },
    scenarios: [
      { id: 1, name: "夜间升级", ok: true, feasible: true, error: null,
        scheduled: 2, total: 2, unscheduled: [], diagnostics: [], window: null },
      { id: 2, name: "周末迁移", ok: false, feasible: false, error: null,
        scheduled: 0, total: 2, unscheduled: [{ id: "x", name: "排不下的任务" }],
        diagnostics: ["「排不下的任务」在当前维护窗口内无法排程：窗口内剩余时间不足"],
        window: null },
    ],
    conflicts: [],
    warnings: ["场景「周末迁移」计划不可行：1 个任务未排定（排不下的任务），其资源占用未计入核查，实际执行可能产生额外冲突"],
    stats: { scenarios: 2, scheduled: 2, unscheduled: 1, overlaps: 0 },
  };
  await emit(els.btnRun, "click");
  await tick(); await tick();
  const html2 = els.result.innerHTML;
  check("黄色覆盖缺口横幅", html2.includes("不能视为完全无冲突"), html2.slice(0, 300));
  check("警告列表渲染", html2.includes("覆盖缺口") && html2.includes("未计入核查"), html2);
  check("不可行场景诊断显示", html2.includes("窗口内剩余时间不足"), html2);
  check("未排定任务 chip", html2.includes("排不下的任务"), html2);

  // ---- 流程 6：全部可行且无超限 → 绿色通过 ----
  auditReport = {
    ok: true, complete: true, shared_capacities: { DBA: 2 },
    scenarios: [
      { id: 1, name: "夜间升级", ok: true, feasible: true, error: null,
        scheduled: 2, total: 2, unscheduled: [], diagnostics: [], window: null },
      { id: 2, name: "周末迁移", ok: true, feasible: true, error: null,
        scheduled: 1, total: 1, unscheduled: [], diagnostics: [], window: null },
    ],
    conflicts: [], warnings: [],
    stats: { scenarios: 2, scheduled: 3, unscheduled: 0, overlaps: 0 },
  };
  await emit(els.btnRun, "click");
  await tick(); await tick();
  check("绿色通过横幅", els.result.innerHTML.includes("未发现超限"), els.result.innerHTML.slice(0, 200));

  // ---- 流程 7：关闭弹窗 ----
  await emit(els.btnClose, "click");
  check("弹窗已关闭", els.modal.className.includes("hidden"));

  console.log(`\n前端核查流程全部 ${passed} 项检查通过 ✔`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
