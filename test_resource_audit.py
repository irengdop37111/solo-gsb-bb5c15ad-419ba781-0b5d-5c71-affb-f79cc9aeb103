"""跨场景共享资源占用核查测试。运行：python test_resource_audit.py"""
import json
import os
import sys
import tempfile

sys.path.insert(0, ".")

from app.resource_audit import audit, state_to_payload, normalize_capacities

passed = 0
def check(name, cond, extra=""):
    global passed
    assert cond, f"FAIL: {name} {extra}"
    passed += 1
    print(f"  ok - {name}")


W0, W1 = "2026-09-23T22:00", "2026-09-24T06:00"


def scn_state(nodes, win_s=W0, win_e=W1, resources=None, edges=None):
    """编辑器 state 格式的场景 data。"""
    return {
        "windowStart": win_s, "windowEnd": win_e,
        "resources": resources if resources is not None else [{"name": "DBA", "capacity": 1}],
        "nodes": nodes, "edges": edges or [], "blackouts": [], "uid": 10,
    }


def fixed(nid, name, start, minutes, res=None):
    return {"id": nid, "name": name, "duration_minutes": minutes,
            "resources": res or {"DBA": 1}, "fixed_start": start}


def scn(sid, name, data):
    return {"id": sid, "name": name, "data": data}


print("1. 两场景时段错开、容量足够 → 无超限且覆盖完整")
r = audit([
    scn(1, "S1", scn_state([fixed("a", "A", "2026-09-23T22:00", 60)])),
    scn(2, "S2", scn_state([fixed("b", "B", "2026-09-23T23:30", 60)])),
], {"DBA": 1})
check("ok", r["ok"] is True, r["conflicts"])
check("complete", r["complete"] is True)
check("无超限时段", r["conflicts"] == [])
check("无警告", r["warnings"] == [])
check("统计：2 场景 2 任务", r["stats"] == {
    "scenarios": 2, "scheduled": 2, "unscheduled": 0, "overlaps": 0}, r["stats"])
check("场景报告按顺序", [s["name"] for s in r["scenarios"]] == ["S1", "S2"])
check("场景报告含窗口", r["scenarios"][0]["window"]["start"] == W0)

print("2. 两场景同时段合计超限 → 检出一个连续时段（资源/峰值/涉及任务）")
r = audit([
    scn(1, "S1", scn_state([fixed("a", "任务A", "2026-09-23T22:00", 60)])),   # 22:00-23:00
    scn(2, "S2", scn_state([fixed("b", "任务B", "2026-09-23T22:30", 60)])),   # 22:30-23:30
], {"DBA": 1})
check("not ok", r["ok"] is False)
check("一个超限时段", len(r["conflicts"]) == 1, r["conflicts"])
c = r["conflicts"][0]
check("时段 22:30~23:00", (c["start"], c["end"]) ==
      ("2026-09-23T22:30", "2026-09-23T23:00"), c)
check("资源与峰值/容量", (c["resource"], c["peak"], c["capacity"]) == ("DBA", 2, 1))
check("涉及两个场景的任务",
      {(t["scenario_name"], t["task_name"]) for t in c["tasks"]}
      == {("S1", "任务A"), ("S2", "任务B")}, c["tasks"])
check("任务带占用量与时段",
      all(t["amount"] == 1 and t["start"] and t["end"] for t in c["tasks"]))

print("3. 半开区间：一个结束与另一个开始同时发生不算重叠")
r = audit([
    scn(1, "S1", scn_state([fixed("a", "A", "2026-09-23T22:00", 60)])),   # 22:00-23:00
    scn(2, "S2", scn_state([fixed("b", "B", "2026-09-23T23:00", 60)])),   # 23:00-00:00
], {"DBA": 1})
check("首尾相接不算超限", r["ok"] is True and r["conflicts"] == [], r["conflicts"])

print("4. 相邻超限段合并为一个连续时段，峰值取最大、任务取并集")
r = audit([
    scn(1, "S1", scn_state([fixed("a", "A", "2026-09-23T22:00", 60)])),   # 22:00-23:00
    scn(2, "S2", scn_state([fixed("b", "B", "2026-09-23T22:30", 60)])),   # 22:30-23:30
    scn(3, "S3", scn_state([fixed("c", "C", "2026-09-23T23:00", 30)])),   # 23:00-23:30
], {"DBA": 1})
check("合并为一个时段", len(r["conflicts"]) == 1, r["conflicts"])
c = r["conflicts"][0]
check("连续时段 22:30~23:30", (c["start"], c["end"]) ==
      ("2026-09-23T22:30", "2026-09-23T23:30"), c)
