"""scheduler 核心逻辑测试。运行：python test_scheduler.py"""
import sys
sys.path.insert(0, ".")
from app.scheduler import solve, find_cycles, normalize

W0, W1 = "2026-09-23T22:00", "2026-09-24T06:00"


def base(**over):
    p = dict(
        window_start=W0, window_end=W1,
        resources={"DBA": 1, "NET": 1},
        nodes=[
            {"id": "a", "name": "A", "duration_minutes": 30, "resources": {"DBA": 1}},
            {"id": "b", "name": "B", "duration_minutes": 30, "resources": {"DBA": 1, "NET": 1}},
            {"id": "c", "name": "C", "duration_minutes": 20, "resources": {"NET": 1}},
        ],
        edges=[], blackouts=[],
    )
    p.update(over)
    return p


def names(items):
    return {it["id"]: (it["start_label"], it["end_label"]) for it in items}


passed = 0
def check(name, cond, extra=""):
    global passed
    assert cond, f"FAIL: {name} {extra}"
    passed += 1
    print(f"  ok - {name}")


print("1. 基本可行排程（拓扑序 + 串行）")
r = solve(base(edges=[{"source": "a", "target": "b"}, {"source": "b", "target": "c"}]))
check("feasible", r["feasible"])
check("全部3项排程", r["stats"]["scheduled"] == 3)
check("顺序 a,b,c", r["order"] == ["a", "b", "c"], r["order"])
check("a 从窗口起点开始", r["items"][0]["start"] == "2026-09-23T22:00")
check("b 在 a 结束后 22:30", r["items"][1]["start"] == "2026-09-23T22:30")
check("c 在 23:00", r["items"][2]["start"] == "2026-09-23T23:00")

print("2. 资源冲突：两个 DBA 任务并行 → 串行，c 可并行")
r = solve(base(edges=[]))
check("可行（容量内可排开）", r["feasible"], r["conflicts"])
starts = {it["id"]: it["start"] for it in r["items"]}
ends = {it["id"]: it["end"] for it in r["items"]}
# a 和 b 都需要 DBA=1，不能重叠
check("DBA 任务不重叠",
      not (starts["b"] < ends["a"] and starts["a"] < ends["b"]),
      (starts, ends))

print("3. 资源需求超过容量 → 永远无法排程")
p = base(nodes=[{"id": "x", "name": "X", "duration_minutes": 10, "resources": {"DBA": 2}}])
r = solve(p)
check("不可行", not r["feasible"])
check("冲突类型 capacity/unschedulable",
      any(c["type"] == "unschedulable" and c["resource"] == "DBA" for c in r["conflicts"]),
      r["conflicts"])
check("x 在 unscheduled", "x" in r["unscheduled"])

print("4. 窗口太小 → 无法排程")
p = base(window_start="2026-09-23T22:00", window_end="2026-09-23T22:10",
         nodes=[{"id": "a", "name": "A", "duration_minutes": 30, "resources": {}}],
         edges=[])
r = solve(p)
check("不可行", not r["feasible"])
check("unschedulable 冲突", any(c["type"] == "unschedulable" for c in r["conflicts"]))

print("5. 简单环 a→b→a 检测 + 冲突链")
r = solve(base(edges=[{"source": "a", "target": "b"}, {"source": "b", "target": "a"}]))
check("不可行", not r["feasible"])
cyc = [c for c in r["conflicts"] if c["type"] == "cycle"]
check("有一个循环冲突", len(cyc) == 1, r["conflicts"])
check("环包含 a,b", set(cyc[0]["chain"]) == {"a", "b"}, cyc[0])
check("环有两条边可定位", len(cyc[0]["edges"]) == 2, cyc[0]["edges"])
check("a,b 未排程", set(r["unscheduled"]) == {"a", "b"})
check("c 不受环影响仍排程", any(it["id"] == "c" for it in r["items"]))

print("6. 自环检测")
r = solve(base(edges=[{"source": "a", "target": "a"}]))
cyc = [c for c in r["conflicts"] if c["type"] == "cycle"]
check("检测到自环", len(cyc) == 1 and cyc[0]["chain"] == ["a"])

print("7. 三角环（3节点）")
p = base(nodes=[
    {"id": "a", "name": "A", "duration_minutes": 10, "resources": {}},
    {"id": "b", "name": "B", "duration_minutes": 10, "resources": {}},
    {"id": "c", "name": "C", "duration_minutes": 10, "resources": {}},
], edges=[{"source": "a", "target": "b"}, {"source": "b", "target": "c"},
          {"source": "c", "target": "a"}])
r = solve(p)
cyc = [c for c in r["conflicts"] if c["type"] == "cycle"]
check("三角环检测", len(cyc) == 1 and set(cyc[0]["chain"]) == {"a", "b", "c"})
check("3条边", len(cyc[0]["edges"]) == 3)

print("8. 悬空依赖边")
r = solve(base(edges=[{"source": "a", "target": "ghost"}]))
check("dangling 冲突", any(c["type"] == "dangling_edge" for c in r["conflicts"]))

print("9. 禁排期：任务被推到禁排期之后")
p = base(
    nodes=[{"id": "a", "name": "A", "duration_minutes": 30, "resources": {}}],
    edges=[],
    blackouts=[{"name": "冻结", "start": "2026-09-23T22:00", "end": "2026-09-23T23:00"}])
r = solve(p)
check("可行（推迟）", r["feasible"], r["conflicts"])
check("从 23:00 开始", r["items"][0]["start"] == "2026-09-23T23:00")

