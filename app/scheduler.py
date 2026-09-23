"""维护窗口排程核心：DAG 校验（环检测）、依赖排序、资源/禁排期约束求解。

输入输出全部使用 naive ISO datetime 字符串（由前端本地时间生成）。
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any

MAX_ITERATIONS = 50_000


def _parse_dt(value: str | datetime, field: str = "时间") -> datetime:
    if isinstance(value, datetime):
        dt = value
    else:
        text = str(value).strip() if value is not None else ""
        if not text:
            raise ValueError(f"缺少必填的{field}")
        if text.endswith("Z"):
            text = text[:-1]
        try:
            dt = datetime.fromisoformat(text)
        except ValueError:
            raise ValueError(f"{field}格式无效：{text}（应为 YYYY-MM-DDTHH:MM）")
    if dt.tzinfo is not None:
        dt = dt.replace(tzinfo=None)
    return dt


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M")


def _fmt(dt: datetime) -> str:
    return dt.strftime("%m-%d %H:%M")


# ---------------------------------------------------------------------------
# 数据规整
# ---------------------------------------------------------------------------

def normalize(payload: dict[str, Any]) -> dict[str, Any]:
    """校验并规整前端输入；结构错误抛出 ValueError。"""
    if not isinstance(payload, dict):
        raise ValueError("请求体必须是 JSON 对象")

    window_start = _parse_dt(payload.get("window_start"), "维护窗口开始时间")
    window_end = _parse_dt(payload.get("window_end"), "维护窗口结束时间")
    if window_start >= window_end:
        raise ValueError("维护窗口开始时间必须早于结束时间")

    raw_nodes = payload.get("nodes", [])
    if not isinstance(raw_nodes, list):
        raise ValueError("nodes 必须是数组")

    nodes: dict[str, dict[str, Any]] = {}
    for raw in raw_nodes:
        nid = str(raw.get("id", "")).strip()
        if not nid:
            raise ValueError("存在缺少 id 的维护项")
        if nid in nodes:
            raise ValueError(f"维护项 id 重复：{nid}")
        try:
            duration = int(raw.get("duration_minutes"))
        except (TypeError, ValueError):
            raise ValueError(f"维护项 {nid} 的时长必须是整数分钟")
        if duration <= 0:
            raise ValueError(f"维护项 {nid} 的时长必须大于 0")

        resources: dict[str, float] = {}
        raw_res = raw.get("resources") or {}
        if not isinstance(raw_res, dict):
            raise ValueError(f"维护项 {nid} 的 resources 必须是对象")
        for rname, amount in raw_res.items():
            try:
                amount = float(amount)
            except (TypeError, ValueError):
                raise ValueError(f"维护项 {nid} 的资源 {rname} 占用必须是数字")
            if amount < 0:
                raise ValueError(f"维护项 {nid} 的资源 {rname} 占用不能为负")
            if amount > 0:
                resources[str(rname)] = amount

        fixed_start = raw.get("fixed_start")
        fixed_dt = (
            _parse_dt(fixed_start, f"维护项 {nid} 的固定开始时间")
            if fixed_start not in (None, "", False) else None
        )

        nodes[nid] = {
            "id": nid,
            "name": str(raw.get("name") or nid),
            "duration": timedelta(minutes=duration),
            "duration_minutes": duration,
            "resources": resources,
            "fixed_start": fixed_dt,
        }

    capacities: dict[str, float] = {}
    for rname, cap in (payload.get("resources") or {}).items():
        try:
            capacities[str(rname)] = float(cap)
        except (TypeError, ValueError):
            raise ValueError(f"资源 {rname} 的容量必须是数字")

    raw_edges = payload.get("edges", [])
    edges: list[tuple[str, str]] = []
    seen_edges: set[tuple[str, str]] = set()
    for raw in raw_edges:
        s = str(raw.get("source", "")).strip()
        t = str(raw.get("target", "")).strip()
        if not s or not t:
            raise ValueError("依赖边必须同时包含 source 和 target")
        if (s, t) in seen_edges:
            continue
        seen_edges.add((s, t))
        edges.append((s, t))

    blackouts: list[dict[str, Any]] = []
    for raw in payload.get("blackouts", []):
        label = f"禁排期「{raw.get('name') or ''}」"
        bs = _parse_dt(raw.get("start"), f"{label}开始时间")
        be = _parse_dt(raw.get("end"), f"{label}结束时间")
        if bs >= be:
            raise ValueError(f"禁排期 {raw.get('name', '')} 的开始必须早于结束")
        blackouts.append({
            "name": str(raw.get("name") or "禁排期"),
            "start": bs,
            "end": be,
        })
    blackouts.sort(key=lambda b: b["start"])

    return {
        "window_start": window_start,
        "window_end": window_end,
        "nodes": nodes,
        "edges": edges,
        "capacities": capacities,
        "blackouts": blackouts,
    }


# ---------------------------------------------------------------------------
# DAG 分析
# ---------------------------------------------------------------------------

def find_cycles(nodes: dict[str, dict], edges: list[tuple[str, str]]) -> list[list[str]]:
    """Tarjan SCC，返回所有成环节点环（含自环），每个环按可达顺序排列。"""
    adj: dict[str, list[str]] = {nid: [] for nid in nodes}
    for s, t in edges:
        if s in adj and t in adj:
            adj[s].append(t)

    index_of: dict[str, int] = {}
    low: dict[str, int] = {}
    stack: list[str] = []
    on_stack: set[str] = set()
    counter = 0
    sccs: list[list[str]] = []

    def strongconnect(v: str) -> None:
        nonlocal counter
        work: list[tuple[str, int]] = [(v, 0)]
        index_of[v] = low[v] = counter
        counter += 1
        stack.append(v)
        on_stack.add(v)

        while work:
            node, pi = work[-1]
            if pi < len(adj[node]):
                w = adj[node][pi]
                work[-1] = (node, pi + 1)
                if w not in index_of:
                    index_of[w] = low[w] = counter
                    counter += 1
                    stack.append(w)
                    on_stack.add(w)
                    work.append((w, 0))
                elif w in on_stack:
                    low[node] = min(low[node], index_of[w])
            else:
                work.pop()
                if low[node] == index_of[node]:
                    comp: list[str] = []
                    while True:
                        w = stack.pop()
                        on_stack.discard(w)
                        comp.append(w)
                        if w == node:
                            break
                    sccs.append(comp)
                if work:
                    parent = work[-1][0]
                    low[parent] = min(low[parent], low[node])

    for nid in nodes:
        if nid not in index_of:
            strongconnect(nid)

    cycles: list[list[str]] = []
    for comp in sccs:
        if len(comp) == 1:
            v = comp[0]
            if v not in adj[v]:
                continue
            cycles.append([v])
            continue
        # 沿 SCC 内的边还原一条可读的环路径
        comp_set = set(comp)
        start = sorted(comp)[0]
        path = [start]
        visited = {start}
        cur = start
        while True:
            nxt = next((w for w in adj[cur] if w in comp_set and w not in visited), None)
            if nxt is None:
                break
            path.append(nxt)
            visited.add(nxt)
            cur = nxt
            if start in adj[cur]:
                break
        cycles.append(path)
    return cycles


def topo_order(
    nodes: dict[str, dict], edges: list[tuple[str, str]], cyclic: set[str]
) -> list[str]:
    """Kahn 拓扑排序；固定时间任务优先，其余按 id 排序。成环节点被排除。"""
    indeg: dict[str, int] = {nid: 0 for nid in nodes if nid not in cyclic}
    adj: dict[str, list[str]] = {nid: [] for nid in nodes if nid not in cyclic}
    for s, t in edges:
        if s in cyclic or t in cyclic:
            continue
        adj[s].append(t)
        indeg[t] += 1

    def key(nid: str) -> tuple[int, str]:
        return (0 if nodes[nid]["fixed_start"] is not None else 1, nid)

    ready = sorted([nid for nid, d in indeg.items() if d == 0], key=key)
    order: list[str] = []
    while ready:
        nid = ready.pop(0)
        order.append(nid)
        for w in adj[nid]:
            indeg[w] -= 1
            if indeg[w] == 0:
                ready.append(w)
                ready.sort(key=key)
    return order


# ---------------------------------------------------------------------------
# 排程求解
# ---------------------------------------------------------------------------

def _blackout_at(t: datetime, end: datetime, blackouts: list[dict]) -> dict | None:
    for b in blackouts:
        if t < b["end"] and b["start"] < end:
            return b
    return None


def _capacity_violations(
    start: datetime,
    end: datetime,
    need: dict[str, float],
    capacities: dict[str, float],
    occupancy: dict[str, list[dict]],
    self_id: str | None = None,
) -> list[dict]:
    """检查给定任务区间上的资源容量冲突，返回冲突明细。"""
    violations = []
    for rname, amount in need.items():
        cap = capacities.get(rname, 1.0)
        if amount > cap:
            violations.append({
                "resource": rname,
                "capacity": cap,
                "demand": amount,
                "at": start,
                "blockers": [],
            })
            continue
        intervals = [
            iv for iv in occupancy.get(rname, [])
            if iv["node"] != self_id and iv["start"] < end and start < iv["end"]
        ]
        # 事件点扫描：所有占用区间 start/end 与任务区间对齐
        points = sorted({start, end} | {iv["start"] for iv in intervals} | {iv["end"] for iv in intervals})
        for i in range(len(points) - 1):
            p, q = points[i], points[i + 1]
            if q <= start or p >= end or p == q:
                continue
            active = [iv for iv in intervals if iv["start"] <= p and iv["end"] >= q]
            used = sum(iv["amount"] for iv in active)
            if used + amount > cap + 1e-9:
                active.sort(key=lambda iv: -iv["amount"])
                violations.append({
                    "resource": rname,
                    "capacity": cap,
                    "demand": round(used + amount, 6),
                    "at": p,
                    "blockers": [iv["node"] for iv in active][:5],
                })
                break
    return violations


def _find_slot(
    earliest: datetime,
    duration: timedelta,
    need: dict[str, float],
    window_end: datetime,
    blackouts: list[dict],
    capacities: dict[str, float],
    occupancy: dict[str, list[dict]],
) -> tuple[datetime | None, dict | None]:
    """寻找最早可行起点。返回 (start, failure_info)。"""
    t = earliest
    bumped_blackouts: list[dict] = []
    last_blockers: list[str] = []
    last_resource: str | None = None

    for _ in range(MAX_ITERATIONS):
        end = t + duration
        if end > window_end:
            return None, {
                "reason": "window",
                "candidate": t,
                "blockers": last_blockers,
                "resource": last_resource,
                "blackouts": [{"name": b["name"], "start": b["start"], "end": b["end"]}
                              for b in bumped_blackouts[-3:]],
            }

        hit = _blackout_at(t, end, blackouts)
        if hit:
            if hit not in bumped_blackouts:
                bumped_blackouts.append(hit)
            t = hit["end"]
            continue

        violations = _capacity_violations(t, end, need, capacities, occupancy)
        hard = [v for v in violations if not v["blockers"]]
        if hard:
            # 单项需求超过总容量，永远不可能排下
            return None, {
                "reason": "capacity",
                "candidate": t,
                "blockers": [],
                "resource": hard[0]["resource"],
                "blackouts": [],
            }
        if violations:
            v = violations[0]
            last_resource = v["resource"]
            last_blockers = v["blockers"]
            # 跳到冲突占用区间中最早的释放时刻
            release = min(
                iv["end"] for iv in occupancy[v["resource"]]
                if iv["node"] in v["blockers"] and iv["start"] < end and t < iv["end"]
            )
            if release <= t:  # 安全兜底，防死循环
                release = t + timedelta(minutes=1)
            t = release
            continue

        return t, None

    return None, {"reason": "iterations", "candidate": t, "blockers": [],
                  "resource": None, "blackouts": []}


def solve(payload: dict[str, Any]) -> dict[str, Any]:
    """主入口：规整输入 → 校验 DAG → 资源约束排程，返回完整结果。"""
    data = normalize(payload)
    nodes = data["nodes"]
    edges = data["edges"]
    window_start = data["window_start"]
    window_end = data["window_end"]
    blackouts = data["blackouts"]
    capacities = data["capacities"]

    conflicts: list[dict] = []

    # 1) 悬空依赖边
    for s, t in edges:
        if s not in nodes or t not in nodes:
            conflicts.append({
                "type": "dangling_edge",
                "message": f"依赖边 {s} → {t} 引用了不存在的维护项",
                "chain": [x for x in (s, t) if x in nodes],
                "edge": {"source": s, "target": t},
                "edges": [{"source": s, "target": t}],
                "nodes": [x for x in (s, t) if x in nodes],
            })
    valid_edges = [(s, t) for s, t in edges if s in nodes and t in nodes]

    # 2) 循环依赖
    cycles = find_cycles(nodes, valid_edges)
    cyclic: set[str] = set()
    for cyc in cycles:
        cyclic.update(cyc)
        cyc_edges = [
            {"source": cyc[i], "target": cyc[(i + 1) % len(cyc)]}
            for i in range(len(cyc))
        ]
        # 自环时上面的构造天然正确（i 与 i%1 同点）
        chain_text = " → ".join(cyc + [cyc[0]])
        conflicts.append({
            "type": "cycle",
            "message": f"检测到循环依赖：{chain_text}，环上任务均无法排程",
            "chain": cyc,
            "edge": cyc_edges[0],
            "edges": cyc_edges,
            "nodes": cyc,
        })

    # 3) 拓扑排序
    order = topo_order(nodes, valid_edges, cyclic)

    preds: dict[str, list[str]] = defaultdict(list)
    succs: dict[str, list[str]] = defaultdict(list)
    for s, t in valid_edges:
        if s not in cyclic and t not in cyclic:
            preds[t].append(s)
            succs[s].append(t)

    # 4) 按拓扑序逐个排程
    occupancy: dict[str, list[dict]] = defaultdict(list)
    scheduled: dict[str, dict] = {}
    unschedulable: set[str] = set()

    def occupy(node: dict, start: datetime, end: datetime) -> None:
        for rname, amount in node["resources"].items():
            occupancy[rname].append({
                "node": node["id"], "start": start, "end": end, "amount": amount
            })

    for nid in order:
        node = nodes[nid]
        start_req = node["fixed_start"]
        duration = node["duration"]
        pred_end = window_start
        broken_pred = None
        for p in preds[nid]:
            if p in unschedulable or p in cyclic:
                broken_pred = p
                break
            if p in scheduled:
                pred_end = max(pred_end, scheduled[p]["end"])

        if broken_pred is not None:
            unschedulable.add(nid)
            conflicts.append({
                "type": "dependency_blocked",
                "message": f"「{node['name']}」的前置任务「{nodes.get(broken_pred, {}).get('name', broken_pred)}」未能排程，无法确定开始时间",
                "chain": [broken_pred, nid],
                "edge": {"source": broken_pred, "target": nid},
                "edges": [{"source": broken_pred, "target": nid}],
                "nodes": [broken_pred, nid],
            })
            continue

        if start_req is not None:
            # --- 固定开始时间任务：逐项校验
            end = start_req + duration
            fixed_conflict = False

            if start_req < window_start or end > window_end:
                fixed_conflict = True
                conflicts.append({
                    "type": "fixed_window",
                    "message": (
                        f"「{node['name']}」固定于 {_fmt(start_req)} 开始，"
                        f"超出维护窗口（{_fmt(window_start)} ~ {_fmt(window_end)}）"
                    ),
                    "chain": [nid], "edges": [], "nodes": [nid],
                    "blackouts": [],
                    "start": _iso(start_req),
                })
            if pred_end > start_req:
                fixed_conflict = True
                pred_id = max(preds[nid], key=lambda p: scheduled[p]["end"]) if preds[nid] else None
                conflicts.append({
                    "type": "fixed_predecessor",
                    "message": (
                        f"「{node['name']}」固定于 {_fmt(start_req)} 开始，"
                        f"但前置「{nodes.get(pred_id, {}).get('name', pred_id)}」"
                        f"最早 {_fmt(pred_end)} 才结束"
                    ),
                    "chain": [pred_id, nid] if pred_id else [nid],
                    "edges": [{"source": pred_id, "target": nid}] if pred_id else [],
                    "nodes": [nid] + ([pred_id] if pred_id else []),
                    "blackouts": [],
                    "start": _iso(start_req),
                })

            hit = _blackout_at(start_req, end, blackouts)
            if hit:
                fixed_conflict = True
                conflicts.append({
                    "type": "fixed_blackout",
                    "message": (
                        f"「{node['name']}」固定时段 {_fmt(start_req)} ~ {_fmt(end)} "
                        f"与禁排期「{hit['name']}」（{_fmt(hit['start'])} ~ {_fmt(hit['end'])}）重叠"
                    ),
                    "chain": [nid], "edges": [], "nodes": [nid],
                    "blackouts": [{"name": hit["name"], "start": _iso(hit["start"]),
                                   "end": _iso(hit["end"])}],
                    "start": _iso(start_req),
                })

            violations = _capacity_violations(
                start_req, end, node["resources"], capacities, occupancy
            )
            for v in violations:
                fixed_conflict = True
                rname = v["resource"]
                if node["resources"].get(rname, 0) > capacities.get(rname, 1.0):
                    conflicts.append({
                        "type": "fixed_capacity",
                        "message": (
                            f"「{node['name']}」需要资源 {rname} {node['resources'][rname]}，"
                            f"超过总容量 {capacities.get(rname, 1.0)}"
                        ),
                        "chain": [nid], "edges": [], "nodes": [nid], "blackouts": [],
                        "start": _iso(start_req),
                    })
                else:
                    conflicts.append({
                        "type": "fixed_resource",
                        "message": (
                            f"「{node['name']}」固定于 {_fmt(start_req)} 时，"
                            f"资源 {rname} 用量达到 {v['demand']}（容量 {v['capacity']}），"
                            f"与 {len(v['blockers'])} 个任务冲突"
                        ),
                        "chain": v["blockers"] + [nid],
                        "edges": [],
                        "nodes": [nid] + v["blockers"],
                        "blackouts": [],
                        "start": _iso(start_req),
                        "resource": rname,
                    })

            if fixed_conflict:
                unschedulable.add(nid)
                continue

            scheduled[nid] = {"start": start_req, "end": end, "fixed": True}
            occupy(node, start_req, end)
            continue

        # --- 弹性任务：最早可行槽位
        earliest = max(window_start, pred_end)
        start, failure = _find_slot(
            earliest, duration, node["resources"], window_end,
            blackouts, capacities, occupancy,
        )
        if start is None:
            unschedulable.add(nid)
            detail_parts = []
            if failure["blockers"]:
                names = "、".join(nodes[b]["name"] for b in failure["blockers"] if b in nodes)
                detail_parts.append(f"资源 {failure['resource']} 被 {names} 占用")
            if failure["blackouts"]:
                detail_parts.append("受禁排期「" + "、".join(
                    b["name"] for b in failure["blackouts"]) + "」挤压")
            if failure["reason"] == "capacity":
                detail_parts = [
                    f"资源 {failure['resource']} 需求 {node['resources'].get(failure['resource'])} "
                    f"超过总容量 {capacities.get(failure['resource'], 1.0)}"
                ]
            detail = "；".join(detail_parts) or "窗口内剩余时间不足"
            conflicts.append({
                "type": "unschedulable",
                "message": f"「{node['name']}」在当前维护窗口内无法排程：{detail}",
                "chain": failure["blockers"] + [nid],
                "edges": [],
                "nodes": [nid] + failure["blockers"],
                "blackouts": [
                    {"name": b["name"], "start": _iso(b["start"]), "end": _iso(b["end"])}
                    for b in failure["blackouts"]
                ],
                "candidate": _iso(failure["candidate"]),
                "resource": failure["resource"],
            })
            continue

        end = start + duration
        scheduled[nid] = {"start": start, "end": end, "fixed": False}
        occupy(node, start, end)

    # 5) 组装结果
    items = []
    for nid in order:
        if nid not in scheduled:
            continue
        s = scheduled[nid]
        node = nodes[nid]
        items.append({
            "id": nid,
            "name": node["name"],
            "start": _iso(s["start"]),
            "end": _iso(s["end"]),
            "start_label": _fmt(s["start"]),
            "end_label": _fmt(s["end"]),
            "duration_minutes": node["duration_minutes"],
            "fixed": s["fixed"],
            "resources": node["resources"],
            "predecessors": preds[nid],
            "successors": succs[nid],
        })
    items.sort(key=lambda it: (it["start"], it["id"]))

    feasible = not conflicts and not cyclic
    if items:
        makespan = (
            datetime.fromisoformat(max(it["end"] for it in items))
            - datetime.fromisoformat(min(it["start"] for it in items))
        )
        makespan_minutes = int(makespan.total_seconds() // 60)
    else:
        makespan_minutes = 0

    return {
        "feasible": feasible,
        "items": items,
        "order": [it["id"] for it in items],
        "unscheduled": sorted(cyclic | unschedulable),
        "conflicts": conflicts,
        "stats": {
            "total": len(nodes),
            "scheduled": len(items),
            "conflicts": len(conflicts),
            "makespan_minutes": makespan_minutes,
        },
        "window": {"start": _iso(window_start), "end": _iso(window_end)},
    }