check("峰值 2", c["peak"] == 2)
check("任务并集含 a/b/c", {t["node_id"] for t in c["tasks"]} == {"a", "b", "c"}, c["tasks"])

print("5. 不相邻的超限分别列出")
r = audit([
    scn(1, "S1", scn_state([fixed("a", "A", "2026-09-23T22:00", 60),
                            fixed("c", "C", "2026-09-24T01:00", 60)])),
    scn(2, "S2", scn_state([fixed("b", "B", "2026-09-23T22:30", 60),
                            fixed("d", "D", "2026-09-24T01:30", 60)])),
], {"DBA": 1})
check("两个超限时段", len(r["conflicts"]) == 2, r["conflicts"])
check("按开始时间排序",
      [c["start"] for c in r["conflicts"]] ==
      ["2026-09-23T22:30", "2026-09-24T01:30"], r["conflicts"])

print("6. 多资源：按资源分别合计；未列入共享容量表的资源被忽略")
r = audit([
    scn(1, "S1", scn_state(
        [fixed("a", "A", "2026-09-23T22:00", 60, {"DBA": 1, "NET": 1})],
        resources=[{"name": "DBA", "capacity": 1}, {"name": "NET", "capacity": 1}])),
    scn(2, "S2", scn_state(
        [fixed("b", "B", "2026-09-23T22:00", 60, {"DBA": 1, "NET": 1})],
        resources=[{"name": "DBA", "capacity": 1}, {"name": "NET", "capacity": 1}])),
], {"DBA": 2})  # 只核查 DBA，且容量够；NET 合计 2 但不核查
check("DBA 容量内且无 NET 核查 → 无超限", r["ok"] is True and r["conflicts"] == [], r["conflicts"])
r = audit([
    scn(1, "S1", scn_state([fixed("a", "A", "2026-09-23T22:00", 60, {"NET": 2})],
                            resources=[{"name": "NET", "capacity": 2}])),
    scn(2, "S2", scn_state([fixed("b", "B", "2026-09-23T22:00", 60, {"NET": 2})],
                            resources=[{"name": "NET", "capacity": 2}])),
], {"NET": 3})
check("NET 合计 4 > 3 → 超限", len(r["conflicts"]) == 1 and r["conflicts"][0]["peak"] == 4,
      r["conflicts"])

print("7. 场景计划不可行：诊断 + 未排定任务跳过，不把缺失占用当作无冲突")
bad = scn_state([
    {"id": "x", "name": "超限任务", "duration_minutes": 30,
     "resources": {"DBA": 5}, "fixed_start": None},   # 需求超场景容量，永远排不下
])
r = audit([
    scn(1, "好场景", scn_state([fixed("a", "A", "2026-09-23T22:00", 60)])),
    scn(2, "坏场景", bad),
], {"DBA": 1})
check("无超限（未排定任务的占用未计入）", r["ok"] is True and r["conflicts"] == [], r["conflicts"])
check("但不完整（complete=False）", r["complete"] is False)
check("有覆盖缺口警告", any("未排定" in w and "坏场景" in w for w in r["warnings"]), r["warnings"])
rep = r["scenarios"][1]
check("坏场景 ok=False 且有诊断", rep["ok"] is False and len(rep["diagnostics"]) >= 1, rep)
check("未排定任务列出 id 与名称",
      rep["unscheduled"] == [{"id": "x", "name": "超限任务"}], rep["unscheduled"])
check("统计未排定 1", r["stats"]["unscheduled"] == 1)

print("8. 场景数据本身无效：给出诊断而不中断整体核查")
r = audit([
    scn(1, "S1", scn_state([fixed("a", "A", "2026-09-23T22:00", 60)])),
    scn(2, "S2", {"nodes": []}),   # 缺维护窗口
], {"DBA": 1})
check("整体仍返回", r["stats"]["scenarios"] == 2)
check("无效场景有 error 诊断",
      r["scenarios"][1]["error"] and "场景数据无效" in r["scenarios"][1]["diagnostics"][0],
      r["scenarios"][1])
check("complete=False 且有警告", r["complete"] is False and any("S2" in w for w in r["warnings"]))

print("9. 共享容量表校验")
for bad_caps, kw in [({}, "至少"), ({"DBA": -1}, "不能为负"),
                     ({"DBA": "abc"}, "必须是数字"),({"  ": 1}, "名称不能为空")]:
    try:
        normalize_capacities(bad_caps)
        raise AssertionError(f"应拒绝 {bad_caps}")
    except ValueError as e:
        check(f"拒绝 {bad_caps}（{kw}）", kw in str(e), e)
check("合法容量表通过", normalize_capacities({"DBA": 2, "NET": 0.5}) == {"DBA": 2.0, "NET": 0.5})

