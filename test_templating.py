"""场景模板引擎测试。运行：python3 test_templating.py"""
import sys
sys.path.insert(0, ".")
from app.templating import resolve, TemplateError
from app.scheduler import solve

passed = 0
def check(name, cond, extra=""):
    global passed
    assert cond, f"FAIL: {name} {extra}"
    passed += 1
    print(f"  ok - {name}")


def make_template(**over):
    tpl = {
        "name": "t",
        "variables": [
            {"name": "base_date", "type": "date", "label": "基准日期", "default": "2026-09-23"},
            {"name": "upgrade_dur", "type": "duration", "default": 90},
            {"name": "guard", "type": "offset", "default": 15},
        ],
        "scenario": {
            "window_start": "{{base_date @ 22:00}}",
            "window_end": "{{base_date + 1d @ 06:00}}",
            "resources": {"DBA": 1},
            "nodes": [
                {"id": "a", "name": "主备切换", "duration_minutes": 30, "resources": {"DBA": 1},
                 "fixed_start": "{{base_date @ 22:00}}"},
                {"id": "b", "name": "版本升级", "duration_minutes": "{{upgrade_dur}}",
                 "resources": {"DBA": 1}, "fixed_start": "{{end(a) + guard}}"},
                {"id": "c", "name": "流量切回", "duration_minutes": 20, "resources": {"DBA": 1},
                 "fixed_start": "{{end(b) + 1h}}"},
            ],
            "edges": [{"source": "a", "target": "b"}, {"source": "b", "target": "c"}],
            "blackouts": [],
        },
    }
    tpl.update(over)
    return tpl


print("1. 基准日期 + 任务时长 + 前置结束偏移：解析为具体时间")
out = resolve(make_template(), {"base_date": "2026-10-01", "upgrade_dur": 60, "guard": 20})
check("无问题", not out["issues"], out["issues"])
s = out["scenario"]
check("窗口起", s["window_start"] == "2026-10-01T22:00")
check("窗口止（次日06:00）", s["window_end"] == "2026-10-02T06:00")
check("b 时长取参数", s["nodes"][1]["duration_minutes"] == 60)
check("b 固定于 a 结束 +20m = 22:50", s["nodes"][1]["fixed_start"] == "2026-10-01T22:50")
check("c 固定于 b 结束 +1h = 次日00:50", s["nodes"][2]["fixed_start"] == "2026-10-02T00:50")
check("回显参数", out["params"]["base_date"] == "2026-10-01T00:00")
check("锚点时间表 a.end", out["resolved"]["anchor_times"]["a"]["end"] == "2026-10-01T22:30")

print("2. 解析结果直接交给现有排程器")
r = solve(s)
check("排程可行", r["feasible"], r["conflicts"])
check("3 个任务全部排程", r["stats"]["scheduled"] == 3)
check("c 保持固定时间", next(i for i in r["items"] if i["id"] == "c")["start"] == "2026-10-02T00:50")

print("3. 默认参数生效（不传 params）")
out = resolve(make_template(), {})
check("默认 upgrade_dur=90", out["scenario"]["nodes"][1]["duration_minutes"] == 90)
check("默认 guard=15 → b 22:45", out["scenario"]["nodes"][1]["fixed_start"] == "2026-09-23T22:45")

print("4. 基准日期支持仅传日期 / 传完整时间")
out = resolve(make_template(), {"base_date": "2026-10-01T08:30"})
check("完整时间入参 @22:00 仍为 22:00",
      out["scenario"]["window_start"] == "2026-10-01T22:00", out["scenario"]["window_start"])

print("5. start() 锚点与负偏移")
tpl = make_template(scenario={
    "window_start": "{{base_date @ 22:00}}", "window_end": "{{base_date + 1d @ 06:00}}",
    "resources": {}, "blackouts": [],
    "nodes": [
        {"id": "a", "duration_minutes": 30, "fixed_start": "{{base_date @ 23:00}}"},
        {"id": "b", "duration_minutes": 10, "fixed_start": "{{start(a) - 15m}}"},
    ],
    "edges": [{"source": "b", "target": "a"}],
})
out = resolve(tpl, {})
check("b = 22:45", out["scenario"]["nodes"][1]["fixed_start"] == "2026-09-23T22:45",
      out["scenario"]["nodes"][1])

print("6. 循环引用：end(a) ↔ end(b)")
tpl = make_template(scenario={
    "window_start": "{{base_date @ 22:00}}", "window_end": "{{base_date + 1d @ 06:00}}",
    "resources": {}, "blackouts": [],
    "nodes": [
        {"id": "a", "duration_minutes": 10, "fixed_start": "{{end(b)}}"},
        {"id": "b", "duration_minutes": 10, "fixed_start": "{{end(a)}}"},
    ],
    "edges": [],
})
out = resolve(tpl, {})
check("有 variable_cycle", any(i["code"] == "variable_cycle" for i in out["issues"]))
check("错误时不生成场景", out["scenario"] is None)
check("环上节点为 a,b", set(out["issues"][0]["chain"]) == {"a", "b"})

