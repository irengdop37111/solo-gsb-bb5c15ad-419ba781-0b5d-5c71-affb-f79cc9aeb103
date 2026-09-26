"""跨场景共享资源占用核查（只读，纯函数，无 I/O）。

输入若干已保存场景（编辑器 state 或 API 格式均可）与共享资源总容量：
1. 分别调用 scheduler 计算各场景计划；
2. 把排定任务的资源占用汇总为半开时间区间 [start, end)；
3. 扫描时间端点，找出合计占用超过共享容量的**连续时段**，
   列出资源、峰值与涉及的场景 / 任务。

半开区间语义：一个任务结束与另一个任务开始同时发生**不算重叠**。
场景计划不可行时：诊断随结果返回，未排定任务的占用不计入核查，
并以 warnings 显式标注覆盖缺口——不把缺失占用当作无冲突。
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from typing import Any

from . import scheduler

_EPS = 1e-9


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M")


def _fmt(dt: datetime) -> str:
    return dt.strftime("%m-%d %H:%M")


def state_to_payload(data: Any) -> dict:
    """把已保存场景 data（编辑器 state 或 API 格式）规整为 scheduler 输入。"""
    if not isinstance(data, dict):
        raise ValueError("场景数据必须是 JSON 对象")
    raw_res = data.get("resources")
    if isinstance(raw_res, list):          # 编辑器 state：[{name, capacity}]
        resources = {str(r.get("name", "")): r.get("capacity") for r in raw_res}
    elif isinstance(raw_res, dict):        # API 格式：{name: capacity}
        resources = dict(raw_res)
    else:
        resources = {}
    return {
        "window_start": data.get("window_start") or data.get("windowStart"),
        "window_end": data.get("window_end") or data.get("windowEnd"),
        "resources": resources,
        "nodes": data.get("nodes") or [],
        "edges": data.get("edges") or [],
        "blackouts": data.get("blackouts") or [],
    }


def normalize_capacities(raw: Any) -> dict[str, float]:
    """校验共享资源总容量表；非法时抛 ValueError（由 API 层转 422）。"""
    if not isinstance(raw, dict) or not raw:
        raise ValueError("至少需要一项共享资源总容量")
    capacities: dict[str, float] = {}
    for name, cap in raw.items():
        rname = str(name).strip()
        if not rname:
            raise ValueError("共享资源名称不能为空")
        try:
            value = float(cap)
        except (TypeError, ValueError):
            raise ValueError(f"共享资源 {rname} 的总容量必须是数字")
        if value < 0:
            raise ValueError(f"共享资源 {rname} 的总容量不能为负")
        capacities[rname] = value
    return capacities


def _sweep_resource(
    rname: str, capacity: float, intervals: list[dict]
) -> list[dict]:
    """单资源扫描线：端点切基本段 → 找出超限段 → 合并为连续超限时段。

    基本段 [p, q) 内活跃区间为 start <= p 且 end >= q（半开语义：
    end == p 的区间已结束，start == q 的区间未开始，均不计入）。
    """
    points = sorted({iv["_s"] for iv in intervals} | {iv["_e"] for iv in intervals})
    merged: list[dict] = []
    for i in range(len(points) - 1):
        p, q = points[i], points[i + 1]
        active = [iv for iv in intervals if iv["_s"] <= p and iv["_e"] >= q]
        used = sum(iv["amount"] for iv in active)
        if used <= capacity + _EPS:
            continue
        if merged and merged[-1]["_end"] == p:
            # 与上一超限段首尾相接 → 同一连续时段，峰值取最大、任务取并集
            m = merged[-1]
            m["_end"] = q
            m["peak"] = max(m["peak"], used)
            seen = {(t["scenario_id"], t["node_id"]) for t in m["tasks"]}
            for iv in active:
                key = (iv["scenario_id"], iv["node_id"])
                if key not in seen:
                    seen.add(key)
                    m["tasks"].append(iv)
        else:
            merged.append({"_start": p, "_end": q, "peak": used, "tasks": list(active)})

    out = []
    for m in merged:
        tasks = sorted(m["tasks"], key=lambda t: (t["_s"], t["scenario_name"], t["node_id"]))
        out.append({
            "resource": rname,
            "start": _iso(m["_start"]),
            "end": _iso(m["_end"]),
            "start_label": _fmt(m["_start"]),
            "end_label": _fmt(m["_end"]),
            "peak": round(m["peak"], 6),
            "capacity": capacity,
            "tasks": [{
                "scenario_id": t["scenario_id"],
                "scenario_name": t["scenario_name"],
                "node_id": t["node_id"],
                "task_name": t["task_name"],
                "amount": t["amount"],
                "start": t["start"],
                "end": t["end"],
            } for t in tasks],
        })
    return out


def audit(scenarios: list[dict], shared_capacities: Any) -> dict:
    """主入口：逐场景排程 → 占用汇总 → 扫描超限时段。

    ``scenarios`` 为 ``[{"id": …, "name": …, "data": …}]``（按给定顺序核查）。
    本函数不修改输入，也不做任何持久化（核查只读）。
    """
    capacities = normalize_capacities(shared_capacities)

    reports: list[dict] = []
    warnings: list[str] = []
    occupancy: dict[str, list[dict]] = defaultdict(list)

    for sc in scenarios:
        sid, sname = sc.get("id"), str(sc.get("name") or "")
        report = {
            "id": sid, "name": sname,
            "ok": False, "error": None,
            "feasible": False,
            "scheduled": 0, "total": 0,
            "unscheduled": [],
            "diagnostics": [],
            "window": None,
        }
        try:
            payload = state_to_payload(sc.get("data"))
            result = scheduler.solve(payload)
        except ValueError as exc:
            # 场景数据本身非法：整个场景无法参与核查
            report["error"] = str(exc)
            report["diagnostics"] = [f"场景数据无效：{exc}"]
            reports.append(report)
            warnings.append(
                f"场景「{sname}」数据无效（{exc}），其任务占用未计入核查"
            )
            continue

        items = result["items"]
        for it in items:
            for rname, amount in (it.get("resources") or {}).items():
                if rname not in capacities:
                    continue  # 只核查列入共享容量表的资源
                occupancy[rname].append({
                    "scenario_id": sid,
                    "scenario_name": sname,
                    "node_id": it["id"],
                    "task_name": it["name"],
                    "start": it["start"],
                    "end": it["end"],
                    "_s": datetime.fromisoformat(it["start"]),
                    "_e": datetime.fromisoformat(it["end"]),
                    "amount": amount,
                })

        name_of = {str(n.get("id", "")): str(n.get("name") or n.get("id", ""))
                   for n in payload.get("nodes", [])}
        unscheduled = [
            {"id": nid, "name": name_of.get(nid, nid)}
            for nid in result["unscheduled"]
        ]
        report.update({
            "ok": bool(result["feasible"]),
            "feasible": bool(result["feasible"]),
            "scheduled": len(items),
            "total": result["stats"]["total"],
            "unscheduled": unscheduled,
            "diagnostics": [c["message"] for c in result["conflicts"]],
            "window": result["window"],
        })
        reports.append(report)
        if unscheduled:
            names = "、".join(u["name"] for u in unscheduled[:5])
            warnings.append(
                f"场景「{sname}」计划不可行：{len(unscheduled)} 个任务未排定"
                f"（{names}），其资源占用未计入核查，实际执行可能产生额外冲突"
            )

    conflicts: list[dict] = []
    for rname, cap in capacities.items():
        conflicts.extend(_sweep_resource(rname, cap, occupancy.get(rname, [])))
    conflicts.sort(key=lambda c: (c["start"], c["resource"]))

    complete = all(r["ok"] for r in reports)
    return {
        "ok": not conflicts,
        "complete": complete,
        "shared_capacities": capacities,
        "scenarios": reports,
        "conflicts": conflicts,
        "warnings": warnings,
        "stats": {
            "scenarios": len(reports),
            "scheduled": sum(r["scheduled"] for r in reports),
            "unscheduled": sum(len(r["unscheduled"]) for r in reports),
            "overlaps": len(conflicts),
        },
    }
