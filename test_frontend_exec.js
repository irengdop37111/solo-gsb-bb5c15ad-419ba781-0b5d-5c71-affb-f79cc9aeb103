/* 轻量 DOM 桩：加载真实 static/app.js，驱动执行记录 UI 全流程。
 * 运行：node test_frontend_exec.js（无需浏览器 / 第三方依赖） */
"use strict";
process.on("unhandledRejection", (e) => { console.error("UNHANDLED:", e); process.exit(2); });
const fs = require("fs");
const path = require("path");

// ---- 极简 DOM/事件桩（仅实现 app.js 用到的接口） ----
const listeners = {};
function makeEl(tag = "div") {
  const el = {
    tagName: tag, value: "", textContent: "", innerHTML: "", className: "",
    style: {}, dataset: {}, disabled: false, checked: false,
    width: 0, height: 0, clientWidth: 900,
    children: [], parentNode: null,
    addEventListener(type, fn) { (listeners[this._uid + ":" + type] ||= []).push(fn); },
    removeEventListener() {},
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    classList: null, // 下方创建，需闭包引用 el 以同步 className
    setAttribute() {}, getAttribute() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 900, height: 400 }; },
    getContext() {
      // canvas 2d context 桩：所有绘图方法为空操作，渐变返回桩对象
      const gradient = { addColorStop() {} };
      return new Proxy({}, {
        get: (t, k) => {
          if (k === "canvas") return el;
          if (k in t) return t[k];
          if (k === "createLinearGradient") return () => gradient;
          return () => {};
        },
        set: (t, k, v) => { t[k] = v; return true; },
      });
    },
    click() { emit(this, "click"); },
    _uid: ++uidCounter,
  };
  el.classList = {
    _set: new Set(),
    sync() { el.className = Array.from(this._set).join(" "); },
    add(...cs) { cs.forEach((c) => this._set.add(c)); this.sync(); },
    remove(...cs) { cs.forEach((c) => this._set.delete(c)); this.sync(); },
    contains(c) { return this._set.has(c); },
    toggle(c) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); this.sync(); },
  };
  return el;
}
let uidCounter = 0;

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
  // 模拟 DOM：事件从 target 沿 parentNode 冒泡，逐级触发委托监听
  let node = ev.target || el;
  ev.target = node;
  const chain = [];
  for (let cur = node; cur; cur = cur.parentNode) chain.push(cur);
  chain.forEach((cur) => {
    (listeners[cur._uid + ":" + type] || []).forEach((fn) => fn(ev));
    if (type === "click" && typeof cur.onclick === "function") cur.onclick(ev);
  });
}

// 预置关键选择器
const els = {
  winStart: $("#winStart"), winEnd: $("#winEnd"),
  autoRecompute: $("#autoRecompute"), scenarioSelect: $("#scenarioSelect"),
  scenarioName: $("#scenarioName"), scheduleTable: $("#scheduleTable"),
  execBox: $("#execBox"), execSummary: $("#execSummary"), execHint: $("#execHint"),
  btnExecEdit: $("#btnExecEdit"), execModal: $("#execModal"),
  execModalScenario: $("#execModalScenario"), execFormTable: $("#execFormTable"),
  execFormError: $("#execFormError"), toast: $("#toast"),
  gantt: $("#gantt"), statusDot: $("#statusDot"), statusText: $("#statusText"),
  statusStats: $("#statusStats"), conflictBox: $("#conflictBox"), legend: $("#legend"),
  panelLeft: $(".panel-left"),
};
const tableBody = makeEl();
els.scheduleTable.querySelector = () => tableBody;
// 编辑器输入控件挂到 panel-left 下，模拟事件冒泡到委托父节点
els.panelLeft.appendChild(els.winStart);
els.panelLeft.appendChild(els.winEnd);
els.panelLeft.appendChild(els.autoRecompute);
const formBody = makeEl();
formBody.rows = [];
formBody.querySelectorAll = (s) => s === "tr" ? formBody.rows : [];
els.execFormTable.querySelector = (s) => (s === "tbody" ? formBody : makeEl());
// 委托事件转发到 tbody（与真实 DOM 冒泡等价）
els.execFormTable.addEventListener = (type, fn) => formBody.addEventListener(type, fn);
els.execBox.querySelector = () => null;