print("7. 自环：end(a) 锚定自身")
tpl["scenario"]["nodes"] = [
    {"id": "a", "duration_minutes": 10, "fixed_start": "{{end(a)}}"},
]
out = resolve(tpl, {})
check("自环检测", any(i["code"] == "variable_cycle" and i["chain"] == ["a"]
                      for i in out["issues"]), out["issues"])

print("8. 锚点指向弹性任务（无固定开始）→ anchor_unresolved")
tpl = make_template(scenario={
    "window_start": "{{base_date @ 22:00}}", "window_end": "{{base_date + 1d @ 06:00}}",
    "resources": {}, "blackouts": [],
    "nodes": [
        {"id": "a", "duration_minutes": 10},
        {"id": "b", "duration_minutes": 10, "fixed_start": "{{end(a) + 10m}}"},
    ],
    "edges": [{"source": "a", "target": "b"}],
})
out = resolve(tpl, {})
check("anchor_unresolved", any(i["code"] == "anchor_unresolved" for i in out["issues"]))
check("只报一条（不级联）", len(out["issues"]) == 1, out["issues"])

print("9. 参数错误：缺失必填 / 非数字")
tpl = {
    "variables": [
        {"name": "base_date", "type": "date"},
        {"name": "d", "type": "duration"},
    ],
    "scenario": {
        "window_start": "{{base_date @ 22:00}}", "window_end": "{{base_date + 1d @ 06:00}}",
        "resources": {}, "blackouts": [],
        "nodes": [
            {"id": "a", "duration_minutes": "{{d}}",
             "fixed_start": "{{base_date @ 22:00}}"},
        ],
        "edges": [],
    },
}
out = resolve(tpl, {"d": "abc"})
codes = [i["code"] for i in out["issues"]]
check("两条 param_error", codes == ["param_error", "param_error"], codes)
check("无级联 anchor 噪声", "anchor_unresolved" not in codes)

print("10. 时间越界：固定任务超出窗口 → warning 但仍排程")
tpl = make_template(scenario={
    "window_start": "{{base_date @ 22:00}}", "window_end": "{{base_date + 1d @ 23:00}}",
    "resources": {}, "blackouts": [],
    "nodes": [{"id": "a", "duration_minutes": 30,
               "fixed_start": "{{base_date + 1d @ 22:50}}"}],
    "edges": [],
})
out = resolve(tpl, {})
check("warning out_of_window",
      any(i["severity"] == "warning" and i["code"] == "out_of_window"
          for i in out["issues"]), out["issues"])
check("warning 时仍生成场景", out["scenario"] is not None)
r = solve(out["scenario"])
check("排程器判定 fixed_window", any(c["type"] == "fixed_window" for c in r["conflicts"]))

print("11. 禁排期表达式解析 + 越界 warning")
tpl = make_template(scenario={
    "window_start": "{{base_date @ 22:00}}", "window_end": "{{base_date + 1d @ 06:00}}",
    "resources": {},
    "nodes": [{"id": "a", "duration_minutes": 150}],
    "edges": [],
    "blackouts": [
        {"name": "计费", "start": "{{base_date + 1d @ 00:00}}",
         "end": "{{base_date + 1d @ 00:30}}"},
        {"name": "窗口外", "start": "{{base_date + 2d @ 00:00}}",
         "end": "{{base_date + 2d @ 01:00}}"},
    ],
})
out = resolve(tpl, {})
check("禁排期已解析", out["scenario"]["blackouts"][0]["start"] == "2026-09-24T00:00")
check("窗口外禁排期 warning",
      any(i["code"] == "out_of_window_blackout" for i in out["issues"]), out["issues"])
r = solve(out["scenario"])
# 22:00 起 150 分钟会撞上 00:00-00:30 禁排期 → 推迟到 00:30
check("任务被推到 00:30", r["items"][0]["start"] == "2026-09-24T00:30", r["items"])

print("12. 未知变量 / 未知任务引用")
tpl = make_template(scenario={
    "window_start": "{{base_date @ 22:00}}", "window_end": "{{base_date + 1d @ 06:00}}",
    "resources": {}, "blackouts": [],
    "nodes": [{"id": "a", "duration_minutes": "{{missing}}",
               "fixed_start": "{{end(ghost)}}"}],
    "edges": [],
})
out = resolve(tpl, {})
codes = {i["code"] for i in out["issues"]}
check("unknown_variable", "unknown_variable" in codes, codes)
check("unknown_node", "unknown_node" in codes, codes)

print("13. 类型错误：日期变量用于分钟字段 / 分钟变量用于时间")
tpl = make_template(scenario={
    "window_start": "{{base_date @ 22:00}}", "window_end": "{{base_date + 1d @ 06:00}}",
    "resources": {}, "blackouts": [],
    "nodes": [{"id": "a", "duration_minutes": "{{base_date}}"}],
    "edges": [],
})
out = resolve(tpl, {})
check("日期→分钟 type_error", any(i["code"] == "type_error" for i in out["issues"]), out["issues"])

