/* 维护窗口排程 —— 原生 JS 前端 */
"use strict";

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------
const state = {
  windowStart: "",
  windowEnd: "",
  resources: [],            // [{name, capacity}]
  nodes: [],                // [{id, name, duration_minutes, resources:{}, fixed_start}]
  edges: [],                // [{source, target}]
  blackouts: [],            // [{id, name, start, end}]
  uid: 1,
  templateRef: null,        // 由模板实例化时：{id, name, params, resolved, issues}
};
let lastResult = null;
let recomputeTimer = null;
let recomputing = false;
let dirty = false;
let scenarioDirty = false;  // 编辑器相对已保存场景是否有未保存改动
let currentScenarioId = null;   // 当前编辑器内容对应的已保存场景 id
let executionData = null;       // {complete, updated_at, records:[…]}
let execFormNodes = null;       // 登记弹窗当前编辑的任务快照

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function uid(prefix) { return prefix + (state.uid++); }

function dtLocal(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function parseDT(s) { return new Date(s); }
function fmtDT(s) {
  if (!s) return "—";
  const d = parseDT(s), p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtDur(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? (m ? `${h}小时${m}分` : `${h}小时`) : `${m}分`;
}
function nodeById(id) { return state.nodes.find((n) => n.id === id); }
function nodeName(id) { return nodeById(id)?.name || id; }
function snap5(date) {
  const d = new Date(date);
  d.setMinutes(Math.round(d.getMinutes() / 5) * 5, 0, 0);
  return d;
}

function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 2600);
}

// ---------------------------------------------------------------------------
// 编辑器渲染
// ---------------------------------------------------------------------------
function renderResources() {
  const tb = $("#resourceTable tbody");
  tb.innerHTML = state.resources.map((r, i) => `
    <tr>
      <td><input data-ri="${i}" data-rk="name" value="${esc(r.name)}" placeholder="如：DBA / 网络组" /></td>
      <td style="width:80px"><input type="number" min="0" step="1" data-ri="${i}" data-rk="capacity" value="${r.capacity}" /></td>
      <td style="width:34px"><button class="btn btn-small del" data-del-r="${i}">✕</button></td>
    </tr>`).join("");
  renderNodeResourceCells();
}

function renderNodes() {
  const tb = $("#nodeTable tbody");
  tb.innerHTML = state.nodes.map((n, i) => `
    <tr data-nrow="${n.id}">
      <td class="name-cell" style="min-width:110px">
        <input data-ni="${i}" data-nk="name" value="${esc(n.name)}" />
      </td>
      <td style="width:78px">
        <input type="number" min="1" step="1" data-ni="${i}" data-nk="duration_minutes" value="${n.duration_minutes}" />
      </td>
      <td class="res-cell" data-res-for="${n.id}" style="min-width:120px"></td>
      <td style="min-width:150px">
        <input type="datetime-local" step="300" data-fixed="${n.id}" value="${n.fixed_start || ""}" title="设置后该任务锁定开始时间；甘特图上双击条可取消锁定" />
      </td>
      <td style="width:34px"><button class="btn btn-small del" data-del-n="${i}">✕</button></td>
    </tr>`).join("");
  $("#nodeCount").textContent = state.nodes.length ? `(${state.nodes.length})` : "";
  renderNodeResourceCells();
  renderEdges();
}

function renderNodeResourceCells() {
  $$(".res-cell").forEach((td) => {
    const nid = td.dataset.resFor;
    const n = nodeById(nid);
    if (!n) return;
    if (!state.resources.length) {
      td.innerHTML = `<span class="hint">无资源</span>`;
      return;
    }
    td.innerHTML = `<div style="display:flex;gap:4px;flex-wrap:wrap">` +
      state.resources.map((r) => `
        <label style="display:flex;align-items:center;gap:2px;font-size:10px;color:var(--muted)">
          ${esc(r.name)}
          <input type="number" min="0" step="1" style="width:46px;padding:2px 4px"
                 data-nres="${nid}" data-rname="${esc(r.name)}"
                 value="${n.resources[r.name] ?? 0}" />
        </label>`).join("") + `</div>`;
  });
}

function renderEdges() {
  const tb = $("#edgeTable tbody");
  const opts = (sel) => `<option value="">—</option>` +
    state.nodes.map((n) => `<option value="${n.id}" ${n.id === sel ? "selected" : ""}>${esc(n.name)}</option>`).join("");
  tb.innerHTML = state.edges.map((e, i) => `
    <tr>
      <td><select data-ei="${i}" data-ek="source">${opts(e.source)}</select></td>
      <td style="width:24px;text-align:center;color:var(--muted)">→</td>
      <td><select data-ei="${i}" data-ek="target">${opts(e.target)}</select></td>
      <td style="width:34px"><button class="btn btn-small del" data-del-e="${i}">✕</button></td>
    </tr>`).join("");
}

function renderBlackouts() {
  const tb = $("#blackoutTable tbody");
  tb.innerHTML = state.blackouts.map((b, i) => `
    <tr>
      <td style="min-width:90px"><input data-bi="${i}" data-bk="name" value="${esc(b.name)}" /></td>
      <td><input type="datetime-local" step="300" data-bi="${i}" data-bk="start" value="${b.start || ""}" /></td>
      <td><input type="datetime-local" step="300" data-bi="${i}" data-bk="end" value="${b.end || ""}" /></td>
      <td style="width:34px"><button class="btn btn-small del" data-del-b="${i}">✕</button></td>
    </tr>`).join("");
}

function renderAll() {
  renderResources();
  renderNodes();     // 也会刷新依赖下拉
  renderBlackouts();
}

// ---------------------------------------------------------------------------
// 编辑事件（事件委托）
// ---------------------------------------------------------------------------
$(".panel-left").addEventListener("input", onEditorChange);
$(".panel-left").addEventListener("change", onEditorChange);