print("10. 固定开始时间冲突（与禁排期重叠）")
p = base(
    nodes=[{"id": "a", "name": "A", "duration_minutes": 30, "resources": {},
            "fixed_start": "2026-09-23T22:15"}],
    edges=[],
    blackouts=[{"name": "冻结", "start": "2026-09-23T22:00", "end": "2026-09-23T23:00"}])
r = solve(p)
check("fixed_blackout 冲突", any(c["type"] == "fixed_blackout" for c in r["conflicts"]))
check("a 未排程", "a" in r["unscheduled"])

print("11. 固定开始时间但满足约束 → 保留给定时间")
p = base(
    nodes=[{"id": "a", "name": "A", "duration_minutes": 30, "resources": {},
            "fixed_start": "2026-09-24T03:00"}],
    edges=[])
r = solve(p)
check("可行", r["feasible"], r["conflicts"])
check("保留 03:00 固定时间", r["items"][0]["start"] == "2026-09-24T03:00")
check("标记 fixed", r["items"][0]["fixed"] is True)

print("12. 固定时间早于前置完成 → fixed_predecessor")
p = base(
    nodes=[
        {"id": "a", "name": "A", "duration_minutes": 60, "resources": {}},
        {"id": "b", "name": "B", "duration_minutes": 10, "resources": {},
         "fixed_start": "2026-09-23T22:20"},
    ],
    edges=[{"source": "a", "target": "b"}])
r = solve(p)
check("fixed_predecessor", any(c["type"] == "fixed_predecessor" for c in r["conflicts"]),
      r["conflicts"])

print("13. 固定任务超出窗口")
p = base(nodes=[{"id": "a", "name": "A", "duration_minutes": 30, "resources": {},
                 "fixed_start": "2026-09-24T05:50"}], edges=[])
r = solve(p)
check("fixed_window", any(c["type"] == "fixed_window" for c in r["conflicts"]))

print("14. 多资源容量：应用组容量2，两个 1 用量任务并行 OK")
p = base(resources={"APP": 2},
         nodes=[
             {"id": "a", "name": "A", "duration_minutes": 30, "resources": {"APP": 1}},
             {"id": "b", "name": "B", "duration_minutes": 30, "resources": {"APP": 1}},
         ], edges=[])
r = solve(p)
check("可行并行", r["feasible"], r["conflicts"])
check("同时开始", r["items"][0]["start"] == r["items"][1]["start"])

print("15. 依赖阻塞传播：a 不可排程 → b,c 依赖 a 也无法排程")
p = base(
    nodes=[
        {"id": "a", "name": "A", "duration_minutes": 10, "resources": {"DBA": 2}},
        {"id": "b", "name": "B", "duration_minutes": 10, "resources": {}},
        {"id": "c", "name": "C", "duration_minutes": 10, "resources": {}},
    ],
    edges=[{"source": "a", "target": "b"}, {"source": "b", "target": "c"}])
r = solve(p)
blocked = [c for c in r["conflicts"] if c["type"] == "dependency_blocked"]
check("有两个依赖阻塞", len(blocked) == 2, [c["message"] for c in blocked])
chains = {tuple(c["chain"]) for c in blocked}
check("阻塞链 a→b, b→c", ("a", "b") in chains and ("b", "c") in chains, chains)
check("全部未排程", set(r["unscheduled"]) == {"a", "b", "c"})

print("16. 输入校验：缺少窗口")
try:
    solve({"window_start": W0, "nodes": [], "edges": [], "blackouts": []})
    raise AssertionError("应抛 ValueError")
except ValueError as e:
    check("报缺维护窗口结束时间", "结束时间" in str(e))

print("17. 输入校验：负时长")
try:
    solve(base(nodes=[{"id": "a", "name": "A", "duration_minutes": -5, "resources": {}}]))
    raise AssertionError("应抛 ValueError")
except ValueError as e:
    check("报时长错误", "时长" in str(e))

print("18. 重复 id")
try:
    solve(base(nodes=[
        {"id": "a", "name": "A", "duration_minutes": 5, "resources": {}},
        {"id": "a", "name": "A2", "duration_minutes": 5, "resources": {}},
    ]))
    raise AssertionError("应抛 ValueError")
except ValueError as e:
    check("报重复 id", "重复" in str(e))

print("19. 较大规模压力（50 节点链式 + 资源竞争），不应触发迭代上限")
nodes = [{"id": f"n{i}", "name": f"N{i}", "duration_minutes": 10,
          "resources": {"DBA": 1}} for i in range(50)]
edges = [{"source": f"n{i-1}", "target": f"n{i}"} for i in range(1, 50)]
r = solve(base(window_start="2026-09-23T22:00", window_end="2026-09-24T22:00",
               nodes=nodes, edges=edges, resources={"DBA": 1}))
check("50 节点全部排程", r["stats"]["scheduled"] == 50, r["conflicts"][:1])
check("总跨度 500 分钟", r["stats"]["makespan_minutes"] == 500, r["stats"])

print("20. 统计 makespan 与输出字段完整")
r = solve(base(edges=[{"source": "a", "target": "b"}]))
it = r["items"][0]
for k in ("id", "name", "start", "end", "start_label", "end_label",
          "duration_minutes", "fixed", "resources", "predecessors", "successors"):
    check(f"字段 {k} 存在", k in it)

print(f"\n全部 {passed} 项检查通过 ✔")
