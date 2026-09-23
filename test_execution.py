"""实际执行记录校验与 API 测试。运行：python test_execution.py"""
import os
import sys
import tempfile

sys.path.insert(0, ".")

from app.execution import validate_and_normalize, RecordValidationError
from app import main
from app.models import ExecutionRecordsIn

passed = 0
def check(name, cond, extra=""):
    global passed
    assert cond, f"FAIL: {name} {extra}"
    passed += 1
    print(f"  ok - {name}")


NODES = ["a", "b", "c"]
T0, T1, T2, T3 = (
    "2026-09-23T22:00", "2026-09-23T22:30",
    "2026-09-23T23:05", "2026-09-24T00:00",
)

print("1. 正常：全部已执行，规整为按场景任务顺序的记录")
out = validate_and_normalize(NODES, [
    {"node_id": "c", "executed": True, "actual_start": T2, "actual_end": T3},
    {"node_id": "a", "executed": True, "actual_start": T0, "actual_end": T1},
    {"node_id": "b", "executed": False, "reason": "窗口取消"},
])
check("顺序与场景一致", [r["node_id"] for r in out] == ["a", "b", "c"])
check("a 已执行", out[0]["executed"] is True and out[0]["actual_start"] == T0)
check("b 未执行且保留原因", out[1]["executed"] is False and out[1]["reason"] == "窗口取消")
check("未执行项的时间字段为空", out[1]["actual_start"] is None and out[1]["actual_end"] is None)

print("2. 时间格式归一化（带秒 / 带时区均接受）")
out = validate_and_normalize(["a"], [
    {"node_id": "a", "executed": True,
     "actual_start": "2026-09-23T22:05:30", "actual_end": "2026-09-23T22:40Z"},
])
check("开始时间截断到分钟", out[0]["actual_start"] == "2026-09-23T22:05")
check("结束时间去 Z 截断到分钟", out[0]["actual_end"] == "2026-09-23T22:40")

print("3. 缺少记录 / 多余引用 / 重复")
def expect_errors(ids, records):
    try:
        validate_and_normalize(ids, records)
        raise AssertionError("应抛 RecordValidationError")
    except RecordValidationError as e:
        return e.errors

errs = expect_errors(NODES, [
    {"node_id": "a", "executed": True, "actual_start": T0, "actual_end": T1},
])
check("缺两条 -> 汇总提示缺失", any("缺少执行记录" in e["message"] and "b" in e["message"] for e in errs), errs)

errs = expect_errors(NODES, [
    {"node_id": "a", "executed": True, "actual_start": T0, "actual_end": T1},
    {"node_id": "b", "executed": True, "actual_start": T0, "actual_end": T1},
    {"node_id": "x", "executed": True, "actual_start": T0, "actual_end": T1},
    {"node_id": "c", "executed": True, "actual_start": T0, "actual_end": T1},
])
check("引用无效任务被拒", any("引用无效" in e["message"] and e["node_id"] == "x" for e in errs), errs)

errs = expect_errors(NODES, [
    {"node_id": "a", "executed": True, "actual_start": T0, "actual_end": T1},
    {"node_id": "a", "executed": False, "reason": "重复"},
    {"node_id": "b", "executed": True, "actual_start": T0, "actual_end": T1},
    {"node_id": "c", "executed": True, "actual_start": T0, "actual_end": T1},
])
check("同任务多条被拒", any("多条记录" in e["message"] and e["node_id"] == "a" for e in errs), errs)

errs = expect_errors(NODES, [
    {"node_id": "", "executed": True},
    {"node_id": "a", "executed": True, "actual_start": T0, "actual_end": T1},
    {"node_id": "b", "executed": True, "actual_start": T0, "actual_end": T1},
])
check("空 id 被拒", any("缺少任务 id" in e["message"] for e in errs), errs)

