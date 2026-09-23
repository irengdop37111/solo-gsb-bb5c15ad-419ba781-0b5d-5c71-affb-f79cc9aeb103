/* 轻量 DOM 桩：加载真实 static/cross_check.js，驱动跨场景核查 UI 全流程。
 * 运行：node test_frontend_crosscheck.js（无需浏览器 / 第三方依赖） */
"use strict";
process.on("unhandledRejection", (e) => { console.error("UNHANDLED:", e); process.exit(2); });
const fs = require("fs");
const path = require("path");

// ---- 极简 DOM/事件桩 ----
const listeners = {};
function makeEl(tag = "div") {
  const el = {
    tagName: tag.toUpperCase(), value: "", textContent: "", innerHTML: "",
    style: {}, dataset: {}, disabled: false, checked: false,
    children: [], parentNode: null,
    addEventListener(type, fn) { (listeners[this._uid + ":" + type] ||= []).push(fn); },
    removeEventListener() {},
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    querySelector(sel) { return getOrMake(sel, this); },
    querySelectorAll(sel) {
      if (sel === "input") return this._inputs || this.children.filter((c) => c.tagName === "INPUT");
      return [];
    },
    classList: null,
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
let uidCounter = 0;

// 选择器注册表：#id 唯一；tag 级查询返回新建桩（带简单缓存用于固定结构）
const byId = new Map();
function getOrMake(sel, root) {
  if (!root || root === global.document) {
    if (byId.has(sel)) return byId.get(sel);
  }
  const el = makeEl(sel[0] === "#" ? "input" : sel[0] === "." ? "div" : sel);
  if (sel[0] === "#") { el.id = sel.slice(1); if (!root) byId.set(sel, el); }
  return el;
}
function $(sel) { return getOrMake(sel, null); }

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

// 预置 cross_check.js 用到的所有选择器
const neededIds = [
  "btnCrossCheck", "ccModal", "ccBtnClose", "ccScenarioList", "ccResourceTable",
  "ccBtnAddResource", "ccBtnFillResources", "ccBtnRun", "ccRunHint",
  "ccError", "ccSummary", "ccWarnings", "ccScenarioStatus", "ccResult", "toast",
];
neededIds.forEach((id) => { const e = $(("#" + id)); byId.set("#" + id, e); });
const els = Object.fromEntries(neededIds.map((id) => [id, byId.get("#" + id)]));

// tbody 单独挂出（querySelector("#ccResourceTable tbody") 在真实脚本中走 resTable.querySelector）
const resBody = makeEl("tbody");
resBody.parentOf = els.ccResourceTable;
els.ccResourceTable.querySelector = (sel) => sel === "tbody" ? resBody : makeEl(sel);
// 委托监听转到 tbody
els.ccResourceTable.addEventListener = (type, fn) => resBody.addEventListener(type, fn);

global.document = { querySelector: (s) => byId.get(s) || $(s), querySelectorAll: () => [] };
global.window = { addEventListener() {}, SchedulerApp: null };
global.setTimeout = setTimeout;
global.clearTimeout = clearTimeout;

// toast 收集
let lastToast = null;
function toast(msg, isErr) { lastToast = { msg, isErr }; }

// ---- 模拟后端 ----
let nextId = 3;
const db = new Map();
const SCEN = (id) => ({
  windowStart: "2026-09-23T22:00", windowEnd: "2026-09-24T06:00",
  resources: [{ name: "DBA", capacity: 1 }],
  nodes: [
    { id: "n" + id + "a", name: id + "-任务A", duration_minutes: 60,
      resources: { DBA: 1 }, fixed_start: "2026-09-23T22:00" },
  ],
  edges: [], blackouts: [], uid: 2,
});
db.set(1, { id: 1, name: "场景一", data: SCEN(1), updated_at: "2026-09-23T10:00:00+00:00" });
db.set(2, { id: 2, name: "场景二", data: SCEN(2), updated_at: "2026-09-23T11:00:00+00:00" });

function crossCheckResult(body) {
  const ids = [...new Set(body.scenario_ids)];
  const caps = body.capacities;
  if (ids.length < 2) return { status: 422, data: { detail: "请至少选择两个场景" } };
  if (!Object.keys(caps).length) return { status: 422, data: { detail: "请至少输入一项" } };
  const missing = ids.filter((id) => !db.has(id));
  if (missing.length) return { status: 422, data: { detail: { message: "部分场景不存在", missing_scenario_ids: missing } } };
  for (const [k, v] of Object.entries(caps)) {
    if (!(v > 0)) return { status: 422, data: { detail: "容量必须大于 0" } };
  }
  // 两个场景的任务都在 22:00-23:00 占用 DBA 1 -> 容量 1 时一段超限
  const overloads = caps.DBA <= 1 ? [{
    resource: "DBA", capacity: caps.DBA,
    start: "2026-09-23T22:00", end: "2026-09-23T23:00",
    start_label: "09-23 22:00", end_label: "09-23 23:00", duration_minutes: 60,
    peak: 2, peak_at: "2026-09-23T22:00", peak_at_label: "09-23 22:00", excess: 2 - caps.DBA,
    involved_scenarios: ids.map((id) => ({ id, name: db.get(id).name })),
    tasks: ids.map((id) => ({
      scenario_id: id, scenario_name: db.get(id).name,
      node_id: "n" + id + "a", node_name: id + "-任务A",
      start: "2026-09-23T22:00", end: "2026-09-23T23:00",
      start_label: "09-23 22:00", end_label: "09-23 23:00",
      amount: 1, at_peak: true,
    })),
  }] : [];
  return {
    status: 200,
    data: {
      capacities: caps,
      scenarios: ids.map((id) => ({
        id, name: db.get(id).name, planned: true, error: null,
        feasible: true, total: 1, scheduled: 1, fully_scheduled: true,
        unscheduled: [], conflicts: [],
      })),
      overloads,
      warnings: [],
      unchecked_resources: [],
      unused_resources: [],
      stats: { scenario_count: ids.length, resource_count: Object.keys(caps).length,
               overload_count: overloads.length, fully_checked: true },
    },
  };
}

function mockFetch(url, opts = {}) {
  const method = (opts.method || "GET").toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : null;
  const json = (data, status = 200) => ({
    ok: status < 400, status, json: async () => data,
  });
  if (url === "/api/scenarios" && method === "GET") {
    return json(Array.from(db.values()).map(({ data, ...s }) => s));
  }
  let m = url.match(/^\/api\/scenarios\/(\d+)$/);
  if (m && method === "GET") {
    const s = db.get(+m[1]);
    return s ? json(s) : json({ detail: "场景不存在" }, 404);
  }
  if (url === "/api/cross-check" && method === "POST") {
    const r = crossCheckResult(body);
    return json(r.data, r.status);
  }
  return json({ detail: "unhandled " + url }, 500);
}
global.fetch = async (u, o) => mockFetch(u, o);

// ---- 加载真实 cross_check.js（需先放好 SchedulerApp toast）----
global.window.SchedulerApp = { toast };
const code = fs.readFileSync(path.join(__dirname, "app", "static", "cross_check.js"), "utf8");
new Function(code)();
const UI = global.window.CrossCheckUI;

let passed = 0;
const check = (name, cond, extra = "") => {
  if (!cond) { console.error(`FAIL: ${name}`, extra); process.exit(1); }
  passed++;
  console.log("  ok - " + name);
};
const tick = () => new Promise((r) => setImmediate(r));
// 桩中 innerHTML 赋值不会产生真实节点，这里仅模拟“重渲染已执行”这一状态点
function renderResBody() { UI.renderResources(); resBody.innerHTML = "rendered"; }

// 构造复选框行并附着到列表（模拟真实 innerHTML 渲染后的可交互元素）
function attachScenarioChecks() {
  const rows = [];
  for (const s of Array.from(db.values()).map(({ data, ...x }) => x)) {
    const inp = makeEl("input");
    inp.type = "checkbox";
    inp.dataset = { ccScn: String(s.id) };
    inp.checked = false;
    const label = makeEl("label");
    label.appendChild(inp);
    inp.parentNode = els.ccScenarioList;
    rows.push(inp);
  }
  els.ccScenarioList._checks = rows;
  els.ccScenarioList.querySelectorAll = (sel) =>
    sel === 'input[type="checkbox"]' || sel === "input" ? rows : [];
  return rows;
}

(async () => {
  // ---- 1. 打开弹窗：加载场景列表 ----
  await emit(els.btnCrossCheck, "click");
  await tick();
  check("弹窗显示", !els.ccModal.className.includes("hidden"));
  check("列表渲染两个场景",
        els.ccScenarioList.innerHTML.includes("场景一") &&
        els.ccScenarioList.innerHTML.includes("场景二"),
        els.ccScenarioList.innerHTML);
  const checks = attachScenarioChecks();
  check("初始提示尚未选择", els.ccRunHint.textContent.includes("尚未选择场景"));

  // ---- 2. 只勾 1 个时运行 -> 客户端拒绝 ----
  checks[0].checked = true;
  await emit(checks[0], "change");
  check("勾选 1 个后 hint 更新", UI.state.selected.size === 1);
  await emit(els.ccBtnRun, "click");
  await tick();
  check("少于 2 场景被拦截", !els.ccError.className.includes("hidden")
        && els.ccError.innerHTML.includes("两个场景"), els.ccError.innerHTML);
  check("未发请求（结果仍是引导语）", els.ccResult.innerHTML.includes("半开区间"));

  // ---- 3. 勾选 2 个但无容量行 -> 拒绝 ----
  checks[1].checked = true;
  await emit(checks[1], "change");
  check("已选 2 个", UI.state.selected.size === 2);
  await emit(els.ccBtnRun, "click");
  await tick();
  check("缺容量被拦截", els.ccError.innerHTML.includes("共享资源"), els.ccError.innerHTML);

  // ---- 4. 填充资源（从所选场景资源名）----
  await emit(els.ccBtnFillResources, "click");
  await tick(); await tick();
  check("填入 DBA 行", UI.state.resources.length === 1
        && UI.state.resources[0].name === "DBA",
        JSON.stringify(UI.state.resources));
  check("默认容量取场景容量 1", UI.state.resources[0].capacity === 1);
  check("toast 提示已填充", lastToast && lastToast.msg.includes("已填充 1 个资源名"),
        JSON.stringify(lastToast));

  // ---- 4b. 删除按钮可移除容量行 ----
  UI.state.resources.push({ name: "多余", capacity: 2 });
  renderResBody();
  const delBtn = makeEl("button");
  delBtn.dataset = { ccDelR: "1" };
  delBtn.parentNode = resBody;
  await emit(delBtn, "click");
  check("删除后只剩 DBA 行", UI.state.resources.length === 1
        && UI.state.resources[0].name === "DBA",
        JSON.stringify(UI.state.resources));
  renderResBody();

  // ---- 5. 运行核查：容量 1 -> 1 段超限 ----
  await emit(els.ccBtnRun, "click");
  await tick();
  check("错误框隐藏", els.ccError.className.includes("hidden"), els.ccError.innerHTML);
  check("结果保存", UI.state.lastResult && UI.state.lastResult.overloads.length === 1);
  check("汇总显示超限时段 1", els.ccSummary.innerHTML.includes("超限时段 1"));
  check("汇总含完整覆盖 chip", els.ccSummary.innerHTML.includes("核查覆盖全部任务"));
  const html = els.ccResult.innerHTML;
  check("列出资源 DBA", html.includes("DBA"));
  check("列出峰值 2 / 容量 1", html.includes("峰值 2") && html.includes("容量 1"));
  check("列出涉及两个场景", html.includes("场景一") && html.includes("场景二"));
  check("列出涉及两个任务", html.includes("1-任务A") && html.includes("2-任务A"));
  check("标注半开区间", html.includes("半开区间"));
  check("无警告", els.ccWarnings.className.includes("hidden"));
  check("场景卡片均可展开（两个）",
        (els.ccScenarioStatus.innerHTML.match(/cc-scn-card/g) || []).length === 2);
  check("场景状态为计划可行", els.ccScenarioStatus.innerHTML.includes("计划可行"));

  // ---- 6. 容量改为 5 -> 无超限 ----
  UI.state.resources[0].capacity = 5;
  await emit(els.ccBtnRun, "click");
  await tick();
  check("容量充足无超限", UI.state.lastResult.overloads.length === 0);
  check("显示未发现超限", els.ccResult.innerHTML.includes("均未超限"));
  check("汇总显示 ✔", els.ccSummary.innerHTML.includes("未发现合计超限"));

  // ---- 7. 容量非法（0）客户端拦截 ----
  UI.state.resources[0].capacity = 0;
  await emit(els.ccBtnRun, "click");
  await tick();
  check("容量 0 被拦截", els.ccError.innerHTML.includes("大于 0"), els.ccError.innerHTML);

  // ---- 8. 服务端缺失场景诊断渲染 ----
  UI.state.resources[0].capacity = 1;
  UI.state.selected.clear();
  UI.state.selected.add(1);
  UI.state.selected.add(999);
  await emit(els.ccBtnRun, "click");
  await tick();
  check("缺失 id 错误渲染",
        els.ccError.innerHTML.includes("部分场景不存在") &&
        els.ccError.innerHTML.includes("999"), els.ccError.innerHTML);

  // ---- 9. 关闭弹窗 ----
  await emit(els.ccBtnClose, "click");
  check("弹窗关闭", els.ccModal.className.includes("hidden"));

  // ---- 10. 有警告的结果：部分排程 + 未核查资源 ----
  UI.state.selected.clear();
  UI.state.selected.add(1);
  UI.state.selected.add(2);
  // 直接调用渲染函数验证诊断 / 跳过 / 未核查资源的展示
  UI.renderResult({
    capacities: { DBA: 1 },
    scenarios: [
      { id: 1, name: "场景一", planned: true, error: null, feasible: false,
        total: 2, scheduled: 1, fully_scheduled: false,
        unscheduled: [{ id: "x", name: "卡住的任务" }],
        conflicts: [{ type: "unschedulable", message: "「卡住的任务」无法排程" }] },
      { id: 2, name: "场景二", planned: false, error: "维护窗口开始时间必须早于结束时间",
        feasible: false, total: 0, scheduled: 0, fully_scheduled: false,
        unscheduled: [], conflicts: [] },
    ],
    overloads: [],
    warnings: [
      "场景「场景一」有 1 个任务未排程（卡住的任务），核查已跳过这些任务",
      "场景「场景二」计划计算失败；该场景的全部任务均未参与占用汇总",
      "资源「网络组」被 1 个场景占用，但未提供共享资源总容量，未参与核查",
    ],
    unchecked_resources: [{ resource: "网络组", scenarios: [{ id: 1, name: "场景一" }], task_count: 1 }],
    unused_resources: [],
    stats: { scenario_count: 2, resource_count: 1, overload_count: 0, fully_checked: false },
  });
  check("警告框显示 3 条", !els.ccWarnings.className.includes("hidden")
        && (els.ccWarnings.innerHTML.match(/<li>/g) || []).length === 3);
  check("警告含跳过说明", els.ccWarnings.innerHTML.includes("跳过这些任务"));
  check("警告含计划失败", els.ccWarnings.innerHTML.includes("计划计算失败"));
  check("警告含未核查资源", els.ccWarnings.innerHTML.includes("网络组"));
  const st = els.ccScenarioStatus.innerHTML;
  check("场景一标记部分排程 1/2", st.includes("部分排程 1/2"));
  check("列出未排定任务", st.includes("卡住的任务"));
  check("列出冲突类型", st.includes("unschedulable"));
  check("场景二标记计划失败", st.includes("计划失败"));
  check("场景二显示错误详情", st.includes("维护窗口开始时间必须早于结束时间"));
  check("汇总提示不能视为完全无冲突", els.ccSummary.innerHTML.includes("不能视为完全无冲突"));
  check("无超限时结论限定已排定任务", els.ccResult.innerHTML.includes("结论仅覆盖已排定任务"));

  console.log(`\n前端核查流程全部 ${passed} 项检查通过 ✔`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