// 构造一行弹窗表单（select + 两个 datetime input + 原因 input），事件走真实委托
function makeFormRow(i, nid) {
  const tr = makeEl("tr");
  tr.dataset.execrow = nid;
  formBody.appendChild(tr);
  const mk = (k, value) => {
    const inp = makeEl("input");
    inp.dataset = { exi: String(i), exk: k };
    inp.value = value;
    inp.disabled = false;
    return inp;
  };
  const sel = makeEl("select");
  sel.dataset = { exi: String(i), exk: "executed" };
  sel.value = "true";
  const start = mk("actual_start", "");
  const end = mk("actual_end", "");
  const reason = mk("reason", "");
  reason.disabled = true;
  tr._inputs = { executed: sel, actual_start: start, actual_end: end, reason };
  [sel, start, end, reason].forEach((inp) => tr.appendChild(inp));
  tr.querySelectorAll = () => [sel, start, end, reason];
  return tr;
}
formBody.attachRows = () => {
  formBody.rows = [makeFormRow(0, "n1"), makeFormRow(1, "n2")];
};

global.document = {
  querySelector: $,
  querySelectorAll: () => [],
  createElement: (t) => makeEl(t),
};
global.window = {
  addEventListener() {}, SchedulerApp: null,
  devicePixelRatio: 1,
};
global.CanvasRenderingContext2D = function () {};
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
global.confirm = () => true;
// 保留 Node 原生 setTimeout/clearTimeout（app.js 的防抖重算依赖真实定时器）

// ---- 模拟后端（与真实 API 同语义的最小实现）；app.js 加载时 init() 即会调用 ----
const scenarios = new Map();
let nextId = 1;
const recordsStore = new Map();
const SCEN = {
  windowStart: "2026-09-23T22:00", windowEnd: "2026-09-24T06:00",
  resources: [{ name: "DBA", capacity: 1 }],
  nodes: [
    { id: "n1", name: "任务1", duration_minutes: 30, resources: { DBA: 1 }, fixed_start: null },
    { id: "n2", name: "任务2", duration_minutes: 20, resources: {}, fixed_start: null },
  ],
  edges: [{ source: "n1", target: "n2" }], blackouts: [], uid: 3,
};

function scheduleResult() {
  // n1: 22:00-22:30，n2: 22:30-22:50
  return {
    feasible: true,
    items: [
      { id: "n1", name: "任务1", start: "2026-09-23T22:00", end: "2026-09-23T22:30",
        start_label: "09-23 22:00", end_label: "09-23 22:30", duration_minutes: 30,
        fixed: false, resources: { DBA: 1 }, predecessors: [], successors: ["n2"] },
      { id: "n2", name: "任务2", start: "2026-09-23T22:30", end: "2026-09-23T22:50",
        start_label: "09-23 22:30", end_label: "09-23 22:50", duration_minutes: 20,
        fixed: false, resources: {}, predecessors: ["n1"], successors: [] },
    ],
    order: ["n1", "n2"], unscheduled: [], conflicts: [],
    stats: { total: 2, scheduled: 2, conflicts: 0, makespan_minutes: 50 },
    window: { start: "2026-09-23T22:00", end: "2026-09-24T06:00" },
  };
}