tpl2 = make_template(scenario={
    "window_start": "{{base_date @ 22:00}}", "window_end": "{{base_date + 1d @ 06:00}}",
    "resources": {}, "blackouts": [],
    "nodes": [{"id": "a", "duration_minutes": 10, "fixed_start": "{{guard}}"}],
    "edges": [],
})
out = resolve(tpl2, {})
check("分钟→时间 type_error", any(i["code"] == "type_error" for i in out["issues"]), out["issues"])

print("14. 表达式语法错误 → TemplateError（结构校验阶段）")
from app.templating import normalize_template
bad_scen = {
    "window_start": "{{base_date @ 22:00}}", "window_end": "{{base_date + 1d @ 06:00}}",
    "nodes": [{"id": "a", "duration_minutes": "{{+ +}}"}],
}
bad_tpl = {"variables": [{"name": "base_date", "type": "date"}], "scenario": bad_scen}
try:
    normalize_template(bad_tpl)
    raise AssertionError("应抛 TemplateError")
except TemplateError:
    check("语法错误抛 TemplateError", True)

print("15. 无变量模板（普通场景）也能解析，与直接排程等价")
plain = {
    "scenario": {
        "window_start": "2026-09-23T22:00", "window_end": "2026-09-24T06:00",
        "resources": {"DBA": 1},
        "nodes": [
            {"id": "a", "duration_minutes": 30, "resources": {"DBA": 1}},
            {"id": "b", "duration_minutes": 30, "resources": {"DBA": 1}},
        ],
        "edges": [{"source": "a", "target": "b"}], "blackouts": [],
    }
}
out = resolve(plain, {})
check("无问题", not out["issues"], out["issues"])
check("排程可行", solve(out["scenario"])["feasible"])

print("16. 时长运算：{{d}}*2 / 30m+15m 等算术表达式")
tpl = make_template(scenario={
    "window_start": "{{base_date @ 22:00}}", "window_end": "{{base_date + 1d @ 06:00}}",
    "resources": {}, "blackouts": [],
    "nodes": [
        {"id": "a", "duration_minutes": "{{upgrade_dur / 3 + 10m}}"},
        {"id": "b", "duration_minutes": 10, "fixed_start": "{{base_date + 2h + 30m}}"},
    ],
    "edges": [],
})
out = resolve(tpl, {"upgrade_dur": 60})
check("60/3+10=30", out["scenario"]["nodes"][0]["duration_minutes"] == 30,
      out["scenario"]["nodes"][0])
check("基准日00:00+2h30m=02:30", out["scenario"]["nodes"][1]["fixed_start"] == "2026-09-23T02:30")

print("17. 变量定义校验")
try:
    normalize_template({"variables": [{"name": "end", "type": "date"}], "scenario": {}})
    raise AssertionError()
except TemplateError as e:
    check("保留字拒绝", "保留字" in str(e))
try:
    normalize_template({"variables": [{"name": "x", "type": "weird"}], "scenario": {}})
    raise AssertionError()
except TemplateError as e:
    check("非法类型拒绝", "type" in str(e))
try:
    normalize_template({"variables": [{"name": "x"}, {"name": "x"}], "scenario": {}})
    raise AssertionError()
except TemplateError as e:
    check("重名拒绝", "重复" in str(e))

print("18. 窗口起止颠倒 → error")
tpl = make_template(scenario={
    "window_start": "{{base_date + 1d @ 06:00}}", "window_end": "{{base_date @ 22:00}}",
    "resources": {}, "nodes": [], "edges": [], "blackouts": [],
})
out = resolve(tpl, {})
check("窗口颠倒报错", any(i["code"] == "datetime_error" for i in out["issues"]), out["issues"])
check("不生成场景", out["scenario"] is None)

print("19. 三级链 a→b→c 的波次推进解析")
tpl = make_template(scenario={
    "window_start": "{{base_date @ 22:00}}", "window_end": "{{base_date + 1d @ 06:00}}",
    "resources": {}, "blackouts": [],
    "nodes": [
        {"id": "a", "duration_minutes": 10, "fixed_start": "{{base_date @ 22:00}}"},
        {"id": "b", "duration_minutes": 10, "fixed_start": "{{end(a)}}"},
        {"id": "c", "duration_minutes": 10, "fixed_start": "{{end(b) + 5m}}"},
        {"id": "d", "duration_minutes": 10, "fixed_start": "{{start(c) + 5m}}"},
    ],
    "edges": [{"source": "a", "target": "b"}, {"source": "b", "target": "c"},
              {"source": "c", "target": "d"}],
})
out = resolve(tpl, {})
check("全部解析无问题", not out["issues"], out["issues"])
fix = {n["id"]: n["fixed_start"] for n in out["scenario"]["nodes"]}
check("b 22:10", fix["b"] == "2026-09-23T22:10", fix)
check("c 22:25", fix["c"] == "2026-09-23T22:25", fix)
check("d 22:30", fix["d"] == "2026-09-23T22:30", fix)

print(f"\n模板引擎全部 {passed} 项检查通过 ✔")
