"""跨场景共享资源占用核查（只读）。

对多个**已保存**场景分别独立排程（沿用各场景自身的资源容量与约束），
把排定任务对共享资源的占用汇总为**半开时间区间** ``[start, end)``：
一个任务结束与另一个任务开始发生在同一时刻不构成重叠。

随后按时间端点做扫描线，找出每种共享资源合计占用超过给定总容量的
**连续时段**，给出峰值、超出量以及涉及的场景与任务。

场景计划不可行（或输入非法无法求解）时给出诊断，其**未排定任务不参与
占用汇总**——缺失占用不会被当作“无冲突”：响应中以 ``warnings`` /
``unscheduled`` 显式标出，避免漏报。

本模块与对应 API 均为只读：不修改任何场景或实际执行记录。
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from typing import Any

from . import scheduler

EPS = 1e-9


# ---------------------------------------------------------------------------
# 场景数据规整：编辑器 state 与排程 API 两种存储格式均支持
# ---------------------------------------------------------------------------

def scenario_to_payload(data: dict[str, Any]) -> dict[str, Any]:
    """把已保存场景的 data 转成 :func:`scheduler.solve` 需要的载荷格式。

    编辑器 state（``windowStart`` / 资源数组 / blackout 带 id）与
    排程 API 格式（``window_start`` / 资源映射）两种都可识别。
    """
    if not isinstance(data, dict):
        raise ValueError("场景数据必须是 JSON 对象")

    if "window_start" in data or "window_end" in data:
        return {k: data[k] for k in
                ("window_start", "window_end", "resources", "nodes", "edges", "blackouts")
                if k in data}

    resources: dict[str, Any] = {}
    for r in data.get("resources", []) or []:
        if not isinstance(r, dict) or r.get("name") in (None, ""):
            continue
        resources[str(r["name"])] = r.get("capacity")

    nodes = [
        {
            "id": n.get("id"),
            "name": n.get("name"),
            "duration_minutes": n.get("duration_minutes"),
            "resources": n.get("resources") or {},
            "fixed_start": n.get("fixed_start"),
        }
        for n in data.get("nodes", []) or []
        if isinstance(n, dict)
    ]
    edges = [
        {"source": e.get("source"), "target": e.get("target")}
        for e in data.get("edges", []) or []
        if isinstance(e, dict)
    ]
    blackouts = [
        {"name": b.get("name"), "start": b.get("start"), "end": b.get("end")}
        for b in data.get("blackouts", []) or []
        if isinstance(b, dict) and b.get("start") and b.get("end")
    ]
    payload = {
        "window_start": data.get("windowStart"),
        "window_end": data.get("windowEnd"),
        "resources": resources,
        "nodes": nodes,
        "edges": edges,
        "blackouts": blackouts,
    }
    return {k: v for k, v in payload.items() if v is not None}


# ---------------------------------------------------------------------------
# 扫描线：半开区间合计占用 -> 连续超限时段
# ---------------------------------------------------------------------------

def _task_ref(iv: dict[str, Any], *, at_peak: bool) -> dict[str, Any]:
    return {
        "scenario_id": iv["scenario_id"],
        "scenario_name": iv["scenario_name"],
        "node_id": iv["node_id"],
        "node_name": iv["node_name"],
        "start": scheduler._iso(iv["start"]),
        "end": scheduler._iso(iv["end"]),
        "start_label": scheduler._fmt(iv["start"]),
        "end_label": scheduler._fmt(iv["end"]),
        "amount": round(iv["amount"], 6),
        "at_peak": at_peak,
    }


def find_overload_periods(
    resource: str, capacity: float, intervals: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """端点扫描，返回资源 ``resource`` 上合计占用超过 ``capacity`` 的连续时段。

    占用按半开区间聚合：在同一时刻结束的任务先释放、开始的任务再占用，
    因此首尾相接（一个结束 = 另一个开始）不算重叠。相邻的超限微区间
    （端点首尾相接）合并为一个连续时段，并记录区间内峰值。
    """
    if not intervals:
        return []

    points = sorted(
        {iv["start"] for iv in intervals} | {iv["end"] for iv in intervals}
    )
    raw_periods: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None

    for p, q in zip(points, points[1:]):
        # 区间 [p, q) 上的有效占用：start <= p 且 end >= q（半开语义）
        active = [iv for iv in intervals if iv["start"] <= p and iv["end"] >= q]
        total = round(sum(iv["amount"] for iv in active), 6)

        if total > capacity + EPS:
            if current is None or current["_end"] != p:
                if current is not None:
                    raw_periods.append(current)
                current = {"start": p, "_end": q, "peak": total,
                           "peak_at": p, "_peak_active": active}
            else:
                current["_end"] = q
                if total > current["peak"]:
                    current["peak"] = total
                    current["peak_at"] = p
                    current["_peak_active"] = active
        elif current is not None:
            raw_periods.append(current)
            current = None
    if current is not None:
        raw_periods.append(current)

    periods = []
    for per in raw_periods:
        start, end = per["start"], per["_end"]
        peak_active = per["_peak_active"]
        peak_keys = {(iv["scenario_id"], iv["node_id"]) for iv in peak_active}
        # 涉及任务：占用区间与该连续超限时段有任何重叠的全部任务
        involved = [
            iv for iv in intervals
            if iv["start"] < end and start < iv["end"]
        ]
        involved.sort(key=lambda iv: (iv["start"], iv["scenario_id"], iv["node_id"]))

        scenarios: list[dict[str, Any]] = []
        seen_scn: set[int] = set()
        for iv in involved:
            if iv["scenario_id"] not in seen_scn:
                seen_scn.add(iv["scenario_id"])
                scenarios.append({"id": iv["scenario_id"], "name": iv["scenario_name"]})

        tasks = [
            _task_ref(iv, at_peak=(iv["scenario_id"], iv["node_id"]) in peak_keys)
            for iv in involved
        ]
        peak = per["peak"]
        periods.append({
            "resource": resource,
            "capacity": capacity,
            "start": scheduler._iso(start),
            "end": scheduler._iso(end),
            "start_label": scheduler._fmt(start),
            "end_label": scheduler._fmt(end),
            "duration_minutes": int((end - start).total_seconds() // 60),
            "peak": peak,
            "peak_at": scheduler._iso(per["peak_at"]),
            "peak_at_label": scheduler._fmt(per["peak_at"]),
            "excess": round(peak - capacity, 6),
            "involved_scenarios": scenarios,
            "tasks": tasks,
        })
    return periods


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------

def cross_check(
    saved_scenarios: list[dict[str, Any]], capacities: dict[str, float]
) -> dict[str, Any]:
    """对已保存场景集合做共享资源占用核查。

    ``saved_scenarios`` 为 ``[{"id": int, "name": str, "data": dict}, ...]``
    （由 API 层从 SQLite 读出，顺序即用户选择顺序）；
    ``capacities`` 为用户输入的共享资源总容量。
    """
    warnings: list[str] = []
    scenario_results: list[dict[str, Any]] = []
    # resource -> 占用区间
    intervals_by_resource: dict[str, list[dict[str, Any]]] = defaultdict(list)
    # resource -> 出现过的 (scenario_id, scenario_name, node_id)
    referenced: dict[str, list[tuple[int, str, str]]] = defaultdict(list)

    for scn in saved_scenarios:
        sid = scn["id"]
        sname = scn["name"]
        entry: dict[str, Any] = {
            "id": sid,
            "name": sname,
            "planned": False,       # solver 是否成功跑完
            "error": None,          # 输入非法等致命错误
            "feasible": False,
            "total": 0,
            "scheduled": 0,
            "fully_scheduled": False,
            "unscheduled": [],
            "conflicts": [],
        }
        scenario_results.append(entry)

        try:
            payload = scenario_to_payload(scn["data"])
            name_map = {
                str(n.get("id", "")): str(n.get("name") or n.get("id", ""))
                for n in payload.get("nodes", [])
            }
            result = scheduler.solve(payload)
        except ValueError as exc:
            entry["error"] = str(exc)
            warnings.append(
                f"场景「{sname}」计划计算失败：{exc}；该场景的全部任务均未参与占用汇总，"
                f"不能据此判定与其它场景无冲突"
            )
            continue

        entry["planned"] = True
        entry["feasible"] = bool(result.get("feasible"))
        stats = result.get("stats", {})
        entry["total"] = stats.get("total", 0)
        entry["scheduled"] = stats.get("scheduled", 0)
        entry["fully_scheduled"] = entry["scheduled"] == entry["total"]
        entry["unscheduled"] = [
            {"id": nid, "name": name_map.get(str(nid), str(nid))}
            for nid in result.get("unscheduled", [])
        ]
        entry["conflicts"] = [
            {"type": c.get("type"), "message": c.get("message")}
            for c in result.get("conflicts", [])
        ]

        if not entry["fully_scheduled"]:
            names = "、".join(u["name"] for u in entry["unscheduled"]) or "—"
            warnings.append(
                f"场景「{sname}」有 {len(entry['unscheduled'])} 个任务未排程"
                f"（{names}），核查已跳过这些任务，其潜在占用未计入合计"
            )

        # 仅**排定**任务产生占用；未排定任务不允许伪装成“占用为 0”
        for it in result.get("items", []):
            for rname, amount in (it.get("resources") or {}).items():
                try:
                    amount = float(amount)
                except (TypeError, ValueError):
                    continue
                if amount <= 0:
                    continue
                try:
                    start = datetime.fromisoformat(it["start"])
                    end = datetime.fromisoformat(it["end"])
                except (KeyError, ValueError):
                    continue
                iv = {
                    "scenario_id": sid,
                    "scenario_name": sname,
                    "node_id": str(it.get("id", "")),
                    "node_name": str(it.get("name") or it.get("id", "")),
                    "start": start,
                    "end": end,
                    "amount": amount,
                }
                intervals_by_resource[str(rname)].append(iv)
                referenced[str(rname)].append((sid, sname, iv["node_id"]))

    # 端点扫描（仅核查用户给出了共享总容量的资源）
    overloads: list[dict[str, Any]] = []
    for rname, cap in capacities.items():
        overloads.extend(find_overload_periods(rname, float(cap),
                                               intervals_by_resource.get(rname, [])))
    overloads.sort(key=lambda o: (o["start"], o["resource"]))

    # 被任务占用但未提供共享容量的资源：不参与核查，必须显式提示
    unchecked_resources: list[dict[str, Any]] = []
    for rname in sorted(referenced):
        if rname in capacities:
            continue
        refs = referenced[rname]
        scenarios: list[dict[str, Any]] = []
        seen: set[int] = set()
        for sid, sname, _ in refs:
            if sid not in seen:
                seen.add(sid)
                scenarios.append({"id": sid, "name": sname})
        unchecked_resources.append({
            "resource": rname,
            "scenarios": scenarios,
            "task_count": len({(sid, nid) for sid, _, nid in refs}),
        })
        warnings.append(
            f"资源「{rname}」被 {len(scenarios)} 个场景共 "
            f"{unchecked_resources[-1]['task_count']} 个排定任务占用，"
            f"但未提供共享资源总容量，未参与核查"
        )

    unused_resources = sorted(
        rname for rname in capacities if rname not in referenced
    )

    return {
        "capacities": {k: float(v) for k, v in capacities.items()},
        "scenarios": scenario_results,
        "overloads": overloads,
        "warnings": warnings,
        "unchecked_resources": unchecked_resources,
        "unused_resources": unused_resources,
        "stats": {
            "scenario_count": len(saved_scenarios),
            "resource_count": len(capacities),
            "overload_count": len(overloads),
            "fully_checked": all(e["planned"] and e["fully_scheduled"]
                                 for e in scenario_results) and not unchecked_resources,
        },
    }