function mockFetch(url, opts = {}) {
  const method = (opts.method || "GET").toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : null;
  const json = (data, status = 200) => ({
    ok: status < 400, status,
    json: async () => data, blob: async () => ({}),
  });
  if (url === "/api/schedule") return json(scheduleResult());
  if (url === "/api/scenarios" && method === "POST") {
    const id = nextId++;
    scenarios.set(id, { id, name: body.name, data: SCEN,
                        created_at: "t", updated_at: "t" });
    return json({ id, name: body.name, updated: false }, 201);
  }
  let m = url.match(/^\/api\/scenarios\/(\d+)$/);
  if (m && method === "GET") {
    const s = scenarios.get(+m[1]);
    return s ? json({ ...s, data: SCEN }) : json({ detail: "场景不存在" }, 404);
  }
  m = url.match(/^\/api\/scenarios\/(\d+)\/execution$/);
  if (m) {
    const sid = +m[1];
    if (!scenarios.has(sid)) return json({ detail: "场景不存在" }, 404);
    if (method === "GET") {
      return json(recordsStore.get(sid) || { scenario_id: sid, complete: false,
                                             updated_at: null, records: [] });
    }
    if (method === "PUT") {
      const errs = [];
      const ids = new Set();
      body.records.forEach((r) => {
        if (!SCEN.nodes.some((n) => n.id === r.node_id))
          errs.push({ node_id: r.node_id, message: `任务 ${r.node_id} 引用无效` });
        if (ids.has(r.node_id))
          errs.push({ node_id: r.node_id, message: `任务 ${r.node_id} 多条` });
        ids.add(r.node_id);
        if (r.executed) {
          if (!r.actual_start || !r.actual_end)
            errs.push({ node_id: r.node_id, message: `任务 ${r.node_id} 缺时间` });
          else if (new Date(r.actual_end) < new Date(r.actual_start))
            errs.push({ node_id: r.node_id, message: `任务 ${r.node_id} 结束早于开始` });
        } else if (!r.reason) {
          errs.push({ node_id: r.node_id, message: `任务 ${r.node_id} 未执行缺原因` });
        }
      });
      if (ids.size !== SCEN.nodes.length)
        errs.push({ node_id: "", message: "缺少执行记录" });
      if (errs.length)
        return json({ detail: { message: "整次拒绝", errors: errs } }, 422);
      recordsStore.set(sid, { scenario_id: sid, complete: true, updated_at: "now",
                              records: body.records });
      return json({ scenario_id: sid, saved: body.records.length, updated_at: "now" });
    }
  }
  if (url === "/api/scenarios") {
    return json(Array.from(scenarios.values()).map((s) => ({ id: s.id, name: s.name,
                                                            created_at: "t", updated_at: "t" })));
  }
  return json({ detail: "unhandled " + url }, 500);
}
global.fetch = async (u, o) => mockFetch(u, o);

// 加载真实 app.js
const code = fs.readFileSync(path.join(__dirname, "app", "static", "app.js"), "utf8");
new Function(code)();
const App = global.window.SchedulerApp;

let passed = 0;
const check = (name, cond, extra = "") => {
  if (!cond) { console.error(`FAIL: ${name}`, extra); process.exit(1); }
  passed++;
  console.log("  ok - " + name);
};

// ---- 流程 1：未选择场景时登记按钮禁用 ----
check("初始 execBox 为引导提示", els.execBox.innerHTML.includes("恢复一个已保存场景"));
check("登记按钮初始禁用", els.btnExecEdit.disabled === true);