function onEditorChange(ev) {
  const t = ev.target;
  let touched = false;

  if (t.id === "winStart") { state.windowStart = t.value; touched = true; }
  else if (t.id === "winEnd") { state.windowEnd = t.value; touched = true; }

  else if (t.dataset.rk) {
    const r = state.resources[+t.dataset.ri];
    const oldName = r.name;
    let v = t.dataset.rk === "capacity" ? Math.max(0, +t.value || 0) : t.value;
    r[t.dataset.rk] = v;
    if (t.dataset.rk === "name") {
      state.nodes.forEach((n) => {
        if (oldName in n.resources) {
          n.resources[v] = n.resources[oldName];
          delete n.resources[oldName];
        }
      });
      renderNodeResourceCells();
    }
    touched = true;
  }
  else if (t.dataset.nk) {
    const n = state.nodes[+t.dataset.ni];
    n[t.dataset.nk] = t.dataset.nk === "duration_minutes" ? Math.max(1, +t.value || 1) : t.value;
    touched = true;
  }
  else if (t.dataset.nres) {
    const n = nodeById(t.dataset.nres);
    const amount = +t.value || 0;
    if (amount > 0) n.resources[t.dataset.rname] = amount;
    else delete n.resources[t.dataset.rname];
    touched = true;
  }
  else if (t.dataset.fixed) {
    const n = nodeById(t.dataset.fixed);
    n.fixed_start = t.value || null;
    touched = true;
  }
  else if (t.dataset.ek) {
    const e = state.edges[+t.dataset.ei];
    e[t.dataset.ek] = t.value;
    touched = true;
  }
  else if (t.dataset.bk) {
    const b = state.blackouts[+t.dataset.bi];
    b[t.dataset.bk] = t.value;
    touched = true;
  }

  if (t.classList.contains("del")) {
    if (t.dataset.delR !== undefined) {
      const [r] = state.resources.splice(+t.dataset.delR, 1);
      state.nodes.forEach((n) => delete n.resources[r.name]);
      renderAll();
    } else if (t.dataset.delN !== undefined) {
      const n = state.nodes[+t.dataset.delN];
      state.nodes.splice(+t.dataset.delN, 1);
      state.edges = state.edges.filter((e) => e.source !== n.id && e.target !== n.id);
      renderAll();
    } else if (t.dataset.delE !== undefined) {
      state.edges.splice(+t.dataset.delE, 1);
      renderEdges();
    } else if (t.dataset.delB !== undefined) {
      state.blackouts.splice(+t.dataset.delB, 1);
      renderBlackouts();
    }
    touched = true;
  }

  if (touched) { dirty = true; scenarioDirty = true; scheduleRecompute(); }
}

$("#btnAddResource").onclick = () => {
  const base = "资源" + (state.resources.length + 1);
  let name = base, k = 1;
  while (state.resources.some((r) => r.name === name)) name = base + (++k);
  state.resources.push({ name, capacity: 1 });
  renderResources();
  scenarioDirty = true;
  scheduleRecompute();
};
$("#btnAddNode").onclick = () => {
  const n = { id: uid("n"), name: "任务" + (state.nodes.length + 1),
              duration_minutes: 30, resources: {}, fixed_start: null };
  state.nodes.push(n);
  renderNodes();
  scenarioDirty = true;
  scheduleRecompute();
};
$("#btnAddEdge").onclick = () => {
  if (state.nodes.length < 1) return toast("请先添加任务", true);
  state.edges.push({ source: state.nodes[0].id, target: state.nodes[state.nodes.length - 1].id });
  renderEdges();
  scenarioDirty = true;
  scheduleRecompute();
};
$("#btnAddBlackout").onclick = () => {
  state.blackouts.push({ id: uid("b"), name: "禁排期" + (state.blackouts.length + 1),
                         start: "", end: "" });
  renderBlackouts();
  scenarioDirty = true;
  scheduleRecompute();
};

$("#autoRecompute").onchange = () => {
  if ($("#autoRecompute").checked) scheduleRecompute();
};
$("#btnRecompute").onclick = () => recompute(true);

// ---------------------------------------------------------------------------
// 请求载荷 / 排程
// ---------------------------------------------------------------------------
function buildPayload(extra = {}) {
  return {
    window_start: state.windowStart,
    window_end: state.windowEnd,
    resources: Object.fromEntries(state.resources.map((r) => [r.name, r.capacity])),
    nodes: state.nodes.map((n) => ({
      id: n.id, name: n.name, duration_minutes: n.duration_minutes,
      resources: { ...n.resources }, fixed_start: n.fixed_start || null,
    })),
    edges: state.edges.filter((e) => e.source && e.target)
                      .map((e) => ({ source: e.source, target: e.target })),
    blackouts: state.blackouts.filter((b) => b.start && b.end)
                              .map((b) => ({ name: b.name, start: b.start, end: b.end })),
    ...extra,
  };
}

function scheduleRecompute(delay = 180) {
  if (!$("#autoRecompute").checked) return;
  clearTimeout(recomputeTimer);
  recomputeTimer = setTimeout(() => recompute(false), delay);
}

