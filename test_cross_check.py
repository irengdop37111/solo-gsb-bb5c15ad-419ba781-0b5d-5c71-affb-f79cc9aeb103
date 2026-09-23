"""跨场景共享资源占用核查测试（纯函数 + API）。运行：python test_cross_check.py"""
import os
import sys
import tempfile

sys.path.insert(0, ".")

from app.cross_check import scenario_to_payload, find_overload_periods, cross_check
from app import main

passed = 0


def check(name, cond, extra=""):
    global passed
    assert cond, f"FAIL: {name} {extra}"
    passed += 1
    print(f"  ok - {name}")


def fixed_task(nid, name, res, start, end, duration=None):
    """构造一个固定开始时间任务（duration 由时段推导）。"""
    from datetime import datetime
    s, e = datetime.fromisoformat(start), datetime.fromisoformat(end)
    return {
        "id": nid, "name": name,
        "duration_minutes": duration or int((e - s).total_seconds() // 60),
        "resources": res, "fixed_start": start,
    }


def scenario(win_s, win_e, nodes, resources, edges=None, blackouts=None):
    return {
        "window_start": win_s, "window_end": win_e,
        "resources": resources, "nodes": nodes,
        "edges": edges or [], "blackouts": blackouts or [],
    }


WS, WE = "2026-09-23T22:00", "2026-09-24T06:00"

print("1. scenario_to_payload：编辑器 state 格式转换")
state = {
    "windowStart": WS, "windowEnd": WE,
    "resources": [{"name": "DBA", "capacity": 1}, {"name": "网络组", "capacity": 2}],
    "nodes": [
        {"id": "a", "name": "任务A", "duration_minutes": 30,
         "resources": {"DBA": 1}, "fixed_start": None},
    ],
    "edges": [{"source": "a", "target": "b"}],
    "blackouts": [{"id": "b1", "name": "禁排", "start": "2026-09-24T00:00",
                   "end": "2026-09-24T00:30"}],
    "uid": 2, "templateRef": None,
}
p = scenario_to_payload(state)
check("窗口字段转换", p["window_start"] == WS and p["window_end"] == WE)
check("资源数组转映射", p["resources"] == {"DBA": 1, "网络组": 2})
check("blackout 去掉 id 保留名称时段",
      p["blackouts"][0] == {"name": "禁排", "start": "2026-09-24T00:00",
                            "end": "2026-09-24T00:30"})
check("无 window_start 时不回退原值", "window_start" not in scenario_to_payload({"nodes": []}))

print("2. scenario_to_payload：API 格式原样保留")
api = scenario(WS, WE, [], {"DBA": 1})
p2 = scenario_to_payload(api)
check("API 格式直通", p2 == {k: api[k] for k in
      ("window_start", "window_end", "resources", "nodes", "edges", "blackouts")})

print("3. 半开区间：一个任务结束与另一个开始同一时刻不算重叠")
a = scenario(WS, WE, [fixed_task("a", "A", {"DBA": 1}, "2026-09-23T22:00", "2026-09-23T23:00")],
             {"DBA": 1})
b = scenario(WS, WE, [fixed_task("b", "B", {"DBA": 1}, "2026-09-23T23:00", "2026-09-24T00:00")],
             {"DBA": 1})
res = cross_check(
    [{"id": 1, "name": "场景A", "data": a}, {"id": 2, "name": "场景B", "data": b}],
    {"DBA": 1},
)
check("首尾相接不超限", res["overloads"] == [], res["overloads"])
check("两个场景均完整排程",
      all(e["fully_scheduled"] for e in res["scenarios"]))
check("fully_checked=true", res["stats"]["fully_checked"] is True)

print("4. 真实重叠：合计超限时给出连续时段 / 峰值 / 场景 / 任务")
c = scenario(WS, WE, [fixed_task("c", "C", {"DBA": 1}, "2026-09-23T22:30", "2026-09-23T23:00")],
             {"DBA": 1})
res = cross_check(
    [{"id": 1, "name": "场景A", "data": a}, {"id": 2, "name": "场景B", "data": b},
     {"id": 3, "name": "场景C", "data": c}],
    {"DBA": 1},
)
check("检出 1 个超限时段", len(res["overloads"]) == 1)
o = res["overloads"][0]
check("时段为 22:30~23:00", o["start"] == "2026-09-23T22:30"
      and o["end"] == "2026-09-23T23:00", o)
check("持续 30 分钟", o["duration_minutes"] == 30)
check("峰值 2 / 容量 1 / 超出 1", o["peak"] == 2 and o["capacity"] == 1 and o["excess"] == 1)
check("涉及场景 A、C",
      sorted(s["name"] for s in o["involved_scenarios"]) == ["场景A", "场景C"])
check("涉及任务 a、c", sorted(t["node_id"] for t in o["tasks"]) == ["a", "c"])
check("峰值时刻任务都标 at_peak", all(t["at_peak"] for t in o["tasks"]))
check("场景 B 不出现在该时段", "场景B" not in
      [s["name"] for s in o["involved_scenarios"]])
check("B(23:00开始) 未计入任务列表",
      not any(t["node_id"] == "b" for t in o["tasks"]))

print("5. 端点处结束/开始同时发生：相邻微区间合并为一个连续时段，峰值只升才更新")
# A 22:00-23:00；B 22:30-23:30；C 23:00-23:30；容量 1
# [22:30,23:00) = A+B = 2；23:00 处 A 结束、C 开始（半开）；[23:00,23:30) = B+C = 2
c2 = scenario(WS, WE, [fixed_task("c2", "C2", {"DBA": 1}, "2026-09-23T23:00", "2026-09-23T23:30")],
              {"DBA": 1})
a2 = scenario(WS, WE, [fixed_task("a2", "A2", {"DBA": 1}, "2026-09-23T22:00", "2026-09-23T23:00")],
              {"DBA": 1})
b2 = scenario(WS, WE, [fixed_task("b2", "B2", {"DBA": 1}, "2026-09-23T22:30", "2026-09-23T23:30")],
              {"DBA": 1})
res = cross_check(
    [{"id": 1, "name": "A", "data": a2}, {"id": 2, "name": "B", "data": b2},
     {"id": 3, "name": "C", "data": c2}],
    {"DBA": 1},
)
check("合并为 1 个连续时段", len(res["overloads"]) == 1, len(res["overloads"]))
o = res["overloads"][0]
check("合并后覆盖 22:30~23:30",
      o["start"] == "2026-09-23T22:30" and o["end"] == "2026-09-23T23:30", o)
check("峰值 2（23:00 半开不计三方重叠）", o["peak"] == 2, o)
check("涉及任务包含 a2/b2/c2",
      sorted(t["node_id"] for t in o["tasks"]) == ["a2", "b2", "c2"])
peak_tasks = sorted(t["node_id"] for t in o["tasks"] if t["at_peak"])
check("峰值任务取首个微区间 a2,b2", peak_tasks == ["a2", "b2"], peak_tasks)

print("6. 同资源多段不连续超限 -> 分别输出")
# A: 22:00-22:30；B: 22:00-22:30（冲突段1）；C: 01:00-01:30；D: 01:00-01:30（冲突段2）
s_a = scenario(WS, WE, [fixed_task("x1", "X1", {"DBA": 1}, "2026-09-23T22:00", "2026-09-23T22:30")], {"DBA": 1})
s_b = scenario(WS, WE, [fixed_task("y1", "Y1", {"DBA": 1}, "2026-09-23T22:00", "2026-09-23T22:30")], {"DBA": 1})
s_c = scenario(WS, WE, [fixed_task("x2", "X2", {"DBA": 1}, "2026-09-24T01:00", "2026-09-24T01:30")], {"DBA": 1})
s_d = scenario(WS, WE, [fixed_task("y2", "Y2", {"DBA": 1}, "2026-09-24T01:00", "2026-09-24T01:30")], {"DBA": 1})
res = cross_check(
    [{"id": i + 1, "name": n, "data": d} for i, (n, d) in
     enumerate([("A", s_a), ("B", s_b), ("C", s_c), ("D", s_d)])],
    {"DBA": 1},
)
check("检出 2 个独立超限时段", len(res["overloads"]) == 2, len(res["overloads"]))
check("按时段升序", res["overloads"][0]["start"] < res["overloads"][1]["start"])
check("第二段涉及 X2/Y2",
      sorted(t["node_id"] for t in res["overloads"][1]["tasks"]) == ["x2", "y2"])

print("7. 小数容量与小数占用")
s_e = scenario(WS, WE, [fixed_task("e", "E", {"GPU": 0.6}, "2026-09-23T22:00", "2026-09-23T23:00")], {"GPU": 1})
s_f = scenario(WS, WE, [fixed_task("f", "F", {"GPU": 0.6}, "2026-09-23T22:30", "2026-09-23T23:00")], {"GPU": 1})
res = cross_check([{"id": 1, "name": "E", "data": s_e}, {"id": 2, "name": "F", "data": s_f}],
                  {"GPU": 1})
check("0.6+0.6=1.2 > 1 检出", len(res["overloads"]) == 1 and
      res["overloads"][0]["peak"] == 1.2 and res["overloads"][0]["excess"] == 0.2)

# 刚好等于容量不算超限
s_f2 = scenario(WS, WE, [fixed_task("f", "F", {"GPU": 0.4}, "2026-09-23T22:30", "2026-09-23T23:00")], {"GPU": 1})
res = cross_check([{"id": 1, "name": "E", "data": s_e}, {"id": 2, "name": "F", "data": s_f2}],
                  {"GPU": 1})
check("合计恰等于容量不超限", res["overloads"] == [])

print("8. find_overload_periods 直接调用：空输入与峰值区间标记")
check("无占用区间 -> []", find_overload_periods("R", 1, []) == [])

print("9. 场景计划不可行：诊断 + 未排定任务跳过，不当作无冲突")
# 场景自身容量 1，两个固定任务同时占用 1 -> 一个排定一个未排程
s_bad = scenario(WS, WE, [
    fixed_task("ok", "可排", {"DBA": 1}, "2026-09-23T22:00", "2026-09-23T22:30"),
    fixed_task("no", "排不下", {"DBA": 1}, "2026-09-23T22:00", "2026-09-23T22:30"),
], {"DBA": 1})
res = cross_check([{"id": 1, "name": "坏场景", "data": s_bad},
                   {"id": 2, "name": "场景B", "data": b}], {"DBA": 1})
e_bad = next(e for e in res["scenarios"] if e["id"] == 1)
check("planned=true 但非完全排程", e_bad["planned"] and not e_bad["fully_scheduled"])
check("scheduled=1 total=2", e_bad["scheduled"] == 1 and e_bad["total"] == 2)
check("未排定任务为固定时刻冲突者（按 id 稳定顺序）",
      [u["id"] for u in e_bad["unscheduled"]] == ["ok"])
check("返回冲突诊断", len(e_bad["conflicts"]) >= 1)
check("warnings 明确跳过未排定任务",
      any("未排程" in w and "跳过" in w and "坏场景" in w for w in res["warnings"]),
      res["warnings"])
check("fully_checked=false", res["stats"]["fully_checked"] is False)
# 未排定的 no 若被当作 0 占用不会凭空消失：好场景 b 在 23:00 之后，无重叠 -> 无超限，
# 但结论被明确标记为不完整
check("已排定部分之间确无重叠 -> overloads 为空", res["overloads"] == [])

print("10. 全部场景都排不出任务：缺失占用绝不判为无冲突")
s_dead = scenario(WS, WE, [
    fixed_task("x", "X", {"DBA": 2}, "2026-09-23T22:00", "2026-09-23T22:30"),
], {"DBA": 1})  # 单任务需求 2 > 容量 1，永远排不下
res = cross_check([{"id": 1, "name": "死局1", "data": s_dead},
                   {"id": 2, "name": "死局2", "data": s_dead}], {"DBA": 1})
check("没有占用区间可汇总", res["overloads"] == [])
check("fully_checked=false（不宣称无冲突）", res["stats"]["fully_checked"] is False)
check("两个场景均未完全排程",
      all(not e["fully_scheduled"] and e["unscheduled"] for e in res["scenarios"]))
check("每个场景都有跳过警告", sum("死局" in w for w in res["warnings"]) >= 2)

print("11. 场景输入非法（窗口倒置）：error 诊断，其它场景照常核查")
s_invalid = {"window_start": WE, "window_end": WS, "nodes": [],
             "resources": {}, "edges": [], "blackouts": []}
res = cross_check([{"id": 1, "name": "非法场景", "data": s_invalid},
                   {"id": 2, "name": "场景A", "data": a},
                   {"id": 3, "name": "场景C", "data": c}], {"DBA": 1})
e_inv = res["scenarios"][0]
check("planned=false 且 error 有信息", e_inv["planned"] is False and bool(e_inv["error"]))
check("警告含计划失败", any("计划计算失败" in w for w in res["warnings"]))
# A/C 的重叠仍应检出
check("其余场景的重叠不被掩盖",
      len(res["overloads"]) == 1 and res["overloads"][0]["start"] == "2026-09-23T22:30")

print("12. 未提供共享容量的资源 -> unchecked_resources + 警告；unused_resources")
res = cross_check(
    [{"id": 1, "name": "场景A", "data": a}, {"id": 3, "name": "场景C", "data": c}],
    {"完全没人用的资源": 3},
)
unc = {u["resource"]: u for u in res["unchecked_resources"]}
check("DBA 进入未核查清单", "DBA" in unc)
check("DBA 涉及 2 个场景", len(unc["DBA"]["scenarios"]) == 2)
check("DBA 占用任务数=2", unc["DBA"]["task_count"] == 2)
check("警告提示 DBA 未核查", any("DBA" in w and "未参与核查" in w for w in res["warnings"]))
check("unused_resources 标记无人使用的容量项",
      res["unused_resources"] == ["完全没人用的资源"])

print("13. 多资源独立核查：无冲突资源不产生时段")
s_g = scenario(WS, WE, [
    fixed_task("g", "G", {"DBA": 1, "网络组": 1}, "2026-09-23T22:00", "2026-09-23T23:00")],
    {"DBA": 1, "网络组": 1})
s_h = scenario(WS, WE, [
    fixed_task("h", "H", {"DBA": 1}, "2026-09-23T22:00", "2026-09-23T23:00")],
    {"DBA": 1})
res = cross_check([{"id": 1, "name": "G", "data": s_g}, {"id": 2, "name": "H", "data": s_h}],
                  {"DBA": 1, "网络组": 5})
check("仅 DBA 超限", [o["resource"] for o in res["overloads"]] == ["DBA"])

# ---------------------------------------------------------------------------
# API 端到端
# ---------------------------------------------------------------------------
print("14. API：建场景 -> 核查 -> 校验错误 -> 只读")

tmpdir = tempfile.mkdtemp()
main.DB_PATH = type(main.DB_PATH)(os.path.join(tmpdir, "test-crosscheck.db"))
main.init_db()

from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(main.app)


def save(name, data):
    r = client.post("/api/scenarios", json={"name": name, "data": data})
    assert r.status_code == 201, r.text
    return r.json()["id"]


id_a = save("核查-A", a)
id_b = save("核查-B", b)
id_c = save("核查-C", c)

r = client.post("/api/cross-check", json={"scenario_ids": [id_a], "capacities": {"DBA": 1}})
check("只选 1 个场景 -> 422", r.status_code == 422, r.text)

r = client.post("/api/cross-check", json={"scenario_ids": [], "capacities": {"DBA": 1}})
check("空选择 -> 422", r.status_code == 422)

r = client.post("/api/cross-check",
                json={"scenario_ids": [id_a, 999999], "capacities": {"DBA": 1}})
check("引用不存在场景 -> 422 且返回 missing id",
      r.status_code == 422 and 999999 in r.json()["detail"]["missing_scenario_ids"], r.text)

r = client.post("/api/cross-check", json={"scenario_ids": [id_a, id_b], "capacities": {}})
check("容量为空 -> 422", r.status_code == 422)

r = client.post("/api/cross-check",
                json={"scenario_ids": [id_a, id_b], "capacities": {"DBA": 0}})
check("容量 <=0 -> 422", r.status_code == 422)

r = client.post("/api/cross-check",
                json={"scenario_ids": [id_a, id_b, id_c], "capacities": {"DBA": 1}})
check("合法核查 200", r.status_code == 200, r.text)
body = r.json()
check("响应含 capacities/scenarios/overloads/warnings/stats",
      set(["capacities", "scenarios", "overloads", "warnings",
           "unchecked_resources", "unused_resources", "stats"]) <= set(body))
check("检出 A/C 重叠 1 段", len(body["overloads"]) == 1)
check("场景顺序与选择顺序一致",
      [s["id"] for s in body["scenarios"]] == [id_a, id_b, id_c])
check("重复 id 去重（3 个含 1 重复 -> 仍按 2 场景且不报缺失）",
      client.post("/api/cross-check",
                  json={"scenario_ids": [id_a, id_a, id_b],
                        "capacities": {"DBA": 1}}).status_code == 200)

# 只读：场景数据与数量不变
r1 = client.get(f"/api/scenarios/{id_a}").json()
check("核查后场景内容未被改动", r1["data"] == a)
check("核查不产生执行记录",
      client.get(f"/api/scenarios/{id_a}/execution").json()["records"] == [])
check("场景总数仍为 3", len(client.get("/api/scenarios").json()) == 3)

# 核查接口支持编辑器 state 存储格式（页面真实保存形态）
state_id = save("核查-state形态", state)
r = client.post("/api/cross-check",
                json={"scenario_ids": [state_id, id_b], "capacities": {"DBA": 2}})
check("state 格式场景可直接核查 200", r.status_code == 200, r.text)

print(f"\n全部 {passed} 项检查通过 ✔")
