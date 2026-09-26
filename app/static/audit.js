/* 跨场景共享资源占用核查：选择已保存场景 + 共享资源总容量 → 只读核查超限时段。
 * 依赖 app.js 暴露的 window.SchedulerApp（toast）；自身不读写主编辑器状态。 */
"use strict";

const AuditApp = (() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const toast = (msg, isErr) => window.SchedulerApp.toast(msg, isErr);

  const selected = new Set();        // 勾选的场景 id（字符串）
  let scenarioList = [];             // /api/scenarios 列表
  const detailCache = new Map();     // id -> 场景详情（预填容量用）
  let capacities = [];               // [{name, capacity}] 共享资源总容量表
  let lastReport = null;             // 最近一次核查响应

  function fmtDT(s) {
    if (!s) return "—";
    const d = new Date(s), p = (n) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // -------------------------------------------------------------------------
  // 打开 / 关闭
  // -------------------------------------------------------------------------
  async function open() {
    $("#auditModal").classList.remove("hidden");
    await refreshScenarioList();
    renderScenarioList();
    renderCapTable();
  }
  function close() { $("#auditModal").classList.add("hidden"); }

  async function refreshScenarioList() {
    try {
      const resp = await fetch("/api/scenarios");
      scenarioList = resp.ok ? await resp.json() : [];
    } catch (e) {
      scenarioList = [];
    }
    const alive = new Set(scenarioList.map((s) => String(s.id)));
    [...selected].forEach((id) => { if (!alive.has(id)) selected.delete(id); });
  }

  // -------------------------------------------------------------------------
  // 场景多选
  // -------------------------------------------------------------------------
  function renderScenarioList() {
    const box = $("#auditScenarioList");
    if (!scenarioList.length) {
      box.innerHTML = `<span class="hint">还没有已保存场景，请先在主界面「💾 保存场景」。</span>`;
      return;
    }
    box.innerHTML = scenarioList.map((s) => `
      <label class="audit-scn-item">
        <input type="checkbox" data-audit-scn="${s.id}" ${selected.has(String(s.id)) ? "checked" : ""} />
        <span class="audit-scn-name">${esc(s.name)}</span>
        <span class="hint">${esc(s.updated_at.replace("T", " ").slice(0, 16))}</span>
      </label>`).join("") +
      `<div class="hint" style="margin-top:4px">已选 <b>${selected.size}</b> 个场景（至少 2 个）</div>`;
  }

  $("#auditScenarioList").addEventListener("change", (ev) => {
    const t = ev.target;
    if (!t.dataset || t.dataset.auditScn === undefined) return;
    if (t.checked) selected.add(String(t.dataset.auditScn));
    else selected.delete(String(t.dataset.auditScn));
    renderScenarioList();
  });

  // -------------------------------------------------------------------------
  // 共享资源总容量表
  // -------------------------------------------------------------------------
  function renderCapTable() {
    const tb = $("#auditCapTable tbody");
    tb.innerHTML = capacities.map((r, i) => `
      <tr>
        <td><input data-aci="${i}" data-ack="name" value="${esc(r.name)}" placeholder="如：DBA / 网络组" /></td>
        <td style="width:90px"><input type="number" min="0" step="1" data-aci="${i}" data-ack="capacity" value="${r.capacity}" /></td>
        <td style="width:34px"><button class="btn btn-small del" data-ac-del="${i}">✕</button></td>
      </tr>`).join("");
  }

  $("#auditCapTable").addEventListener("input", (ev) => {
    const t = ev.target;
    if (!t.dataset || t.dataset.ack === undefined) return;
    const row = capacities[+t.dataset.aci];
    if (!row) return;
    if (t.dataset.ack === "capacity") row.capacity = Math.max(0, +t.value || 0);
    else row.name = t.value;
  });
  $("#auditCapTable").addEventListener("click", (ev) => {
    const t = ev.target;
    if (t.dataset && t.dataset.acDel !== undefined) {
      capacities.splice(+t.dataset.acDel, 1);
      renderCapTable();
    }
  });

  $("#auditBtnAddCap").onclick = () => {
    capacities.push({ name: "", capacity: 1 });
    renderCapTable();
  };

  // 从场景 data 中提取资源表（编辑器 state 数组 / API 对象两种格式）
  function resourcesOf(data) {
    const raw = data?.resources;
    if (Array.isArray(raw)) {
      return raw.map((r) => ({ name: String(r.name ?? ""), capacity: +r.capacity || 0 }));
    }
    if (raw && typeof raw === "object") {
      return Object.entries(raw).map(([name, cap]) => ({ name, capacity: +cap || 0 }));
    }
    return [];
  }

  $("#auditBtnPrefill").onclick = async () => {
    if (selected.size < 1) return toast("请先勾选场景", true);
    // 建议容量 = 各所选场景中该资源容量的最大值；已存在的行保留用户修改
    const suggested = new Map();
    for (const id of selected) {
      if (!detailCache.has(id)) {
        const resp = await fetch(`/api/scenarios/${id}`);
        if (!resp.ok) continue;
        detailCache.set(id, await resp.json());
      }
      resourcesOf(detailCache.get(id).data).forEach((r) => {
        if (!r.name) return;
        suggested.set(r.name, Math.max(suggested.get(r.name) ?? 0, r.capacity));
      });
    }
    if (!suggested.size) return toast("所选场景没有资源定义", true);
    let added = 0;
    suggested.forEach((cap, name) => {
      const row = capacities.find((r) => r.name === name);
      if (row) return;                       // 不覆盖用户已填的行
      capacities.push({ name, capacity: cap });
      added += 1;
    });
    renderCapTable();
    toast(added ? `已预填 ${added} 项共享资源（取各场景最大值，可修改）` : "所有资源已在表中，未做改动");
  };

  // -------------------------------------------------------------------------
  // 核查
  // -------------------------------------------------------------------------
  $("#auditBtnRun").onclick = async () => {
    if (selected.size < 2) return toast("请至少勾选 2 个场景", true);
    const caps = {};
    for (const r of capacities) {
      const name = r.name.trim();
      if (!name) return toast("共享资源名称不能为空", true);
      caps[name] = +r.capacity || 0;
    }
    if (!Object.keys(caps).length) return toast("请至少填写一项共享资源总容量", true);

    const btn = $("#auditBtnRun");
    btn.disabled = true;
    $("#auditResult").innerHTML = `<span class="hint">核查计算中…</span>`;
    try {
      const resp = await fetch("/api/resource-audit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario_ids: [...selected].map(Number), shared_capacities: caps }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(typeof err.detail === "string" ? err.detail : `HTTP ${resp.status}`);
      }
      lastReport = await resp.json();
      renderReport();
    } catch (e) {
      $("#auditResult").innerHTML =
        `<div class="audit-banner err">✗ 核查失败：${esc(e.message)}</div>`;
      toast(e.message, true);
    } finally {
      btn.disabled = false;
    }
  };

  // -------------------------------------------------------------------------
  // 结果渲染
  // -------------------------------------------------------------------------
  function renderReport() {
    const r = lastReport;
    const s = r.stats;
    const parts = [];

    // 结论横幅：超限 > 覆盖缺口 > 全部通过
    if (!r.ok) {
      parts.push(`<div class="audit-banner err">✗ 发现 ${s.overlaps} 个超限时段：共享资源合计占用超过总容量</div>`);
    } else if (!r.complete) {
      parts.push(`<div class="audit-banner warn">⚠ 已排定任务未发现超限，但存在未排定任务未计入核查（见下方警告），不能视为完全无冲突</div>`);
    } else {
      parts.push(`<div class="audit-banner ok">✓ 未发现超限：${s.scenarios} 个场景全部排定，共享资源合计占用均在总容量内</div>`);
    }

    parts.push(`<div class="exec-summary">
      <span class="exec-chip">场景 ${s.scenarios}</span>
      <span class="exec-chip">已排定任务 ${s.scheduled}</span>
      ${s.unscheduled ? `<span class="exec-chip exec-chip-skip">未排定 ${s.unscheduled}</span>` : ""}
      ${s.overlaps ? `<span class="exec-chip exec-chip-skip">超限时段 ${s.overlaps}</span>`
                   : `<span class="exec-chip exec-chip-ok">超限时段 0</span>`}
    </div>`);

    // 覆盖缺口警告（未排定 / 数据无效）
    if (r.warnings.length) {
      parts.push(`<div class="audit-warn-box"><b>⚠ 覆盖缺口（缺失占用不当作无冲突）：</b><ul>` +
        r.warnings.map((w) => `<li>${esc(w)}</li>`).join("") + `</ul></div>`);
    }

    // 超限时段明细
    if (r.conflicts.length) {
      parts.push(`<h4 class="audit-h">超限连续时段（${r.conflicts.length}）</h4>`);
      parts.push(r.conflicts.map((c) => `
        <div class="audit-conflict-card">
          <div class="audit-conflict-head">
            <span class="conflict-tag resource">${esc(c.resource)}</span>
            <b>${esc(c.start_label)} ~ ${esc(c.end_label)}</b>
            <span class="audit-peak">峰值 <b>${c.peak}</b> / 容量 ${c.capacity}</span>
          </div>
          <table class="mini-table">
            <thead><tr><th>场景</th><th>任务</th><th>占用</th><th>计划时段</th></tr></thead>
            <tbody>
              ${c.tasks.map((t) => `<tr>
                <td>${esc(t.scenario_name)}</td>
                <td><b>${esc(t.task_name)}</b></td>
                <td>${t.amount}</td>
                <td class="hint">${esc(fmtDT(t.start))} ~ ${esc(fmtDT(t.end))}</td>
              </tr>`).join("")}
            </tbody>
          </table>
        </div>`).join(""));
    }

    // 各场景计划状态
    parts.push(`<h4 class="audit-h">各场景计划（${r.scenarios.length}）</h4>`);
    parts.push(r.scenarios.map((sc) => {
      const head = sc.ok
        ? `<span class="audit-dot ok"></span><b>${esc(sc.name)}</b>
           <span class="hint">计划可行，${sc.scheduled}/${sc.total} 个任务已排定
           ${sc.window ? `（${esc(fmtDT(sc.window.start))} ~ ${esc(fmtDT(sc.window.end))}）` : ""}</span>`
        : `<span class="audit-dot err"></span><b>${esc(sc.name)}</b>
           <span class="hint">计划不可行：已排定 ${sc.scheduled}/${sc.total}，${sc.unscheduled.length} 个任务未参与占用合计</span>`;
      const diags = sc.diagnostics.length
        ? `<ul class="audit-diag">${sc.diagnostics.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>`
        : "";
      const unsched = sc.unscheduled.length
        ? `<div class="audit-unsched">未排定：` +
          sc.unscheduled.map((u) => `<span class="exec-chip exec-chip-skip">${esc(u.name)}</span>`).join(" ") +
          `</div>`
        : "";
      return `<div class="audit-scn-status">${head}${diags}${unsched}</div>`;
    }).join(""));

    $("#auditResult").innerHTML = parts.join("");
  }

  // -------------------------------------------------------------------------
  // 事件绑定
  // -------------------------------------------------------------------------
  $("#btnAudit").onclick = open;
  $("#auditBtnClose").onclick = close;
  $("#auditModal").addEventListener("click", (ev) => {
    if (ev.target === $("#auditModal")) close();
  });

  return { open };
})();