print("10. state_to_payload 兼容编辑器 state 与 API 两种格式")
p1 = state_to_payload(scn_state([fixed("a", "A", W0, 30)]))
check("state 格式：窗口与资源映射",
      p1["window_start"] == W0 and p1["resources"] == {"DBA": 1}, p1)
p2 = state_to_payload({
    "window_start": W0, "window_end": W1, "resources": {"DBA": 2},
    "nodes": [{"id": "a", "duration_minutes": 30}], "edges": [], "blackouts": [],
})
check("API 格式原样透传", p2["resources"] == {"DBA": 2} and p2["window_end"] == W1, p2)
r = audit([
    scn(1, "S1", {"window_start": W0, "window_end": W1, "resources": {"DBA": 1},
                  "nodes": [{"id": "a", "name": "A", "duration_minutes": 60,
                             "resources": {"DBA": 1}, "fixed_start": W0}],
                  "edges": [], "blackouts": []}),
    scn(2, "S2", scn_state([fixed("b", "B", "2026-09-23T22:30", 60)])),
], {"DBA": 1})
check("两种格式混用也可核查", len(r["conflicts"]) == 1, r)


# ---------------------------------------------------------------------------
# API 端到端
# ---------------------------------------------------------------------------
print("11. API：建场景 → 核查 → 结构完整；只读不改场景与执行记录")
from app import main  # noqa: E402

tmpdir = tempfile.mkdtemp()
main.DB_PATH = type(main.DB_PATH)(os.path.join(tmpdir, "test-audit.db"))
main.init_db()

from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(main.app)

state1 = scn_state([fixed("a", "任务A", "2026-09-23T22:00", 60)])
state2 = scn_state([fixed("b", "任务B", "2026-09-23T22:30", 60)])
r = client.post("/api/scenarios", json={"name": "核查场景一", "data": state1})
id1 = r.json()["id"]
r = client.post("/api/scenarios", json={"name": "核查场景二", "data": state2})
id2 = r.json()["id"]
# 场景一登记执行记录，用于验证核查只读
client.put(f"/api/scenarios/{id1}/execution", json={"records": [
    {"node_id": "a", "executed": True,
     "actual_start": "2026-09-23T22:05", "actual_end": "2026-09-23T23:05"},
]})
before = client.get(f"/api/scenarios/{id1}").json()

resp = client.post("/api/resource-audit", json={
    "scenario_ids": [id1, id2], "shared_capacities": {"DBA": 1},
})
check("核查 200", resp.status_code == 200, resp.text)
body = resp.json()
check("检出一个超限时段", body["ok"] is False and len(body["conflicts"]) == 1, body)
check("响应含场景报告/警告/统计",
      len(body["scenarios"]) == 2 and "warnings" in body and body["stats"]["overlaps"] == 1)
check("共享容量回显", body["shared_capacities"] == {"DBA": 1.0})

after = client.get(f"/api/scenarios/{id1}").json()
check("只读：场景 updated_at 未变", before["updated_at"] == after["updated_at"], (before, after))
exec_after = client.get(f"/api/scenarios/{id1}/execution").json()
check("只读：执行记录未变",
      len(exec_after["records"]) == 1 and exec_after["records"][0]["actual_start"]
      == "2026-09-23T22:05", exec_after)

print("12. API：入参校验")
resp = client.post("/api/resource-audit", json={
    "scenario_ids": [id1], "shared_capacities": {"DBA": 1},
})
check("少于两个场景 422", resp.status_code == 422, resp.text)
resp = client.post("/api/resource-audit", json={
    "scenario_ids": [id1, id2], "shared_capacities": {},
})
check("空容量表 422", resp.status_code == 422, resp.text)
resp = client.post("/api/resource-audit", json={
    "scenario_ids": [id1, id2], "shared_capacities": {"DBA": -2},
})
check("负容量 422", resp.status_code == 422, resp.text)
resp = client.post("/api/resource-audit", json={
    "scenario_ids": [id1, 999999], "shared_capacities": {"DBA": 1},
})
check("场景不存在 404", resp.status_code == 404, resp.text)

print("13. API：重复 id 去重；容量足够时 ok")
resp = client.post("/api/resource-audit", json={
    "scenario_ids": [id1, id1, id2], "shared_capacities": {"DBA": 2},
})
check("重复 id 去重后 200", resp.status_code == 200, resp.text)
body = resp.json()
check("按两个场景核查", body["stats"]["scenarios"] == 2, body["stats"])
check("容量 2 无超限且完整", body["ok"] is True and body["complete"] is True, body)

print(f"\n全部 {passed} 项检查通过 ✔")
