/* 跨场景共享资源占用核查 —— 原生 JS（只读，不改场景 / 执行记录）。
 * 独立 IIFE，不污染 app.js 命名空间；脚本位于 body 末尾，DOM 已就绪。 */
(function () {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function fmtDur(mins) {
    const h = Math.floor(mins / 60), m = mins % 60;
    return h ? (m ? `${h}小时${m}分` : `${h}小时`) : `${m}分`;
  }
  function toast(msg, isErr = false) {
    if (window.SchedulerApp && window.SchedulerApp.toast) {
      window.SchedulerApp.toast(msg, isErr);
      return;
    }
    // 独立运行兜底
    let t = $("#toast");
    if (!t) return;
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    t.classList.remove("hidden");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add("hidden"), 2600);
  }

  // -------------------------------------------------------------------------
  // 状态
  // -------------------------------------------------------------------------
  const cc = {
    scenarios: [],          // GET /api/scenarios 的列表 [{id,name,updated_at}]
    dataCache: new Map(),   // id -> 场景完整 data（用于资源名填充）
    selected: new Set(),    // 勾选的场景 id
    resources: [],          // 共享容量行 [{name, capacity}]
    lastResult: null,
  };

  const els = {
    btnOpen: $("#btnCrossCheck"),
    modal: $("#ccModal"),
    btnClose: $("#ccBtnClose"),
    list: $("#ccScenarioList"),
    resTable: $("#ccResourceTable"),
    btnAdd: $("#ccBtnAddResource"),
    btnFill: $("#ccBtnFillResources"),
    btnRun: $("#ccBtnRun"),
    runHint: $("#ccRunHint"),
    error: $("#ccError"),
    summary: $("#ccSummary"),
    warnings: $("#ccWarnings"),
    scenarioStatus: $("#ccScenarioStatus"),
    result: $("#ccResult"),
  };

  // -------------------------------------------------------------------------
  // 弹窗开 / 关 & 场景列表
  // -------------------------------------------------------------------------
  async function openModal() {
    els.modal.classList.remove("hidden");
    resetResult();
    await refreshScenarios();
    renderResources();
  }

  function closeModal() { els.modal.classList.add("hidden"); }

  async function refreshScenarios() {
    els.list.innerHTML = `<span class="hint">加载中…</span>`;
    let list;
    try {
      const resp = await fetch("/api/scenarios");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      list = await resp.json();
    } catch (e) {
      els.list.innerHTML = `<span class="cc-err">场景列表加载失败：${esc(e.message)}</span>`;
      return;
    }
    cc.scenarios = list;
    // 清掉已不存在的勾选项
    cc.selected = new Set(list.map((s) => s.id).filter((id) => cc.selected.has(id)));
    if (!list.length) {
      els.list.innerHTML = `<span class="hint">尚无已保存场景，请先在主页面保存至少两个场景。</span>`;
      return;
    }
    els.list.innerHTML = list.map((s) => {
      const checked = cc.selected.has(s.id);
      const time = (s.updated_at || "").replace("T", " ").slice(0, 16);
      return `<label class="cc-scenario-item">
        <input type="checkbox" data-cc-scn="${s.id}" ${checked ? "checked" : ""} />
        <b>${esc(s.name)}</b>
        <span class="hint">#${s.id} · 更新于 ${esc(time)}</span>
      </label>`;
    }).join("");
    updateRunHint();
  }

  els.list.addEventListener("change", (ev) => {
    const t = ev.target;
    if (!t.dataset.ccScn) return;
    const id = +t.dataset.ccScn;
    if (t.checked) cc.selected.add(id);
    else cc.selected.delete(id);
    updateRunHint();
  });

  function updateRunHint() {
    els.runHint.textContent = cc.selected.size
      ? `已选择 ${cc.selected.size} 个场景（至少需要 2 个）`
      : "尚未选择场景";
    els.runHint.className = "hint" + (cc.selected.size >= 2 ? " cc-ok" : "");
  }

  // -------------------------------------------------------------------------
  // 共享容量表格
  // -------------------------------------------------------------------------
  function renderResources() {
    const tb = $("#ccResourceTable tbody");
    tb.innerHTML = cc.resources.map((r, i) => `
      <tr>
        <td><input data-cc-ri="${i}" data-cc-rk="name" value="${esc(r.name)}" placeholder="如：DBA / 网络组" /></td>
        <td style="width:110px"><input type="number" min="0" step="any" data-cc-ri="${i}" data-cc-rk="capacity" value="${r.capacity}" /></td>
        <td style="width:34px"><button class="btn btn-small del" data-cc-del-r="${i}">✕</button></td>
      </tr>`).join("");
  }

  els.resTable.addEventListener("input", (ev) => {
    const t = ev.target;
    if (!t.dataset.ccRk) return;
    const r = cc.resources[+t.dataset.ccRi];
    if (!r) return;
    r[t.dataset.ccRk] = t.value;
  });

  els.resTable.addEventListener("click", (ev) => {
    const t = ev.target;
    if (t.dataset.ccDelR === undefined) return;
    cc.resources.splice(+t.dataset.ccDelR, 1);
    renderResources();
  });

  els.btnAdd.addEventListener("click", () => {
    cc.resources.push({ name: "", capacity: "" });
    renderResources();
  });

  async function loadScenarioData(id) {
    if (!cc.dataCache.has(id)) {
      const resp = await fetch(`/api/scenarios/${id}`);
      if (!resp.ok) throw new Error(`场景 #${id} 读取失败 HTTP ${resp.status}`);
      const sc = await resp.json();
      cc.dataCache.set(id, sc.data);
    }
    return cc.dataCache.get(id);
  }

  // 用所选场景中出现过的资源名预填容量行（容量取各场景同名容量最大值作默认）
  els.btnFill.addEventListener("click", async () => {
    if (cc.selected.size < 1) return toast("请先勾选至少一个场景", true);
    const maxCap = new Map();
    for (const id of cc.selected) {
      let data;
      try {
        data = await loadScenarioData(id);
      } catch (e) {
        return toast(e.message, true);
      }
      for (const r of data.resources || []) {
        const name = String(r.name || "").trim();
        if (!name) continue;
        const cap = Number(r.capacity) || 0;
        maxCap.set(name, Math.max(maxCap.get(name) || 0, cap));
      }
    }
    if (!maxCap.size) return toast("所选场景中没有定义任何资源", true);
    const known = new Set(cc.resources.map((r) => r.name.trim()));
    for (const [name, cap] of maxCap) {
      if (!known.has(name)) cc.resources.push({ name, capacity: cap || 1 });
    }
    renderResources();
    toast(`已填充 ${maxCap.size} 个资源名，请核对共享总容量`);
  });

  // -------------------------------------------------------------------------
  // 执行核查
  // -------------------------------------------------------------------------
  function showError(msg) {
    if (!msg) {
      els.error.classList.add("hidden");
      els.error.innerHTML = "";
      return;
    }
    els.error.classList.remove("hidden");
    els.error.innerHTML = `<b>核查请求被拒绝：</b>${esc(msg)}`;
  }

  function resetResult() {
    cc.lastResult = null;
    showError("");
    els.summary.classList.add("hidden");
    els.warnings.classList.add("hidden");
    els.scenarioStatus.innerHTML = "";
    els.result.innerHTML =
      `<span class="hint">选择场景并输入共享资源总容量后，点击「开始核查」。占用按半开区间 [开始, 结束) 汇总：一个任务结束与另一个开始同时发生不算重叠。</span>`;
  }

  function collectCapacities() {
    const errs = [];
    const capacities = {};
    cc.resources.forEach((r, i) => {
      const name = String(r.name || "").trim();
      const raw = String(r.capacity ?? "").trim();
      if (!name && raw === "") return;             // 整行空白 -> 忽略
      if (!name) { errs.push(`第 ${i + 1} 行资源名为空`); return; }
      if (raw === "") { errs.push(`资源「${name}」缺少总容量`); return; }
      const cap = Number(raw);
      if (!Number.isFinite(cap)) { errs.push(`资源「${name}」总容量必须是数字`); return; }
      if (cap <= 0) { errs.push(`资源「${name}」总容量必须大于 0`); return; }
      if (name in capacities) { errs.push(`资源「${name}」重复`); return; }
      capacities[name] = cap;
    });
    if (!Object.keys(capacities).length) errs.push("请至少输入一项共享资源及其总容量");
    return { capacities, errs };
  }

  els.btnRun.addEventListener("click", () => runCheck());

  async function runCheck() {
    showError("");
    if (cc.selected.size < 2) {
      showError("请至少勾选两个场景");
      return;
    }
    const { capacities, errs } = collectCapacities();
    if (errs.length) {
      showError(errs.join("；"));
      return;
    }

    els.btnRun.disabled = true;
    els.btnRun.textContent = "核查中…";
    try {
      const resp = await fetch("/api/cross-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scenario_ids: Array.from(cc.selected),
          capacities,
        }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const detail = body.detail;
        if (detail && typeof detail === "object" && detail.message) {
          showError(detail.message +
            (detail.missing_scenario_ids
              ? `（缺失 id：${detail.missing_scenario_ids.join("、")}）` : ""));
        } else {
          showError(typeof detail === "string" ? detail : `HTTP ${resp.status}`);
        }
        return;
      }
      cc.lastResult = body;
      renderResult(body);
    } catch (e) {
      showError(e.message);
    } finally {
      els.btnRun.disabled = false;
      els.btnRun.textContent = "🔍 开始核查";
    }
  }

  // -------------------------------------------------------------------------
  // 结果渲染
  // -------------------------------------------------------------------------
  function scenarioName(id) {
    return cc.scenarios.find((s) => s.id === id)?.name || `#${id}`;
  }

  function renderResult(data) {
    // 汇总条
    const st = data.stats;
    els.summary.classList.remove("hidden");
    els.summary.innerHTML =
      `<span class="cc-chip">场景 ${st.scenario_count}</span>` +
      `<span class="cc-chip">共享资源 ${st.resource_count}</span>` +
      (st.overload_count
        ? `<span class="cc-chip cc-chip-bad">超限时段 ${st.overload_count}</span>`
        : `<span class="cc-chip cc-chip-ok">✔ 未发现合计超限</span>`) +
      (st.fully_checked
        ? `<span class="cc-chip cc-chip-ok">全部场景计划完整，核查覆盖全部任务</span>`
        : `<span class="cc-chip cc-chip-warn">⚠ 存在跳过 / 未核查项，以下结果不能视为完全无冲突</span>`);

    // 警告（计划失败 / 未排程跳过 / 资源未提供容量）
    if (data.warnings && data.warnings.length) {
      els.warnings.classList.remove("hidden");
      els.warnings.innerHTML =
        `<b>诊断与跳过说明（${data.warnings.length}）：</b><ul>` +
        data.warnings.map((w) => `<li>${esc(w)}</li>`).join("") + `</ul>`;
    } else {
      els.warnings.classList.add("hidden");
      els.warnings.innerHTML = "";
    }

    // 各场景计划状态
    els.scenarioStatus.innerHTML = data.scenarios.map((s) => {
      let tag, cls;
      if (s.error) { tag = "计划失败"; cls = "cc-status-bad"; }
      else if (!s.planned) { tag = "未计算"; cls = "cc-status-bad"; }
      else if (s.feasible && s.fully_scheduled) { tag = "计划可行"; cls = "cc-status-ok"; }
      else { tag = `部分排程 ${s.scheduled}/${s.total}`; cls = "cc-status-warn"; }
      const conflicts = (s.conflicts || []).map((c) =>
        `<li><span class="cc-conf-type">${esc(c.type || "")}</span> ${esc(c.message || "")}</li>`
      ).join("");
      return `<details class="cc-scn-card ${s.error || !s.fully_scheduled ? "is-warn" : ""}">
        <summary>
          <span class="cc-status-tag ${cls}">${tag}</span>
          <b>${esc(s.name)}</b>
          <span class="hint">#${s.id}${s.error ? "" : ` · 已排 ${s.scheduled}/${s.total}`}</span>
        </summary>
        ${s.error ? `<div class="cc-err">${esc(s.error)}</div>` : ""}
        ${s.unscheduled && s.unscheduled.length
          ? `<div class="cc-unscheduled">未排定任务（已跳过，不计入占用）：` +
            s.unscheduled.map((u) => `<b>${esc(u.name)}</b>`).join("、") + `</div>`
          : ""}
        ${conflicts ? `<ul class="cc-conf-list">${conflicts}</ul>` : ""}
      </details>`;
    }).join("");

    // 超限时段明细
    if (!data.overloads.length) {
      els.result.innerHTML =
        `<div class="cc-no-overload">✔ 在给定的共享资源总容量下，所有已排定任务的合计占用均未超限` +
        (st.fully_checked ? "" : "（但存在上方诊断项，结论仅覆盖已排定任务）") + `。</div>`;
      return;
    }
    els.result.innerHTML = data.overloads.map((o, idx) => {
      const scns = o.involved_scenarios.map((s) =>
        `<span class="cc-chip cc-chip-mini">${esc(s.name)}</span>`).join(" ");
      const taskRows = o.tasks.map((t) => `
        <tr class="${t.at_peak ? "cc-row-peak" : ""}">
          <td>${esc(t.scenario_name)}</td>
          <td><b>${esc(t.node_name)}</b>${t.at_peak ? ' <span title="峰值时刻该任务在占用中">▲</span>' : ""}</td>
          <td class="cc-mono">${esc(t.start_label)} ~ ${esc(t.end_label)}</td>
          <td>${t.amount}</td>
        </tr>`).join("");
      return `<div class="cc-overload">
        <div class="cc-overload-head">
          <span class="cc-ov-index">#${idx + 1}</span>
          <b>资源 ${esc(o.resource)}</b>
          <span class="cc-chip cc-chip-bad cc-chip-mini">峰值 ${o.peak} / 容量 ${o.capacity}（超 ${o.excess}）</span>
          <span class="cc-chip cc-chip-mini">峰值时刻 ${esc(o.peak_at_label)}</span>
          <span class="hint">${esc(o.start_label)} ~ ${esc(o.end_label)}（持续 ${fmtDur(o.duration_minutes)}，半开区间）</span>
        </div>
        <div class="cc-overload-scns">涉及场景：${scns}</div>
        <table class="mini-table cc-task-table">
          <thead><tr><th>场景</th><th>任务</th><th>计划时段</th><th>占用</th></tr></thead>
          <tbody>${taskRows}</tbody>
        </table>
      </div>`;
    }).join("");
  }

  // -------------------------------------------------------------------------
  // 事件绑定 & 对外接口
  // -------------------------------------------------------------------------
  if (els.btnOpen) els.btnOpen.addEventListener("click", openModal);
  if (els.btnClose) els.btnClose.addEventListener("click", closeModal);
  if (els.modal) els.modal.addEventListener("click", (ev) => {
    if (ev.target === els.modal) closeModal();
  });

  window.CrossCheckUI = {
    openModal,
    closeModal,
    runCheck,
    refreshScenarios,
    renderResources,
    state: cc,
    scenarioName,
    renderResult,
  };
})();