// ---- 流程 2：保存场景（设置 currentScenarioId），拉取空记录 ----
(async () => {
  els.scenarioName.value = "前端联调场景";
  await emit($("#btnSave"), "click");
  await tick();
  check("保存后按钮可用", els.btnExecEdit.disabled === false);
  check("保存后提示去登记", els.execBox.innerHTML.includes("尚无执行记录"), els.execBox.innerHTML);

  // ---- 流程 3：打开登记弹窗 ----
  await emit(els.btnExecEdit, "click");
  await tick();
  check("弹窗已显示（hidden 被移除）", !els.execModal.className.includes("hidden"));
  check("弹窗标题带场景名", els.execModalScenario.textContent === "前端联调场景");

  // renderExecForm 已把两行 innerHTML 写入桩；用桩行接管真实委托事件
  formBody.attachRows();

  // ---- 流程 4：默认时间全空 -> 点保存：客户端拦截 ----
  await emit($("#execBtnSave"), "click");
  await tick();
  check("客户端拦截：错误框出现", !els.execFormError.className.includes("hidden"),
        els.execFormError.className);
  check("错误框提示整次拒绝", els.execFormError.innerHTML.includes("整次保存被拒绝"));
  check("错误列出 n1、n2 缺时间",
        els.execFormError.innerHTML.includes("n1") && els.execFormError.innerHTML.includes("n2"));
  check("整次拒绝后服务端无记录", recordsStore.get(1) === undefined);

  // ---- 流程 5：填入 n1 实际时间；n2 切为未执行但不写原因 ----
  const rows = formBody.rows;
  rows[0]._inputs.actual_start.value = "2026-09-23T22:05";
  await emit(rows[0]._inputs.actual_start, "input");
  rows[0]._inputs.actual_end.value = "2026-09-23T22:40";
  await emit(rows[0]._inputs.actual_end, "input");
  // n1 结束早于开始的客户端校验先验证一次
  rows[0]._inputs.actual_end.value = "2026-09-23T21:00";
  await emit(rows[0]._inputs.actual_end, "input");
  await emit($("#execBtnSave"), "click");
  await tick();
  check("结束早于开始被客户端拦截",
        els.execFormError.innerHTML.includes("结束时间早于开始时间"),
        els.execFormError.innerHTML);
  rows[0]._inputs.actual_end.value = "2026-09-23T22:40";
  await emit(rows[0]._inputs.actual_end, "input");

  // n2 切换为未执行（触发 renderExecForm 重建 innerHTML —— 桩中重新接管行）
  rows[1]._inputs.executed.value = "false";
  await emit(rows[1]._inputs.executed, "change");
  await tick();
  // renderExecForm 重写了 innerHTML；重新附着桩行（状态已写入 app 私有 execFormNodes）
  formBody.attachRows();
  formBody.rows[1]._inputs.executed.value = "false"; // 新桩行同步 UI 值

  // 未执行但原因空 -> 客户端拦截
  await emit($("#execBtnSave"), "click");
  await tick();
  check("未执行缺原因被客户端拦截",
        els.execFormError.innerHTML.includes("未填写原因"),
        els.execFormError.innerHTML);

  // 填入原因后再保存 -> 200，弹窗关闭，面板刷新出偏差
  formBody.rows[1]._inputs.reason.disabled = false;
  formBody.rows[1]._inputs.reason.value = "备用网络未到位";
  await emit(formBody.rows[1]._inputs.reason, "input");
  await emit($("#execBtnSave"), "click");
  await tick();

  check("保存成功后弹窗关闭", els.execModal.className.includes("hidden"));
  check("服务端已写入两条记录", recordsStore.get(1)?.records?.length === 2);

  const summary = els.execSummary.innerHTML;
  const html = els.execBox.innerHTML;
  check("汇总：已执行 1/2", summary.includes("已执行 1/2"), summary);
  check("汇总：未执行 1 且显示原因",
        summary.includes("未执行 1") && summary.includes("备用网络未到位"), summary);
  check("n1 开始偏差 +5 分（晚于计划）",
        html.includes("+5") && html.includes("晚于计划"), html.slice(0, 600));
  check("n1 时长偏差 +5 分（超时）", html.includes("超时"), html);
  check("n2 行显示未执行标记", html.includes("未执行"), html);

  // ---- 流程 6：偏差方向（提前/时长缩短）渲染 delta-early ----
  // 直接通过刷新路径验证另一份记录：n1 21:55-22:20（开始 -5，时长 25=-5）
  await mockFetch("/api/scenarios/1/execution", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ records: [
      { node_id: "n1", executed: true, actual_start: "2026-09-23T21:55",
        actual_end: "2026-09-23T22:20", reason: null },
      { node_id: "n2", executed: true, actual_start: "2026-09-23T22:30",
        actual_end: "2026-09-23T22:50", reason: null },
    ] }),
  });
  await App.loadInstance(SCEN, "前端联调场景", 1);
  await tick(); await tick();
  const html2 = els.execBox.innerHTML;
  check("提前开始渲染 -5 分（早于计划）",
        html2.includes("-5") && html2.includes("早于计划"), html2.slice(0, 600));
  check("时长缩短渲染（提前结束）", html2.includes("提前结束"), html2);
  check("全部已执行 chip", els.execSummary.innerHTML.includes("全部任务均已执行"));

  // ---- 流程 7：未保存改动时禁止登记（dirty 门禁）----
  check("干净状态无 dirty 警告", !els.execHint.innerHTML.includes("未保存改动"));
  // 模拟窗口被改动（app.js 在 .panel-left 上做事件委托，target 为 winStart）
  els.autoRecompute.checked = true;
  els.winStart.value = "2026-09-23T21:00";
  emit(els.panelLeft, "input", { target: els.winStart });
  await new Promise((r) => setTimeout(r, 260));
  check("改动后出现 dirty 警告", els.execHint.innerHTML.includes("未保存改动"));
  await emit(els.btnExecEdit, "click");
  check("dirty 时登记被门禁拦截（弹窗仍关闭）",
        els.execModal.className.includes("hidden"));

  console.log(`\n前端流程全部 ${passed} 项检查通过 ✔`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

function tick() { return new Promise((r) => setImmediate(r)); }