print("4. 已执行：缺时间 / 格式错 / 结束早于开始")
errs = expect_errors(NODES, [
    {"node_id": "a", "executed": True, "actual_start": None, "actual_end": T1},
    {"node_id": "b", "executed": True, "actual_start": T1, "actual_end": "not-a-time"},
    {"node_id": "c", "executed": True, "actual_start": T2, "actual_end": T0},
])
check("a 缺开始", any(e["node_id"] == "a" and "开始时间" in e["message"] for e in errs), errs)
check("b 时间格式错", any(e["node_id"] == "b" and "格式无效" in e["message"] for e in errs), errs)
check("c 结束早于开始", any(e["node_id"] == "c" and "结束时间不能早于" in e["message"] for e in errs), errs)
check("同时汇总缺失（没有合法记录）", any("缺少执行记录" in e["message"] for e in errs), errs)

print("5. 开始=结束允许（0 分钟执行）；未执行原因必填/限长")
out = validate_and_normalize(["a"], [
    {"node_id": "a", "executed": True, "actual_start": T0, "actual_end": T0},
])
check("零时长可接受", out[0]["actual_end"] == T0)

errs = expect_errors(["a"], [{"node_id": "a", "executed": False, "reason": "   "}])
check("空白原因被拒", any("未执行原因" in e["message"] for e in errs), errs)

errs = expect_errors(["a"], [{"node_id": "a", "executed": False, "reason": "x" * 501}])
check("原因超长被拒", any("500" in e["message"] for e in errs), errs)

errs = expect_errors(["a"], [{"node_id": "a", "executed": True}])
check("缺 executed 之外字段也能定位", bool(errs))

print("6. records 非数组")
try:
    validate_and_normalize(NODES, {"a": 1})
    raise AssertionError("应抛错")
except RecordValidationError as e:
    check("报 records 必须是数组", "数组" in e.errors[0]["message"])


# ---------------------------------------------------------------------------
# API 端到端（FastAPI TestClient 风格；只用 fastapi 自带依赖）
# ---------------------------------------------------------------------------
print("7. API：建场景 -> 保存 -> 查询 -> 错误整批拒绝（不留部分数据）-> 替换")

tmpdir = tempfile.mkdtemp()
main.DB_PATH = type(main.DB_PATH)(os.path.join(tmpdir, "test-exec.db"))
main.init_db()

from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(main.app)

scenario_state = {
    "windowStart": "2026-09-23T22:00", "windowEnd": "2026-09-24T06:00",
    "resources": [{"name": "DBA", "capacity": 1}],
    "nodes": [
        {"id": "a", "name": "任务A", "duration_minutes": 30, "resources": {}, "fixed_start": None},
        {"id": "b", "name": "任务B", "duration_minutes": 20, "resources": {}, "fixed_start": None},
    ],
    "edges": [], "blackouts": [], "uid": 3,
}
r = client.post("/api/scenarios", json={"name": "执行记录测试场景", "data": scenario_state})
check("场景已创建", r.status_code == 201, r.text)
sid = r.json()["id"]

r = client.get(f"/api/scenarios/{sid}/execution")
check("初始无记录", r.status_code == 200 and r.json()["records"] == []
      and r.json()["complete"] is False, r.text)

bad_body = ExecutionRecordsIn(records=[
    {"node_id": "a", "executed": True,
     "actual_start": "2026-09-23T22:00", "actual_end": "2026-09-23T22:30"},
    {"node_id": "b", "executed": True,
     "actual_start": "2026-09-23T23:00", "actual_end": "2026-09-23T22:00"},  # 结束早于开始
]).model_dump()
r = client.put(f"/api/scenarios/{sid}/execution", json=bad_body)
check("非法整批 422", r.status_code == 422, r.text)
detail = r.json()["detail"]
check("422 返回 errors 明细", isinstance(detail, dict) and len(detail["errors"]) >= 1)
check("错误定位到 b", any(e["node_id"] == "b" for e in detail["errors"]), detail)

r = client.get(f"/api/scenarios/{sid}/execution")
check("拒绝后不留任何部分数据", r.json()["records"] == [], r.text)