async function recompute(manual) {
  if (!state.windowStart || !state.windowEnd) {
    setStatus("idle", "请先设置维护窗口的开始与结束时间");
    return;
  }
  clearTimeout(recomputeTimer);
  setStatus("busy", "排程计算中…");
  recomputing = true;
  try {
    const resp = await fetch("/api/schedule", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload()),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${resp.status}`);
    }
    lastResult = await resp.json();
    dirty = false;
    renderResult();
  } catch (e) {
    setStatus("err", "输入有误：" + e.message);
    if (manual) toast(e.message, true);
  } finally {
    recomputing = false;
  }
}

// ---------------------------------------------------------------------------
// 结果渲染
// ---------------------------------------------------------------------------
function setStatus(kind, text, stats = "") {
  const dot = $("#statusDot");
  dot.className = "status-dot " + (kind === "ok" ? "ok" : kind === "err" ? "err" : kind === "busy" ? "busy" : "");
  $("#statusText").textContent = text;
  $("#statusStats").textContent = stats;
}

function conflictTag(type) {
  const map = {
    cycle: ["循环依赖", "cycle"],
    dangling_edge: ["悬空依赖", ""],
    unschedulable: ["无法排程", ""],
    dependency_blocked: ["依赖阻塞", ""],
    fixed_window: ["固定越界", ""],
    fixed_predecessor: ["固定冲突", ""],
    fixed_blackout: ["禁排冲突", ""],
    fixed_resource: ["资源冲突", "resource"],
    fixed_capacity: ["容量超限", "resource"],
  };
  return map[type] || [type, ""];
}

function renderResult() {
  const r = lastResult;
  const s = r.stats;
  const stats = `已排 ${s.scheduled}/${s.total} ｜ 冲突 ${s.conflicts} ｜ 总跨度 ${fmtDur(s.makespan_minutes)}`;

  if (r.feasible) {
    setStatus("ok", `✓ 排程可行：${s.scheduled} 个任务均满足依赖、资源与禁排期约束`, stats);
  } else {
    setStatus("err", `✗ 存在 ${s.conflicts} 个冲突，${s.scheduled}/${s.total} 个任务完成排程（点击冲突条可在甘特图定位）`, stats);
  }

  // 冲突列表
  const box = $("#conflictBox");
  if (r.conflicts.length) {
    box.classList.remove("hidden");
    box.innerHTML = `<h3>冲突与告警（${r.conflicts.length}）</h3>` +
      r.conflicts.map((c, idx) => {
        const [label, cls] = conflictTag(c.type);
        const chain = (c.chain || []).map((id) => `<b>${esc(nodeName(id))}</b>`).join(" → ");
        return `<div class="conflict-item" data-ci="${idx}">
          <span class="conflict-tag ${cls}">${label}</span>
          <div><div>${esc(c.message)}</div>${chain ? `<span class="conflict-chain">${chain}</span>` : ""}</div>
        </div>`;
      }).join("");
  } else {
    box.classList.add("hidden");
    box.innerHTML = "";
  }

  renderScheduleTable();
  renderLegend();
  drawGantt();
  renderExecution();
}

function renderScheduleTable() {
  const r = lastResult;
  const rows = r.items.map((it, i) => `
    <tr class="${it.fixed ? "row-fixed" : ""}">
      <td>${i + 1}</td>
      <td><b>${esc(it.name)}</b>${it.fixed ? " 🔒" : ""}</td>
      <td>${it.start_label}</td>
      <td>${it.end_label}</td>
      <td>${fmtDur(it.duration_minutes)}</td>
      <td>${it.predecessors.map((pid) => esc(nodeName(pid))).join("、") || "—"}</td>
      <td>${Object.entries(it.resources).map(([k, v]) => `${esc(k)}:${v}`).join(" ") || "—"}</td>
    </tr>`).join("");

  const extra = r.unscheduled.map((id) => `
    <tr class="row-error">
      <td>✕</td><td><b>${esc(nodeName(id))}</b></td>
      <td colspan="6">未排程（见上方冲突说明）</td>
    </tr>`).join("");

  $("#scheduleTable tbody").innerHTML = rows + extra;
}

function renderLegend() {
  $("#legend").innerHTML = `
    <span><i style="background:#5b9aff"></i>弹性排程（可拖动，拖动后锁定）</span>
    <span><i style="background:#b48cff"></i>固定开始时间 🔒（双击解锁）</span>
    <span><i style="background:rgba(239,91,107,.35);border:1px dashed #ef5b6b"></i>禁排期 / 未排程</span>
    <span>提示：拖动条体移动开始时间，拖动右边缘调整时长</span>`;
}

// ---------------------------------------------------------------------------
// 甘特图（Canvas）
// ---------------------------------------------------------------------------
const canvas = $("#gantt");
const ctx = canvas.getContext("2d");
const ganttWrap = $(".gantt-wrap");

// roundRect 兼容垫片（较旧浏览器无 CanvasRenderingContext2D.roundRect）
if (typeof CanvasRenderingContext2D !== "undefined" &&
    !CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    this.moveTo(x + rr, y);
    this.arcTo(x + w, y, x + w, y + h, rr);
    this.arcTo(x + w, y + h, x, y + h, rr);
    this.arcTo(x, y + h, x, y, rr);
    this.arcTo(x, y, x + w, y, rr);
    this.closePath();
    return this;
  };
}

const LABEL_W = 132, AXIS_H = 30, ROW_H = 30, BAR_H = 20, BOTTOM = 8;
let geom = { w: 800, h: 120, scale: 1, t0: 0, t1: 0 };
let barRects = {};       // nodeId -> {x,y,w,h, item}
let hoverId = null;
let highlight = { nodes: new Set(), edges: new Set(), until: 0 };

let tooltip;
function ensureTooltip() {
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.style.cssText =
      "position:absolute;pointer-events:none;background:#0d1526;border:1px solid #4460a0;" +
      "border-radius:6px;padding:6px 9px;font-size:12px;z-index:20;display:none;" +
      "box-shadow:0 4px 16px rgba(0,0,0,.5);white-space:nowrap";
    ganttWrap.appendChild(tooltip);
  }
}

function timeTicks(spanMin) {
  const steps = [10, 15, 30, 60, 120, 180, 240, 360, 480, 720, 1440, 2880];
  const pick = steps.find((s) => spanMin / s <= 12) || 2880;
  const ticks = [];
  // 从整天零点向上取整到 pick 的倍数
  const aligned = new Date(geom.t0);
  aligned.setSeconds(0, 0);
  const dayStart = new Date(aligned);
  dayStart.setHours(0, 0, 0, 0);
  const offset = (aligned.getTime() - dayStart.getTime()) / 60000;
  aligned.setTime(aligned.getTime() + ((pick - (offset % pick)) % pick) * 60000);
  for (let t = aligned.getTime(); t <= geom.t1; t += pick * 60000) ticks.push(t);
  return { ticks, step: pick };
}

function drawGantt() {
  if (!lastResult || !state.windowStart || !state.windowEnd) return;
  ensureTooltip();

  const r = lastResult;
  geom.t0 = parseDT(state.windowStart).getTime();
  geom.t1 = parseDT(state.windowEnd).getTime();
  const span = Math.max(1, (geom.t1 - geom.t0) / 60000);

  const rows = [...r.items.map((it) => ({ kind: "bar", it })),
                ...r.unscheduled.map((id) => ({ kind: "ghost", id, n: nodeById(id) }))];
  const cssW = Math.max(ganttWrap.clientWidth - 18, 560);
  const plotW = cssW - LABEL_W - 14;
  geom.scale = plotW / span; // px per minute
  geom.w = cssW;
  geom.h = AXIS_H + rows.length * ROW_H + BOTTOM;

  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = cssW + "px";
  canvas.style.height = geom.h + "px";
  canvas.width = cssW * dpr;
  canvas.height = geom.h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, geom.h);

  const xOf = (tMs) => LABEL_W + ((tMs - geom.t0) / 60000) * geom.scale;
  const now = Date.now();
  const hlActive = now < highlight.until;

  // 禁排期底纹
  state.blackouts.filter((b) => b.start && b.end).forEach((b) => {
    const s = Math.max(geom.t0, parseDT(b.start).getTime());
    const e = Math.min(geom.t1, parseDT(b.end).getTime());
    if (e <= s) return;
    const x = xOf(s), w = Math.max(1, xOf(e) - x);
    ctx.fillStyle = "rgba(239,91,107,.14)";
    ctx.fillRect(x, AXIS_H - 6, w, rows.length * ROW_H + 6);
    ctx.strokeStyle = "rgba(239,91,107,.55)";
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(x, AXIS_H - 6); ctx.lineTo(x, geom.h); ctx.stroke();
    ctx.setLineDash([]);
    ctx.save();
    ctx.fillStyle = "rgba(239,120,130,.85)";
    ctx.font = "10px sans-serif";
    ctx.translate(x + 5, AXIS_H + 2);
    ctx.rotate(Math.PI / 12);
    ctx.fillText(esc(b.name), 0, 0);
    ctx.restore();
  });

  // 网格 + 时间轴
  const { ticks } = timeTicks(span);
  ctx.strokeStyle = "rgba(255,255,255,.06)";
  ctx.lineWidth = 1;
  ctx.font = "10px ui-monospace, Menlo, monospace";
  ctx.fillStyle = "#8b98b8";
  ticks.forEach((t) => {
    const x = xOf(t);
    ctx.beginPath(); ctx.moveTo(x, AXIS_H); ctx.lineTo(x, geom.h); ctx.stroke();
    const d = new Date(t), p = (n) => String(n).padStart(2, "0");
    ctx.fillText(`${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`, x + 3, 16);
  });
  ctx.strokeStyle = "rgba(255,255,255,.18)";
  ctx.beginPath(); ctx.moveTo(LABEL_W, AXIS_H); ctx.lineTo(cssW - 4, AXIS_H); ctx.stroke();

  // 行背景 + 标签（先重置几何，未排程任务登记 ghost）
  barRects = {};
  rows.forEach((row, i) => {
    const y = AXIS_H + i * ROW_H;
    if (i % 2 === 1) {
      ctx.fillStyle = "rgba(255,255,255,.025)";
      ctx.fillRect(LABEL_W, y, plotW, ROW_H);
    }
    ctx.strokeStyle = "rgba(255,255,255,.05)";
    ctx.beginPath(); ctx.moveTo(LABEL_W, y + ROW_H); ctx.lineTo(cssW - 4, y + ROW_H); ctx.stroke();

    const id = row.kind === "bar" ? row.it.id : row.id;
    const label = nodeName(id);
    ctx.font = "12px sans-serif";
    ctx.fillStyle = hlActive && highlight.nodes.has(id) ? "#ff9aa5" : "#c6d0e6";
    ctx.textAlign = "right";
    ctx.fillText(label.length > 11 ? label.slice(0, 10) + "…" : label, LABEL_W - 8, y + ROW_H / 2 + 4);
    ctx.textAlign = "left";

    if (row.kind === "ghost") {
      // 未排程：红色虚线占位
      const gx = LABEL_W + 2, gw = 22;
      ctx.fillStyle = "rgba(239,91,107,.25)";
      ctx.strokeStyle = "#ef5b6b";
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.roundRect(gx, y + (ROW_H - BAR_H) / 2, gw, BAR_H, 4);
      ctx.fill(); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#ff9aa5";
      ctx.font = "11px sans-serif";
      ctx.fillText("✕ 未排程", gx + gw + 6, y + ROW_H / 2 + 4);
      barRects[id] = { x: gx, y: y + (ROW_H - BAR_H) / 2, w: gw, h: BAR_H, ghost: true };
    }
  });

  // 第一遍：计算所有条的当前几何（拖拽中取编辑器实时状态）
  const liveGeom = {};
  r.items.forEach((it, i) => {
    let st = parseDT(it.start).getTime();
    let en = parseDT(it.end).getTime();
    if (drag && drag.id === it.id) {
      const n = nodeById(it.id);
      const liveStart = n.fixed_start ? parseDT(n.fixed_start).getTime() : st;
      st = liveStart;
      en = liveStart + n.duration_minutes * 60000;
    }
    const x = xOf(st), w = Math.max(3, xOf(en) - x);
    liveGeom[it.id] = {
      x, y: AXIS_H + i * ROW_H + (ROW_H - BAR_H) / 2, w, h: BAR_H,
      st, en,
    };
  });

  // 依赖箭头（先画线，条再覆盖端点）
  r.items.forEach((it) => {
    it.predecessors.forEach((pid) => {
      const a = liveGeom[pid], b = liveGeom[it.id];
      if (!a || !b) return;
      const hot = hlActive && highlight.nodes.has(it.id) && highlight.nodes.has(pid);
      drawArrow(a.x + a.w, a.y + a.h / 2, b.x, b.y + b.h / 2, hot);
    });
  });

  // 第二遍：画条
  r.items.forEach((it) => {
    const { x, w, y: by, st, en } = liveGeom[it.id];
    const hot = hlActive && highlight.nodes.has(it.id);
    const hovered = hoverId === it.id || (drag && drag.id === it.id);

    ctx.save();
    ctx.shadowColor = it.fixed ? "rgba(180,140,255,.5)" : "rgba(91,154,255,.5)";
    ctx.shadowBlur = hovered || hot ? 12 : 5;
    const grad = ctx.createLinearGradient(0, by, 0, by + BAR_H);
    if (it.fixed) { grad.addColorStop(0, "#c3a2ff"); grad.addColorStop(1, "#9666ee"); }
    else { grad.addColorStop(0, "#6fa8ff"); grad.addColorStop(1, "#3f7fe8"); }
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(x, by, w, BAR_H, 5);
    ctx.fill();
    ctx.restore();

    if (hot) {
      ctx.strokeStyle = "#ff5b6e"; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.roundRect(x - 1.5, by - 1.5, w + 3, BAR_H + 3, 6); ctx.stroke();
    } else if (hovered) {
      ctx.strokeStyle = "rgba(255,255,255,.8)"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.roundRect(x - 1, by - 1, w + 2, BAR_H + 2, 6); ctx.stroke();
    }

    // 右边缘调整手柄
    ctx.fillStyle = "rgba(255,255,255,.7)";
    ctx.fillRect(x + w - 4, by + 4, 2, BAR_H - 8);

    const p2 = (n) => String(n).padStart(2, "0");
    const lbl = (ms) => {
      const d = new Date(ms);
      return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
    };
    ctx.fillStyle = "#0c1322";
    ctx.font = "bold 11px sans-serif";
    if (w > 44) ctx.fillText((it.fixed ? "🔒 " : "") + it.name, x + 7, by + 14);
    ctx.font = "10px ui-monospace, monospace";
    if (w > 150) ctx.fillText(`${lbl(st)}–${lbl(en)}`, x + 7, by + BAR_H - 3);

    barRects[it.id] = { x, y: by, w, h: BAR_H };
  });
}

function drawArrow(x1, y1, x2, y2, hot) {
  const dx = Math.min(14, Math.max(6, Math.abs(x2 - x1) / 2));
  ctx.strokeStyle = hot ? "rgba(255,120,135,.95)" : "rgba(140,170,220,.4)";
  ctx.lineWidth = hot ? 2 : 1;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.bezierCurveTo(x1 + dx, y1, x2 - dx, y2, x2 - 3, y2);
  ctx.stroke();
  ctx.fillStyle = ctx.strokeStyle;
  ctx.beginPath();
  ctx.moveTo(x2, y2); ctx.lineTo(x2 - 6, y2 - 3.5); ctx.lineTo(x2 - 6, y2 + 3.5);
  ctx.closePath(); ctx.fill();
}

// 冲突定位
$("#conflictBox").addEventListener("click", (ev) => {
  const item = ev.target.closest(".conflict-item");
  if (!item || !lastResult) return;
  const c = lastResult.conflicts[+item.dataset.ci];
  highlight = {
    nodes: new Set(c.nodes || c.chain || []),
    edges: new Set((c.edges || []).map((e) => e.source + "" + e.target)),
    until: Date.now() + 3000,
  };
  item.classList.remove("flash");
  void item.offsetWidth;
  item.classList.add("flash");
  drawGantt();
});

// ---------------------------------------------------------------------------
// 拖拽：移动 / 调整时长
// ---------------------------------------------------------------------------
let drag = null;

function eventPos(ev) {
  const rect = canvas.getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}
function hitBar(pos) {
  for (const [id, r] of Object.entries(barRects)) {
    if (r.ghost) continue;
    if (pos.x >= r.x && pos.x <= r.x + r.w && pos.y >= r.y && pos.y <= r.y + r.h) {
      return { id, resize: pos.x >= r.x + r.w - 7 };
    }
  }
  return null;
}

canvas.addEventListener("mousedown", (ev) => {
  if (!lastResult) return;
  const pos = eventPos(ev);
  const hit = hitBar(pos);
  if (!hit) return;
  const n = nodeById(hit.id);
  const bar = barRects[hit.id];
  drag = {
    id: hit.id, mode: hit.resize ? "resize" : "move",
    startX: pos.x, origFixed: n.fixed_start, origDur: n.duration_minutes,
    barStartX: bar.x, pxPerMin: geom.scale,
    moved: false,
  };
  ev.preventDefault();
});

window.addEventListener("mousemove", (ev) => {
  const rect = canvas.getBoundingClientRect();
  const pos = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };

  if (drag) {
    const n = nodeById(drag.id);
    const dMin = Math.round((pos.x - drag.startX) / drag.pxPerMin / 5) * 5;
    if (drag.mode === "move") {
      const base = parseDT(drag.origFixed || scheduledStart(drag.id));
      const d = snap5(new Date(base.getTime() + dMin * 60000));
      n.fixed_start = dtLocal(d);
    } else {
      n.duration_minutes = Math.max(5, drag.origDur + dMin);
    }
    drag.moved = true;
    syncFixedInput(n);
    drawGantt();
    scheduleRecompute(120);
    hideTooltip();
    return;
  }

  // hover
  if (!lastResult) return;
  const hit = hitBar(pos);
  canvas.style.cursor = hit ? (hit.resize ? "ew-resize" : "grab") : "default";
  hoverId = hit ? hit.id : null;
  if (hoverId) showTooltip(hoverId, ev.clientX - rect.left, ev.clientY - rect.top);
  else hideTooltip();
  drawGantt();
});

window.addEventListener("mouseup", () => {
  if (drag && drag.moved) {
    recompute(false);
    scenarioDirty = true;
    if (drag.mode === "move") toast(`「${nodeName(drag.id)}」已锁定到新时间，双击甘特条可解锁`);
  }
  drag = null;
});

canvas.addEventListener("dblclick", (ev) => {
  const pos = eventPos(ev);
  const hit = hitBar(pos);
  if (!hit) return;
  const n = nodeById(hit.id);
  if (n.fixed_start) {
    n.fixed_start = null;
    syncFixedInput(n);
    scenarioDirty = true;
    recompute(false);
    toast(`「${n.name}」已解除固定时间`);
  }
});

function scheduledStart(id) {
  return lastResult?.items.find((it) => it.id === id)?.start || state.windowStart;
}
function syncFixedInput(n) {
  const el = document.querySelector(`[data-fixed="${n.id}"]`);
  if (el) el.value = n.fixed_start || "";
}
function showTooltip(id, x, y) {
  const it = lastResult.items.find((i) => i.id === id);
  if (!it) return;
  const n = nodeById(id);
  ensureTooltip();
  tooltip.innerHTML =
    `<b>${esc(it.name)}</b> ${it.fixed ? "🔒固定" : ""}<br>` +
    `${it.start_label} → ${it.end_label}（${fmtDur(it.duration_minutes)}）<br>` +
    `${Object.entries(n.resources).map(([k, v]) => `${esc(k)}: ${v}`).join("，") || "无资源占用"}` +
    `${it.predecessors.length ? "<br>前置：" + it.predecessors.map(nodeName).map(esc).join("、") : ""}`;
  tooltip.style.display = "block";
  const wrapRect = ganttWrap.getBoundingClientRect();
  tooltip.style.left = Math.min(x + 14, wrapRect.width - 230) + "px";
  tooltip.style.top = Math.max(y - 58, 4) + "px";
}
function hideTooltip() { if (tooltip) tooltip.style.display = "none"; }

new ResizeObserver(() => { if (lastResult) drawGantt(); }).observe(ganttWrap);

// ---------------------------------------------------------------------------
// 场景保存 / 恢复
// ---------------------------------------------------------------------------
async function loadScenarioList(selectId) {
  const resp = await fetch("/api/scenarios");
  const list = await resp.json();
  const sel = $("#scenarioSelect");
  sel.innerHTML = `<option value="">— 选择已保存场景 —</option>` +
    list.map((s) => `<option value="${s.id}">${esc(s.name)}（${s.updated_at.replace("T", " ").slice(0, 16)}）</option>`).join("");
}

function serializeState() {
  return {
    windowStart: state.windowStart, windowEnd: state.windowEnd,
    resources: state.resources, nodes: state.nodes, edges: state.edges,
    blackouts: state.blackouts, uid: state.uid,
    templateRef: state.templateRef,
  };
}
function deserializeState(d) {
  state.windowStart = d.windowStart || "";
  state.windowEnd = d.windowEnd || "";
  state.resources = d.resources || [];
  state.nodes = (d.nodes || []).map((n) => ({
    ...n, resources: n.resources || {}, fixed_start: n.fixed_start || null,
  }));
  state.edges = d.edges || [];
  state.blackouts = d.blackouts || [];
  state.uid = d.uid || (state.nodes.length + state.blackouts.length + 1);
  state.templateRef = d.templateRef || null;
  $("#winStart").value = state.windowStart;
  $("#winEnd").value = state.windowEnd;
  renderAll();
}

$("#btnSave").onclick = async () => {
  const name = $("#scenarioName").value.trim();
  if (!name) return toast("请填写场景名称", true);
  const resp = await fetch("/api/scenarios", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, data: serializeState() }),
  });
  if (!resp.ok) return toast("保存失败：" + (await resp.json()).detail, true);
  const rj = await resp.json();
  toast(rj.updated ? `场景「${name}」已更新` : `场景「${name}」已保存`);
  currentScenarioId = rj.id;
  scenarioDirty = false;
  $("#scenarioSelect").value = rj.id;
  await loadScenarioList();
  await refreshExecution();
};

$("#btnLoad").onclick = loadSelected;
$("#scenarioSelect").addEventListener("change", loadSelected);

async function loadSelected() {
  const id = $("#scenarioSelect").value;
  if (!id) return;
  const resp = await fetch(`/api/scenarios/${id}`);
  if (!resp.ok) return toast("恢复失败", true);
  const sc = await resp.json();
  deserializeState(sc.data);
  $("#scenarioName").value = sc.name;
  currentScenarioId = sc.id;
  scenarioDirty = false;
  lastResult = null;
  await recompute(false);
  await refreshExecution();
  toast(`已恢复场景「${sc.name}」`);
}

$("#btnDelete").onclick = async () => {
  const id = $("#scenarioSelect").value;
  if (!id) return toast("请先在下拉框选择场景", true);
  if (!confirm("确认删除该场景？")) return;
  const resp = await fetch(`/api/scenarios/${id}`, { method: "DELETE" });
  if (!resp.ok) return toast("删除失败", true);
  $("#scenarioSelect").value = "";
  $("#scenarioName").value = "";
  if (String(currentScenarioId) === String(id)) {
    currentScenarioId = null;
    executionData = null;
    renderExecution();
  }
  scenarioDirty = false;
  loadScenarioList();
  toast("场景已删除");
};

// ---------------------------------------------------------------------------
// 实际执行记录（按任务 ID 逐任务登记：实际开始/结束，或未执行+原因）
// ---------------------------------------------------------------------------
function fmtDelta(mins, positiveText = "晚", negativeText = "早", zeroText = "准点") {
  const m = Math.round(mins);
  const abs = fmtDur(Math.abs(m));
  if (m === 0) return { text: zeroText, cls: "delta-zero" };
  const sign = m > 0 ? `+${m}` : `${m}`;
  return { text: `${sign} 分（${m > 0 ? positiveText : negativeText} ${abs}）`,
           cls: m > 0 ? "delta-late" : "delta-early" };
}

function plannedItemMap() {
  const m = new Map();
  (lastResult?.items || []).forEach((it) => m.set(it.id, it));
  return m;
}

async function refreshExecution() {
  executionData = null;
  if (currentScenarioId == null) {
    renderExecution();
    return;
  }
  try {
    const resp = await fetch(`/api/scenarios/${currentScenarioId}/execution`);
    if (resp.ok) executionData = await resp.json();
  } catch (e) { /* 网络异常时按无记录渲染 */ }
  renderExecution();
}

function renderExecution() {
  const box = $("#execBox");
  const summary = $("#execSummary");
  const hint = $("#execHint");
  const btn = $("#btnExecEdit");

  if (currentScenarioId == null) {
    btn.disabled = true;
    hint.textContent = "";
    summary.classList.add("hidden");
    box.innerHTML = `<span class="hint">恢复一个已保存场景后，可在此登记每个计划任务的实际开始/结束时间，或标记未执行并说明原因。</span>`;
    return;
  }

  btn.disabled = false;
  if (scenarioDirty) {
    hint.innerHTML = `<span class="delta-late">⚠ 编辑器有未保存改动，偏差以当前排程为准；请先「💾 保存场景」再提交记录</span>`;
  } else {
    hint.textContent = "";
  }

  const records = executionData?.records || [];
  if (!records.length) {
    summary.classList.add("hidden");
    box.innerHTML = `<span class="hint">尚无执行记录，点击「✍ 登记实际执行」为 ${state.nodes.length} 个计划任务逐任务填写。</span>`;
    return;
  }

  const updated = executionData.updated_at
    ? executionData.updated_at.replace("T", " ").slice(0, 16) : "";
  const planned = plannedItemMap();
  const nameOf = (id) => planned.get(id)?.name || nodeById(id)?.name || id;

  const executed = records.filter((r) => r.executed);
  const notExecuted = records.filter((r) => !r.executed);

  // 汇总条：已执行/未执行 + 未执行原因清单
  summary.classList.remove("hidden");
  summary.innerHTML =
    `<span class="exec-chip">已执行 ${executed.length}/${records.length}</span>` +
    (notExecuted.length
      ? `<span class="exec-chip exec-chip-skip">未执行 ${notExecuted.length}</span>` +
        notExecuted.map((r) =>
          `<span class="exec-skip-item"><b>${esc(nameOf(r.node_id))}</b>：${esc(r.reason)}</span>`
        ).join("")
      : `<span class="exec-chip exec-chip-ok">✔ 全部任务均已执行</span>`) +
    (updated ? `<span class="exec-updated">最近保存：${esc(updated)}</span>` : "");

  // 逐任务：开始偏差 / 时长偏差 / 未执行
  box.innerHTML = `
    <table class="mini-table exec-table">
      <thead>
        <tr><th>任务</th><th>计划时段</th><th>实际时段</th>
            <th>开始偏差</th><th>时长偏差</th><th>执行情况</th></tr>
      </thead>
      <tbody>
      ${records.map((r) => {
        const nid = r.node_id;
        const it = planned.get(nid);
        const name = nameOf(nid);
        if (!r.executed) {
          return `<tr class="row-skipped">
            <td><b>${esc(name)}</b><br><span class="hint">${esc(nid)}</span></td>
            <td>${it ? esc(it.start_label) + " ~ " + esc(it.end_label) : "—"}</td>
            <td colspan="3"><span class="skip-tag">未执行</span></td>
            <td><span class="skip-reason">${esc(r.reason)}</span></td>
          </tr>`;
        }
        let startCell, durCell;
        if (it) {
          const startDelta = (parseDT(r.actual_start) - parseDT(it.start)) / 60000;
          const actualDur = (parseDT(r.actual_end) - parseDT(r.actual_start)) / 60000;
          const durDelta = actualDur - it.duration_minutes;
          const ds = fmtDelta(startDelta, "晚于计划", "早于计划");
          const dd = fmtDelta(durDelta, "超时", "提前结束", "时长一致");
          startCell = `<span class="${ds.cls}">${esc(ds.text)}</span>`;
          durCell = `<span class="${dd.cls}">${esc(dd.text)}</span>`;
        } else {
          startCell = durCell = `<span class="hint">计划未排程，无法比较</span>`;
        }
        return `<tr>
          <td><b>${esc(name)}</b><br><span class="hint">${esc(nid)}</span></td>
          <td>${it ? esc(it.start_label) + " ~ " + esc(it.end_label) : "—（未排程）"}</td>
          <td>${esc(fmtDT(r.actual_start))} ~ ${esc(fmtDT(r.actual_end))}</td>
          <td>${startCell}</td><td>${durCell}</td>
          <td><span class="done-tag">已执行</span></td>
        </tr>`;
      }).join("")}
      </tbody>
    </table>`;
}

$("#btnExecEdit").onclick = openExecModal;

async function openExecModal() {
  if (currentScenarioId == null) {
    return toast("请先在顶栏选择并「恢复」一个已保存场景", true);
  }
  if (scenarioDirty) {
    return toast("编辑器有未保存改动，请先保存场景后再登记执行记录", true);
  }
  // 以服务端保存的场景任务列表为准，避免引用无效 / 漏填
  const resp = await fetch(`/api/scenarios/${currentScenarioId}`);
  if (!resp.ok) return toast("无法读取场景", true);
  const sc = await resp.json();
  const savedNodes = (sc.data?.nodes || []).map((n) => ({ id: String(n.id), name: n.name || n.id }));
  if (!savedNodes.length) return toast("该场景没有计划任务，无可登记记录", true);

  $("#execModalScenario").textContent = sc.name;
  $("#execFormError").classList.add("hidden");
  $("#execFormError").innerHTML = "";
  let existing = [];
  if (executionData && executionData.records) existing = executionData.records;
  execFormNodes = savedNodes.map((n) => {
    const old = existing.find((r) => r.node_id === n.id);
    return {
      ...n,
      executed: old ? old.executed : true,
      actual_start: old?.actual_start || "",
      actual_end: old?.actual_end || "",
      reason: old?.reason || "",
    };
  });
  renderExecForm([]);
  $("#execModal").classList.remove("hidden");
}

function renderExecForm(errorIds) {
  const errorSet = new Set(errorIds || []);
  const planned = plannedItemMap();
  $("#execFormTable tbody").innerHTML = execFormNodes.map((n, i) => {
    const it = planned.get(n.id);
    return `<tr data-execrow="${esc(n.id)}" class="${errorSet.has(n.id) ? "exec-row-err" : ""} ${n.executed ? "" : "row-skipped"}">
      <td><b>${esc(n.name)}</b><br><span class="hint">${esc(n.id)}</span></td>
      <td class="hint">${it ? esc(it.start_label) + "~" + esc(it.end_label) : "（计划未排程）"}</td>
      <td>
        <select data-exi="${i}" data-exk="executed">
          <option value="true" ${n.executed ? "selected" : ""}>已执行</option>
          <option value="false" ${n.executed ? "" : "selected"}>未执行</option>
        </select>
      </td>
      <td><input type="datetime-local" step="60" data-exi="${i}" data-exk="actual_start"
                 value="${esc(n.actual_start)}" ${n.executed ? "" : "disabled"} /></td>
      <td><input type="datetime-local" step="60" data-exi="${i}" data-exk="actual_end"
                 value="${esc(n.actual_end)}" ${n.executed ? "" : "disabled"} /></td>
      <td><input data-exi="${i}" data-exk="reason" value="${esc(n.reason)}"
                 placeholder="未执行时必填原因" ${n.executed ? "disabled" : ""} /></td>
    </tr>`;
  }).join("");
}

$("#execFormTable").addEventListener("input", (ev) => {
  const t = ev.target;
  if (t.dataset.exk && t.dataset.exk !== "executed") {
    execFormNodes[+t.dataset.exi][t.dataset.exk] = t.value;
  }
});
$("#execFormTable").addEventListener("change", (ev) => {
  const t = ev.target;
  if (t.dataset.exk === "executed") {
    execFormNodes[+t.dataset.exi].executed = t.value === "true";
    renderExecForm([]);
  }
});

function collectExecRecords() {
  return execFormNodes.map((n) => ({
    node_id: n.id,
    executed: n.executed,
    actual_start: n.executed ? n.actual_start || null : null,
    actual_end: n.executed ? n.actual_end || null : null,
    reason: n.executed ? null : (n.reason.trim() || null),
  }));
}

$("#execBtnSave").onclick = async () => {
  const clientErrors = [];
  const badIds = [];
  collectExecRecords().forEach((r) => {
    if (r.executed) {
      if (!r.actual_start || !r.actual_end) {
        clientErrors.push(`任务 ${r.node_id}：已执行但缺少实际开始或结束时间`);
        badIds.push(r.node_id);
      } else if (parseDT(r.actual_end) < parseDT(r.actual_start)) {
        clientErrors.push(`任务 ${r.node_id}：实际结束时间早于开始时间`);
        badIds.push(r.node_id);
      }
    } else if (!r.reason) {
      clientErrors.push(`任务 ${r.node_id}：标记未执行但未填写原因`);
      badIds.push(r.node_id);
    }
  });
  if (clientErrors.length) {
    showExecFormErrors(clientErrors);
    renderExecForm(badIds);
    return;
  }

  const resp = await fetch(`/api/scenarios/${currentScenarioId}/execution`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ records: collectExecRecords() }),
  });
  if (resp.status === 422) {
    const err = await resp.json().catch(() => ({}));
    const detail = err.detail;
    if (detail && typeof detail === "object" && Array.isArray(detail.errors)) {
      const ids = detail.errors.map((e) => e.node_id).filter(Boolean);
      showExecFormErrors(detail.errors.map((e) => e.message));
      renderExecForm(ids);
    } else {
      toast("保存被拒绝：" + (typeof detail === "string" ? detail : "校验失败"), true);
    }
    return;
  }
  if (!resp.ok) return toast(`保存失败 HTTP ${resp.status}`, true);

  $("#execModal").classList.add("hidden");
  toast("执行记录已整批保存");
  await refreshExecution();
};

function showExecFormErrors(messages) {
  const box = $("#execFormError");
  box.classList.remove("hidden");
  box.innerHTML = `<b>整次保存被拒绝（未写入任何数据）：</b><ul>` +
    messages.map((m) => `<li>${esc(m)}</li>`).join("") + `</ul>`;
}

function closeExecModal() { $("#execModal").classList.add("hidden"); }
$("#execBtnClose").onclick = closeExecModal;
$("#execBtnCancel").onclick = closeExecModal;
$("#execModal").addEventListener("click", (ev) => {
  if (ev.target === $("#execModal")) closeExecModal();
});

// ---------------------------------------------------------------------------
// JSON 导出
// ---------------------------------------------------------------------------
$("#btnExport").onclick = async () => {
  if (!state.windowStart || !state.windowEnd) return toast("请先设置维护窗口", true);
  // 模板实例化场景：导出时附带模板定义 / 输入参数 / 解析值
  const extra = {};
  if (state.templateRef) {
    Object.assign(extra, {
      __template__: state.templateRef.template || null,
      __params__: state.templateRef.params || null,
      __resolved__: state.templateRef.resolved || null,
      __issues__: state.templateRef.issues || [],
    });
  }
  if (executionData && executionData.records && executionData.records.length) {
    extra.__execution__ = {
      scenario_id: currentScenarioId,
      updated_at: executionData.updated_at,
      records: executionData.records,
    };
  }
  const resp = await fetch("/api/export", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildPayload(extra)),
  });
  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    return toast("导出失败：" + (e.detail || resp.status), true);
  }
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "maintenance-schedule.json";
  a.click();
  URL.revokeObjectURL(url);
  toast("已导出排程 JSON");
};

// ---------------------------------------------------------------------------
// 示例数据
// ---------------------------------------------------------------------------
$("#btnSample").onclick = () => {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  const at = (dayOffset, h, m = 0) => dtLocal(new Date(day.getTime() + dayOffset * 86400000 + h * 3600000 + m * 60000));

  state.uid = 10;
  state.windowStart = at(1, 22, 0);   // 次日 22:00
  state.windowEnd = at(2, 6, 0);      // 第3天 06:00
  state.resources = [
    { name: "DBA", capacity: 1 },
    { name: "网络组", capacity: 1 },
    { name: "应用组", capacity: 2 },
  ];
  state.nodes = [
    { id: "n1", name: "流量切走", duration_minutes: 20, resources: { 网络组: 1 }, fixed_start: null },
    { id: "n2", name: "停应用集群", duration_minutes: 20, resources: { 应用组: 2 }, fixed_start: null },
    { id: "n3", name: "数据库主备切换", duration_minutes: 30, resources: { DBA: 1, 网络组: 1 }, fixed_start: null },
    { id: "n4", name: "数据库版本升级", duration_minutes: 60, resources: { DBA: 1 }, fixed_start: null },
    { id: "n5", name: "应用灰度发布", duration_minutes: 45, resources: { 应用组: 1, DBA: 1 }, fixed_start: null },
    { id: "n6", name: "全量回归验证", duration_minutes: 30, resources: { 应用组: 1 }, fixed_start: null },
    { id: "n7", name: "流量切回", duration_minutes: 30, resources: { 网络组: 1 }, fixed_start: at(2, 5, 30) },
  ];
  state.edges = [
    { source: "n1", target: "n2" },
    { source: "n2", target: "n3" },
    { source: "n3", target: "n4" },
    { source: "n4", target: "n5" },
    { source: "n5", target: "n6" },
    { source: "n6", target: "n7" },
    // 制造一个资源竞争：备份校验需要 DBA，与升级并行会冲突
  ];
  state.blackouts = [
    { id: "b1", name: "整点计费批处理 00:00-00:30", start: at(2, 0, 0), end: at(2, 0, 30) },
  ];
  // 额外制造资源竞争的任务（与 n4 争 DBA）
  state.nodes.push(
    { id: "n8", name: "备份一致性校验", duration_minutes: 45, resources: { DBA: 1 }, fixed_start: null },
    { id: "n9", name: "缓存集群重启", duration_minutes: 40, resources: { 应用组: 1 }, fixed_start: null }
  );
  state.edges.push({ source: "n2", target: "n8" });

  $("#winStart").value = state.windowStart;
  $("#winEnd").value = state.windowEnd;
  renderAll();
  currentScenarioId = null;
  scenarioDirty = true;
  executionData = null;
  renderExecution();
  recompute(false);
  toast("已载入示例：可试着拖动甘特条、添加依赖制造循环");
};

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

// 供 templates.js 调用的公共接口
window.SchedulerApp = {
  toast,
  getState: () => ({
    windowStart: state.windowStart,
    windowEnd: state.windowEnd,
    resources: state.resources.map((r) => ({ ...r })),
    nodes: state.nodes.map((n) => ({ ...n, resources: { ...n.resources } })),
    edges: state.edges.map((e) => ({ ...e })),
    blackouts: state.blackouts.map((b) => ({ ...b })),
    uid: state.uid,
  }),
  // 模板实例化后载入为当前编辑场景
  async loadInstance(data, name, id) {
    deserializeState(data);
    state.templateRef = data.templateRef || null;
    lastResult = null;
    currentScenarioId = id;
    scenarioDirty = false;
    await recompute(false);
    $("#scenarioName").value = name;
    $("#scenarioSelect").value = id;
    await refreshExecution();
  },
  async refreshScenarioList() {
    await loadScenarioList();
  },
};

(function init() {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  state.windowStart = dtLocal(new Date(day.getTime() + 86400000 + 22 * 3600000));
  state.windowEnd = dtLocal(new Date(day.getTime() + 2 * 86400000 + 6 * 3600000));
  $("#winStart").value = state.windowStart;
  $("#winEnd").value = state.windowEnd;
  renderAll();
  loadScenarioList();
  renderExecution();
  recompute(false);
  // 首次交互后提示拖拽
  setTimeout(() => { if (lastResult && lastResult.feasible) toast("可直接拖动甘特条调整时间，松开即自动重算"); }, 800);
})();
