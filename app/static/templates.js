/* 场景模板工作台：变量模板编辑、参数化预览、实例化、JSON 导出。
 * 依赖 app.js 暴露的 window.SchedulerApp（状态读写 / 加载实例 / toast）。 */
"use strict";

const TplApp = (() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // 模板编辑态
  const tstate = {
    id: null,                 // 已保存模板 id
    name: "",
    variables: [],            // [{name, type, label, default}]
    windowStart: "",
    windowEnd: "",
    resources: [],            // [{name, capacity}]
    nodes: [],                // [{id, name, durationExpr, resources, fixedExpr}]
    edges: [],                // [{source, target}]
    blackouts: [],            // [{id, name, startExpr, endExpr}]
    uid: 1,
  };
  let lastPreview = null;     // 最近一次预览响应

  const tuid = (p) => p + (tstate.uid++);

  // -------------------------------------------------------------------------
  // 载荷构造
  // -------------------------------------------------------------------------
  function buildTemplateData() {
    return {
      name: tstate.name,
      variables: tstate.variables.map((v) => ({
        name: v.name, type: v.type, label: v.label || v.name,
        default: v.default === "" || v.default == null ? null : v.default,
      })),
      scenario: {
        window_start: tstate.windowStart,
        window_end: tstate.windowEnd,
        resources: Object.fromEntries(tstate.resources.map((r) => [r.name, r.capacity])),
        nodes: tstate.nodes.map((n) => ({
          id: n.id, name: n.name,
          duration_minutes: exprOrNumber(n.durationExpr),
          resources: { ...n.resources },
          fixed_start: n.fixedExpr || null,
        })),
        edges: tstate.edges.filter((e) => e.source && e.target)
                           .map((e) => ({ source: e.source, target: e.target })),
        blackouts: tstate.blackouts
          .filter((b) => b.startExpr || b.endExpr)
          .map((b) => ({ name: b.name, start: b.startExpr, end: b.endExpr })),
      },
    };
  }

  // 时长字段：纯数字输出数字，否则按表达式字符串输出
  function exprOrNumber(v) {
    if (v == null || v === "") return null;
    const s = String(v).trim();
    if (/^\d+$/.test(s)) return Number(s);
    return s;
  }

  function collectParams() {
    const params = {};
    $$(".tpl-param-input").forEach((inp) => {
      params[inp.dataset.varName] = inp.value;
    });
    return params;
  }

  // -------------------------------------------------------------------------
  // 渲染：变量 / 资源 / 任务 / 依赖 / 禁排期
  // -------------------------------------------------------------------------
  function renderVariables() {
    const tb = $("#tplVarTable tbody");
    tb.innerHTML = tstate.variables.map((v, i) => `
      <tr>
        <td style="width:130px"><input data-tv="${i}" data-tvk="name" value="${esc(v.name)}" placeholder="base_date" class="tpl-expr" /></td>
        <td style="width:96px">
          <select data-tv="${i}" data-tvk="type">
            <option value="date" ${v.type === "date" ? "selected" : ""}>date</option>
            <option value="duration" ${v.type === "duration" ? "selected" : ""}>duration</option>
            <option value="offset" ${v.type === "offset" ? "selected" : ""}>offset</option>
          </select>
        </td>
        <td><input data-tv="${i}" data-tvk="label" value="${esc(v.label || "")}" placeholder="显示名" /></td>
        <td style="width:150px">
          <input type="${v.type === "date" ? "datetime-local" : "number"}" step="300" min="0"
                 data-tv="${i}" data-tvk="default" value="${esc(v.default ?? "")}"
                 title="${v.type === "date" ? "默认基准日期" : "默认分钟数"}" />
        </td>
        <td style="width:34px"><button class="btn btn-small del" data-tv-del="${i}">✕</button></td>
      </tr>`).join("");
    renderNodeResourceCells();
    renderParamForm();
  }

  function renderResources() {
    const tb = $("#tplResourceTable tbody");
    tb.innerHTML = tstate.resources.map((r, i) => `
      <tr>
        <td><input data-tr="${i}" data-trk="name" value="${esc(r.name)}" /></td>
        <td style="width:80px"><input type="number" min="0" step="1" data-tr="${i}" data-trk="capacity" value="${r.capacity}" /></td>
        <td style="width:34px"><button class="btn btn-small del" data-tr-del="${i}">✕</button></td>
      </tr>`).join("");
    renderNodeResourceCells();
  }

  function renderNodes() {
    const tb = $("#tplNodeTable tbody");
    tb.innerHTML = tstate.nodes.map((n, i) => `
      <tr>
        <td style="width:70px"><input data-tn="${i}" data-tnk="id" value="${esc(n.id)}" class="tpl-expr" /></td>
        <td style="min-width:90px"><input data-tn="${i}" data-tnk="name" value="${esc(n.name)}" /></td>
        <td style="width:120px" title="数字分钟，或 {{时长变量}} / {{base_dur}} + 10m">
          <input data-tn="${i}" data-tnk="durationExpr" value="${esc(n.durationExpr)}" class="tpl-expr" placeholder="30 或 {{dur}}" />
        </td>
        <td class="tpl-node-res" data-tres-for="${esc(n.id)}" style="min-width:100px"></td>
        <td style="min-width:170px">
          <input data-tn="${i}" data-tnk="fixedExpr" value="${esc(n.fixedExpr || "")}"
                 class="tpl-expr" placeholder='留空=弹性；或 {{end(a)+30m}}' />
        </td>
        <td style="width:34px"><button class="btn btn-small del" data-tn-del="${i}">✕</button></td>
      </tr>`).join("");
    renderNodeResourceCells();
    renderEdges();
  }

  function renderNodeResourceCells() {
    $$(".tpl-node-res").forEach((td) => {
      const nid = td.dataset.tresFor;
      const n = tstate.nodes.find((x) => x.id === nid);
      if (!n) return;
      if (!tstate.resources.length) {
        td.innerHTML = `<span class="hint">无资源</span>`;
        return;
      }
      td.innerHTML = `<div style="display:flex;gap:4px;flex-wrap:wrap">` +
        tstate.resources.map((r) => `
          <label style="display:flex;align-items:center;gap:2px;font-size:10px;color:var(--muted)">
            ${esc(r.name)}
            <input type="number" min="0" step="1" style="width:44px;padding:2px 4px"
                   data-tnres="${esc(nid)}" data-trname="${esc(r.name)}"
                   value="${(n.resources || {})[r.name] ?? 0}" />
          </label>`).join("") + `</div>`;
    });
  }

  function renderEdges() {
    const tb = $("#tplEdgeTable tbody");
    const opts = (sel) => `<option value="">—</option>` +
      tstate.nodes.map((n) => `<option value="${esc(n.id)}" ${n.id === sel ? "selected" : ""}>${esc(n.name)}</option>`).join("");
    tb.innerHTML = tstate.edges.map((e, i) => `
      <tr>
        <td><select data-te="${i}" data-tek="source">${opts(e.source)}</select></td>
        <td style="width:24px;text-align:center;color:var(--muted)">→</td>
        <td><select data-te="${i}" data-tek="target">${opts(e.target)}</select></td>
        <td style="width:34px"><button class="btn btn-small del" data-te-del="${i}">✕</button></td>
      </tr>`).join("");
  }

  function renderBlackouts() {
    const tb = $("#tplBlackoutTable tbody");
    tb.innerHTML = tstate.blackouts.map((b, i) => `
      <tr>
        <td style="min-width:80px"><input data-tb="${i}" data-tbk="name" value="${esc(b.name)}" /></td>
        <td><input data-tb="${i}" data-tbk="startExpr" value="${esc(b.startExpr || "")}" class="tpl-expr"
                   placeholder="{{base_date + 1d @ 00:00}}" /></td>
        <td><input data-tb="${i}" data-tbk="endExpr" value="${esc(b.endExpr || "")}" class="tpl-expr"
                   placeholder="{{base_date + 1d @ 00:30}}" /></td>
        <td style="width:34px"><button class="btn btn-small del" data-tb-del="${i}">✕</button></td>
      </tr>`).join("");
  }

  function renderAll() {
    $("#tplName").value = tstate.name;
    $("#tplWinStart").value = tstate.windowStart;
    $("#tplWinEnd").value = tstate.windowEnd;
    renderVariables();
    renderResources();
    renderNodes();
    renderBlackouts();
  }

  // -------------------------------------------------------------------------
  // 参数表单
  // -------------------------------------------------------------------------
  function renderParamForm() {
    const box = $("#tplParamForm");
    if (!tstate.variables.length) {
      box.innerHTML = `<span class="hint">模板还没有变量。先在上方添加变量（基准日期 / 时长 / 偏移），再在字段中用 {{变量名}} 引用。</span>`;
      return;
    }
    box.innerHTML = tstate.variables.map((v) => {
      const typeText = { date: "基准日期", duration: "任务时长(分)", offset: "前置结束偏移(分)" }[v.type];
      const inputType = v.type === "date" ? "datetime-local" : "number";
      return `<div class="tpl-param-row">
        <label title="${esc(v.name)}">${esc(v.label || v.name)}</label>
        <span class="tpl-param-type">${typeText}</span>
        <input class="tpl-param-input" type="${inputType}" ${v.type === "date" ? 'step="300"' : 'min="0"'}
               data-var-name="${esc(v.name)}"
               value="${esc(v.default ?? "")}" placeholder="${v.type === "date" ? "选择日期时间" : "分钟数"}" />
      </div>`;
    }).join("");
  }

  // -------------------------------------------------------------------------
  // 编辑事件委托
  // -------------------------------------------------------------------------
  $("#tplModal").addEventListener("input", onTplChange);
  $("#tplModal").addEventListener("change", onTplChange);

  function syncHeaderFields() {
    tstate.name = $("#tplName").value;
    tstate.windowStart = $("#tplWinStart").value;
    tstate.windowEnd = $("#tplWinEnd").value;
  }

  function onTplChange(ev) {
    const t = ev.target;

    if (t.id === "tplName" || t.id === "tplWinStart" || t.id === "tplWinEnd") {
      syncHeaderFields();
      return;
    }
    if (t.dataset.tvk) {
      const v = tstate.variables[+t.dataset.tv];
      const oldType = v.type;
      v[t.dataset.tvk] = t.dataset.tvk === "type" ? t.value : t.value;
      if (t.dataset.tvk === "type" && oldType !== v.type) {
        v.default = "";
        renderVariables();
      } else if (t.dataset.tvk === "name" || t.dataset.tvk === "label") {
        renderParamForm();
      }
      return;
    }
    if (t.dataset.trk) {
      const r = tstate.resources[+t.dataset.tr];
      const oldName = r.name;
      r[t.dataset.trk] = t.dataset.trk === "capacity" ? Math.max(0, +t.value || 0) : t.value;
      if (t.dataset.trk === "name") {
        tstate.nodes.forEach((n) => {
          if (oldName in (n.resources || {})) {
            n.resources[t.value] = n.resources[oldName];
            delete n.resources[oldName];
          }
        });
        renderNodeResourceCells();
      }
      return;
    }
    if (t.dataset.tnk) {
      const n = tstate.nodes[+t.dataset.tn];
      const oldId = n.id;
      n[t.dataset.tnk] = t.value;
      if (t.dataset.tnk === "id" && oldId !== t.value) {
        tstate.edges.forEach((e) => {
          if (e.source === oldId) e.source = t.value;
          if (e.target === oldId) e.target = t.value;
        });
        renderEdges();
        renderNodeResourceCells();
      }
      return;
    }
    if (t.dataset.tnres) {
      const n = tstate.nodes.find((x) => x.id === t.dataset.tnres);
      n.resources = n.resources || {};
      const amount = +t.value || 0;
      if (amount > 0) n.resources[t.dataset.trname] = amount;
      else delete n.resources[t.dataset.trname];
      return;
    }
    if (t.dataset.tek) {
      tstate.edges[+t.dataset.te][t.dataset.tek] = t.value;
      return;
    }
    if (t.dataset.tbk) {
      tstate.blackouts[+t.dataset.tb][t.dataset.tbk] = t.value;
      return;
    }

    if (t.classList.contains("del")) {
      if (t.dataset.tvDel !== undefined) {
        tstate.variables.splice(+t.dataset.tvDel, 1);
        renderVariables();
      } else if (t.dataset.trDel !== undefined) {
        const [r] = tstate.resources.splice(+t.dataset.trDel, 1);
        tstate.nodes.forEach((n) => delete (n.resources || {})[r.name]);
        renderResources();
      } else if (t.dataset.tnDel !== undefined) {
        const n = tstate.nodes[+t.dataset.tnDel];
        tstate.nodes.splice(+t.dataset.tnDel, 1);
        tstate.edges = tstate.edges.filter((e) => e.source !== n.id && e.target !== n.id);
        renderNodes();
      } else if (t.dataset.teDel !== undefined) {
        tstate.edges.splice(+t.dataset.teDel, 1);
        renderEdges();
      } else if (t.dataset.tbDel !== undefined) {
        tstate.blackouts.splice(+t.dataset.tbDel, 1);
        renderBlackouts();
      }
    }
  }

  // -------------------------------------------------------------------------
  // 增行按钮
  // -------------------------------------------------------------------------
  $("#tplBtnAddVar").onclick = () => {
    const base = "var" + (tstate.variables.length + 1);
    let name = base, k = 1;
    while (tstate.variables.some((v) => v.name === name)) name = base + (++k);
    tstate.variables.push({ name, type: "duration", label: name, default: "" });
    renderVariables();
  };
  $("#tplBtnAddResource").onclick = () => {
    const base = "资源" + (tstate.resources.length + 1);
    let name = base, k = 1;
    while (tstate.resources.some((r) => r.name === name)) name = base + (++k);
    tstate.resources.push({ name, capacity: 1 });
    renderResources();
  };
  $("#tplBtnAddNode").onclick = () => {
    tstate.nodes.push({
      id: tuid("t"), name: "任务" + (tstate.nodes.length + 1),
      durationExpr: "30", resources: {}, fixedExpr: "",
    });
    renderNodes();
  };
  $("#tplBtnAddEdge").onclick = () => {
    if (!tstate.nodes.length) return SchedulerApp.toast("请先添加任务", true);
    tstate.edges.push({ source: tstate.nodes[0].id, target: tstate.nodes[tstate.nodes.length - 1].id });
    renderEdges();
  };
  $("#tplBtnAddBlackout").onclick = () => {
    tstate.blackouts.push({
      id: tuid("tb"), name: "禁排期" + (tstate.blackouts.length + 1),
      startExpr: "", endExpr: "",
    });
    renderBlackouts();
  };

  // -------------------------------------------------------------------------
  // 从主编辑器场景生成模板（窗口/禁排期时间 → 基准日期表达式）
  // -------------------------------------------------------------------------
  $("#tplBtnFromEditor").onclick = () => {
    const s = SchedulerApp.getState();
    if (!s.windowStart || !s.windowEnd) {
      return SchedulerApp.toast("主编辑器中还没有有效的维护窗口", true);
    }
    const baseVarName = uniqueName("base_date", tstate.variables.map((v) => v.name));
    tstate.variables = tstate.variables.filter((v) => v.type !== "date");
    tstate.variables.unshift({
      name: baseVarName, type: "date", label: "基准日期",
      default: s.windowStart.slice(0, 10),
    });

    const dayOffset = (baseDate, targetISO) => {
      const b = new Date(baseDate + "T00:00");
      const t = new Date(targetISO);
      return Math.round((new Date(t.getFullYear(), t.getMonth(), t.getDate()) -
        new Date(b.getFullYear(), b.getMonth(), b.getDate())) / 86400000);
    };
    const clockOf = (iso) => iso.slice(11, 16);
    const toExpr = (iso) => {
      if (!iso) return "";
      const off = dayOffset(s.windowStart.slice(0, 10), iso);
      const hm = clockOf(iso);
      if (off === 0) return `{{${baseVarName} @ ${hm}}}`;
      if (off === 1) return `{{${baseVarName} + 1d @ ${hm}}}`;
      return `{{${baseVarName} + ${off}d @ ${hm}}}`;
    };

    tstate.windowStart = toExpr(s.windowStart);
    tstate.windowEnd = toExpr(s.windowEnd);
    tstate.resources = s.resources.map((r) => ({ ...r }));
    // 保留任务原有 id；固定时间转成基准日期表达式（之后可手工改为 end() 偏移）
    tstate.nodes = s.nodes.map((n) => ({
      id: n.id, name: n.name,
      durationExpr: String(n.duration_minutes),
      resources: { ...n.resources },
      fixedExpr: n.fixed_start ? toExpr(n.fixed_start) : "",
    }));
    tstate.edges = s.edges.map((e) => ({ ...e }));
    tstate.blackouts = s.blackouts.map((b) => ({
      id: b.id || tuid("tb"), name: b.name,
      startExpr: toExpr(b.start), endExpr: toExpr(b.end),
    }));
    tstate.uid = Math.max(
      s.uid || 1,
      ...tstate.nodes.map((n) => numSuffix(n.id, "t")).filter((x) => x > 0),
      ...tstate.blackouts.map((b) => numSuffix(b.id, "tb")).filter((x) => x > 0)
    ) + 1;
    tstate.id = null;
    $("#tplSelect").value = "";
    renderAll();
    SchedulerApp.toast("已从当前场景生成模板，可把任务的固定开始改写为 {{end(前置)+30m}} 形式");
  };

  function uniqueName(base, used) {
    let name = base, k = 2;
    while (used.includes(name)) name = base + (k++);
    return name;
  }
  function numSuffix(id, prefix) {
    const m = String(id).match(/^[A-Za-z_]+(\d+)$/);
    return m ? Number(m[1]) : 0;
  }

  // -------------------------------------------------------------------------
  // 模板 CRUD
  // -------------------------------------------------------------------------
  async function loadTemplateList() {
    const resp = await fetch("/api/templates");
    const list = await resp.json();
    $("#tplSelect").innerHTML = `<option value="">— 选择已保存模板 —</option>` +
      list.map((t) => `<option value="${t.id}">${esc(t.name)}（${t.updated_at.replace("T", " ").slice(0, 16)}）</option>`).join("");
  }

  function loadFromData(data) {
    const scen = data.scenario || data; // 兼容平铺
    tstate.name = data.name || "";
    tstate.variables = (data.variables || []).map((v) => ({
      name: v.name, type: v.type || "duration", label: v.label || v.name,
      default: v.default ?? "",
    }));
    tstate.windowStart = scen.window_start || "";
    tstate.windowEnd = scen.window_end || "";
    tstate.resources = Object.entries(scen.resources || {}).map(([name, capacity]) => ({ name, capacity: +capacity }));
    tstate.nodes = (scen.nodes || []).map((n) => ({
      id: n.id, name: n.name || n.id,
      durationExpr: typeof n.duration_minutes === "number" ? String(n.duration_minutes)
                    : (n.duration_minutes || ""),
      resources: n.resources || {},
      fixedExpr: n.fixed_start || "",
    }));
    tstate.edges = (scen.edges || []).map((e) => ({ ...e }));
    tstate.blackouts = (scen.blackouts || []).map((b, i) => ({
      id: "tb" + (i + 1), name: b.name || `禁排期${i + 1}`,
      startExpr: b.start || "", endExpr: b.end || "",
    }));
    tstate.uid = tstate.nodes.length + tstate.blackouts.length + 1;
    renderAll();
  }

  function resetTemplate() {
    tstate.id = null;
    tstate.name = "";
    tstate.variables = [];
    tstate.windowStart = "";
    tstate.windowEnd = "";
    tstate.resources = [];
    tstate.nodes = [];
    tstate.edges = [];
    tstate.blackouts = [];
    tstate.uid = 1;
    lastPreview = null;
    $("#tplIssueBox").classList.add("hidden");
    $("#tplResolvedBox").classList.add("hidden");
    $("#tplGanttWrap").classList.add("hidden");
    renderAll();
  }

  $("#tplBtnNew").onclick = () => { resetTemplate(); };

  $("#tplBtnSave").onclick = async () => {
    syncHeaderFields();
    const name = tstate.name.trim();
    if (!name) return SchedulerApp.toast("请填写模板名称", true);
    const resp = await fetch("/api/templates", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, data: buildTemplateData() }),
    });
    if (!resp.ok) return showRequestError(resp, "模板保存失败");
    const rj = await resp.json();
    tstate.id = rj.id;
    tstate.name = rj.name;
    $("#tplName").value = rj.name;
    await loadTemplateList();
    $("#tplSelect").value = rj.id;
    SchedulerApp.toast(rj.updated ? `模板「${rj.name}」已更新` : `模板「${rj.name}」已保存`);
  };

  $("#tplBtnDelete").onclick = async () => {
    const id = $("#tplSelect").value || tstate.id;
    if (!id) return SchedulerApp.toast("请先选择要删除的模板", true);
    if (!confirm("确认删除该模板？已实例化的场景不受影响。")) return;
    const resp = await fetch(`/api/templates/${id}`, { method: "DELETE" });
    if (!resp.ok) return SchedulerApp.toast("删除失败", true);
    resetTemplate();
    await loadTemplateList();
    SchedulerApp.toast("模板已删除");
  };

  $("#tplSelect").addEventListener("change", async () => {
    const id = $("#tplSelect").value;
    if (!id) return;
    const resp = await fetch(`/api/templates/${id}`);
    if (!resp.ok) return SchedulerApp.toast("模板加载失败", true);
    const tpl = await resp.json();
    tstate.id = tpl.id;
    loadFromData(tpl.data);
    $("#tplName").value = tpl.name;
    tstate.name = tpl.name;
    lastPreview = null;
    $("#tplIssueBox").classList.add("hidden");
    $("#tplResolvedBox").classList.add("hidden");
    $("#tplGanttWrap").classList.add("hidden");
  });

  // -------------------------------------------------------------------------
  // 预览
  // -------------------------------------------------------------------------
  $("#tplBtnPreview").onclick = () => preview(false);

  async function preview(silent) {
    syncHeaderFields();
    const body = { data: buildTemplateData(), params: collectParams() };
    const resp = await fetch("/api/templates/preview", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (resp.status === 422) {
      const err = await resp.json().catch(() => ({}));
      if (err.detail && typeof err.detail === "object" && err.detail.issues) {
        lastPreview = { issues: err.detail.issues, scenario: null, result: null,
                        resolved: null };
        renderPreview();
        return;
      }
      SchedulerApp.toast(typeof err.detail === "string" ? err.detail : "模板解析失败", true);
      return;
    }
    if (!resp.ok) {
      if (!silent) SchedulerApp.toast(`预览失败 HTTP ${resp.status}`, true);
      return;
    }
    lastPreview = await resp.json();
    renderPreview();
  }

  function renderPreview() {
    const pv = lastPreview;
    const box = $("#tplIssueBox");
    const issues = pv.issues || [];
    if (issues.length) {
      const hasError = issues.some((i) => i.severity === "error");
      box.classList.remove("hidden");
      box.className = "tpl-issue-box " + (hasError ? "has-error" : "has-warn");
      box.innerHTML = (hasError ? "❌ 解析问题：" : "⚠️ 时间越界告警（仍可排程查看）：") +
        issues.map((i) => `
          <div class="tpl-issue-item">
            <span class="tpl-issue-tag ${i.severity}">${i.severity === "error" ? "错误" : "警告"}</span>
            <span><b>${esc(codeLabel(i.code))}</b> ${esc(i.message)}</span>
          </div>`).join("");
    } else {
      box.classList.add("hidden");
      box.innerHTML = "";
    }

    const rbox = $("#tplResolvedBox");
    if (pv.resolved) {
      rbox.classList.remove("hidden");
      const rv = pv.resolved;
      const paramChips = Object.entries(rv.variables || {}).map(
        ([k, v]) => `<div><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`
      ).join("");
      const fixedChips = Object.entries(rv.fixed_starts || {}).map(
        ([k, v]) => `<div><span class="k">${esc(nodeName(k))} 固定于</span><span class="v">${esc(v)}</span></div>`
      ).join("");
      rbox.innerHTML = `<h4>✓ 解析后的参数值</h4>
        <div class="tpl-resolved-grid">
          <div><span class="k">窗口</span></div>
          <div class="v">${esc(rv.window?.start)} → ${esc(rv.window?.end)}</div>
          ${paramChips}${fixedChips}
        </div>`;
    } else {
      rbox.classList.add("hidden");
    }

    if (pv.result && pv.scenario) {
      drawMiniGantt(pv.scenario, pv.result);
      const r = pv.result;
      const s = r.stats;
      const stamp = r.feasible
        ? `✓ 排程可行：${s.scheduled}/${s.total} 任务，总跨度 ${fmtDur(s.makespan_minutes)}`
        : `✗ ${s.conflicts} 个冲突，${s.scheduled}/${s.total} 任务完成排程（实例化后可在主编辑器查看完整冲突定位）`;
      const line = document.createElement("div");
      line.style.marginTop = "6px";
      line.style.color = r.feasible ? "#78e0a8" : "#ff9aa5";
      line.textContent = stamp;
      rbox.appendChild(line);
    } else {
      $("#tplGanttWrap").classList.add("hidden");
    }

    if (pv.scenario && !$("#tplInstanceName").value) {
      $("#tplInstanceName").value = (tstate.name || "模板") + " 实例 " +
        new Date().toLocaleString("sv-SE", { hour12: false }).slice(0, 16).replace(" ", " ");
    }
  }

  function codeLabel(code) {
    return {
      expression_error: "表达式错误",
      unknown_variable: "未定义变量",
      unknown_node: "任务不存在",
      type_error: "类型错误",
      param_error: "参数错误",
      variable_cycle: "循环引用",
      anchor_unresolved: "锚点不可解析",
      datetime_error: "时间错误",
      out_of_window: "时间越界",
      out_of_window_blackout: "禁排期越界",
    }[code] || code;
  }

  function nodeName(id) {
    return tstate.nodes.find((n) => n.id === id)?.name || id;
  }
  function fmtDur(mins) {
    const h = Math.floor(mins / 60), m = mins % 60;
    return h ? (m ? `${h}小时${m}分` : `${h}小时`) : `${m}分`;
  }

  // 迷你甘特（div 百分比定位）
  function drawMiniGantt(scenario, result) {
    const wrap = $("#tplGanttWrap");
    wrap.classList.remove("hidden");
    const t0 = new Date(scenario.window_start).getTime();
    const t1 = new Date(scenario.window_end).getTime();
    const span = Math.max(1, t1 - t0);
    const pct = (iso) => Math.min(100, Math.max(0, (new Date(iso).getTime() - t0) / span * 100));
    const wpct = (wMin) => Math.max(0.3, wMin * 60000 / span * 100);

    // 时间轴刻度
    const axis = $("#tplGanttAxis");
    axis.innerHTML = "";
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const t = new Date(t0 + span * i / ticks);
      const p = (n) => String(n).padStart(2, "0");
      const lab = `${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
      const sp = document.createElement("span");
      sp.style.left = (i / ticks * 100) + "%";
      sp.textContent = lab;
      axis.appendChild(sp);
    }

    const rows = $("#tplGanttRows");
    rows.innerHTML = "";
    const nameById = Object.fromEntries(scenario.nodes.map((n) => [n.id, n.name]));

    const makeRow = (label) => {
      const row = document.createElement("div");
      row.className = "tpl-gantt-row";
      const lab = document.createElement("div");
      lab.className = "row-label";
      lab.title = label;
      lab.textContent = label;
      const track = document.createElement("div");
      track.className = "tpl-gantt-track";
      row.append(lab, track);
      rows.appendChild(row);
      return track;
    };

    result.items.forEach((it) => {
      const track = makeRow(it.name + (it.fixed ? " 🔒" : ""));
      // 禁排期底纹
      scenario.blackouts.forEach((b) => {
        const bs = Math.max(t0, new Date(b.start).getTime());
        const be = Math.min(t1, new Date(b.end).getTime());
        if (be <= bs) return;
        const mark = document.createElement("div");
        mark.className = "tpl-mini-blackout";
        mark.style.left = ((bs - t0) / span * 100) + "%";
        mark.style.width = ((be - bs) / span * 100) + "%";
        mark.title = b.name;
        track.appendChild(mark);
      });
      const bar = document.createElement("div");
      bar.className = "tpl-mini-bar " + (it.fixed ? "fixed" : "flex");
      bar.style.left = pct(it.start) + "%";
      bar.style.width = wpct(it.duration_minutes) + "%";
      bar.textContent = `${it.start_label}–${it.end_label}`;
      bar.title = `${it.name}：${it.start} → ${it.end}`;
      track.appendChild(bar);
    });

    result.unscheduled.forEach((id) => {
      const track = makeRow(nameById[id] || id);
      const ghost = document.createElement("div");
      ghost.className = "tpl-mini-bar ghost";
      ghost.style.left = "0%";
      ghost.style.width = "8%";
      ghost.textContent = "✕ 未排程";
      track.appendChild(ghost);
    });
  }

  // -------------------------------------------------------------------------
  // 实例化
  // -------------------------------------------------------------------------
  $("#tplBtnInstantiate").onclick = async () => {
    syncHeaderFields();
    const name = $("#tplInstanceName").value.trim();
    if (!name) return SchedulerApp.toast("请填写实例名称", true);
    const body = {
      data: buildTemplateData(),
      params: collectParams(),
      name,
    };
    if (tstate.id) body.template_id = tstate.id;
    const resp = await fetch("/api/templates/instantiate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (resp.status === 422) {
      const err = await resp.json().catch(() => ({}));
      if (err.detail && typeof err.detail === "object" && err.detail.issues) {
        lastPreview = { issues: err.detail.issues, scenario: null, result: null, resolved: null };
        renderPreview();
      }
      return SchedulerApp.toast(typeof err.detail === "string" ? err.detail : "实例化失败：存在解析错误", true);
    }
    if (!resp.ok) return SchedulerApp.toast(`实例化失败 HTTP ${resp.status}`, true);
    const inst = await resp.json();
    SchedulerApp.loadInstance(inst.data, inst.name, inst.id);
    await SchedulerApp.refreshScenarioList();
    closeModal();
    SchedulerApp.toast(`已实例化并保存为独立场景「${inst.name}」`);
  };

  // -------------------------------------------------------------------------
  // 导出模板 JSON
  // -------------------------------------------------------------------------
  $("#tplBtnExportTpl").onclick = async () => {
    syncHeaderFields();
    const resp = await fetch("/api/templates/export", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: buildTemplateData(), params: collectParams() }),
    });
    if (!resp.ok) {
      await preview(true);
      return SchedulerApp.toast("导出失败：模板存在解析错误，请先根据预览修正", true);
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "maintenance-template.json";
    a.click();
    URL.revokeObjectURL(url);
    SchedulerApp.toast("已导出模板 JSON（含模板、参数、解析值、实例场景与排程结果）");
  };

  async function showRequestError(resp, prefix) {
    const err = await resp.json().catch(() => ({}));
    SchedulerApp.toast(`${prefix}：${err.detail || resp.status}`, true);
  }

  // -------------------------------------------------------------------------
  // 开关
  // -------------------------------------------------------------------------
  function openModal() {
    $("#tplModal").classList.remove("hidden");
    loadTemplateList();
  }
  function closeModal() {
    $("#tplModal").classList.add("hidden");
  }

  $("#btnTemplates").onclick = openModal;
  $("#tplBtnClose").onclick = closeModal;
  $("#tplModal").addEventListener("click", (ev) => {
    if (ev.target === $("#tplModal")) closeModal();
  });

  return { openModal, loadTemplateList };
})();