good = {"records": [
    {"node_id": "a", "executed": True,
     "actual_start": "2026-09-23T22:05", "actual_end": "2026-09-23T22:40"},
    {"node_id": "b", "executed": False, "reason": "DBA 通宵不可用"},
]}
r = client.put(f"/api/scenarios/{sid}/execution", json=good)
check("合法整批 200", r.status_code == 200 and r.json()["saved"] == 2, r.text)

r = client.get(f"/api/scenarios/{sid}/execution")
data = r.json()
check("complete=true 且按任务顺序",
      data["complete"] is True and [x["node_id"] for x in data["records"]] == ["a", "b"], data)
check("updated_at 已记录", bool(data["updated_at"]))

print("8. API：无效引用 / 缺漏均被拒；重复保存为整批替换")
bad_ref = {"records": [
    {"node_id": "a", "executed": True,
     "actual_start": T0, "actual_end": T1},
    {"node_id": "ghost", "executed": False, "reason": "x"},
]}
r = client.put(f"/api/scenarios/{sid}/execution", json=bad_ref)
check("无效引用 422", r.status_code == 422)
r = client.get(f"/api/scenarios/{sid}/execution")
check("旧数据未被破坏（仍是 a/b 两条）", len(r.json()["records"]) == 2)

replaced = {"records": [
    {"node_id": "a", "executed": True, "actual_start": T0, "actual_end": T1},
    {"node_id": "b", "executed": True, "actual_start": T1, "actual_end": T2},
]}
r = client.put(f"/api/scenarios/{sid}/execution", json=replaced)
check("二次保存成功（替换）", r.status_code == 200, r.text)
r = client.get(f"/api/scenarios/{sid}/execution")
recs = r.json()["records"]
check("替换后仍为每任务一条且 b 已执行",
      len(recs) == 2 and recs[1]["executed"] is True and recs[1]["reason"] is None, recs)

print("9. API：不存在场景 404；删除场景级联清理执行记录")
r = client.get("/api/scenarios/999999/execution")
check("GET 不存在 404", r.status_code == 404)
r = client.put("/api/scenarios/999999/execution", json={"records": []})
check("PUT 不存在 404", r.status_code == 404)

r = client.delete(f"/api/scenarios/{sid}")
check("删除场景成功", r.status_code == 200)
r = client.get(f"/api/scenarios/{sid}/execution")
check("级联 404", r.status_code == 404)
import sqlite3
conn = sqlite3.connect(str(main.DB_PATH))
n = conn.execute("SELECT COUNT(*) FROM execution_records WHERE scenario_id = ?", (sid,)).fetchone()[0]
conn.close()
check("数据库无孤儿执行记录", n == 0, n)

print("10. 导出 JSON 附带 execution 字段")
r = client.post("/api/scenarios", json={"name": "导出场景", "data": scenario_state})
sid2 = r.json()["id"]
client.put(f"/api/scenarios/{sid2}/execution", json=good)
r = client.post("/api/export", json={
    **{
        "window_start": scenario_state["windowStart"],
        "window_end": scenario_state["windowEnd"],
        "resources": {"DBA": 1},
        "nodes": [{"id": "a", "name": "任务A", "duration_minutes": 30, "resources": {}},
                  {"id": "b", "name": "任务B", "duration_minutes": 20, "resources": {}}],
        "edges": [], "blackouts": [],
    },
    "__execution__": {"scenario_id": sid2, "records": [
        {"node_id": "a", "executed": True, "actual_start": T0, "actual_end": T1, "reason": None},
        {"node_id": "b", "executed": False, "actual_start": None, "actual_end": None,
         "reason": "DBA 通宵不可用"},
    ]},
})
check("导出 200", r.status_code == 200, r.text[:200])
import json
exported = json.loads(r.content)
check("导出含 execution.records",
      exported.get("execution", {}).get("records", [])[1]["reason"] == "DBA 通宵不可用")

print(f"\n全部 {passed} 项检查通过 ✔")
