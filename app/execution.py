"""已保存维护场景的实际执行记录：校验与规整（纯函数，无 I/O）。

业务规则：
- 每个计划任务（按 node id）**恰好一条**记录：不缺、不重、不允许引用场景外任务；
- 标记为「已执行」：actual_start / actual_end 均必填、可解析，且结束不得早于开始；
- 标记为「未执行」：reason 必填（非空白）。

任意一条不满足都抛出 :class:`RecordValidationError`（携带**全部**错误），
由 API 层整次拒绝保存，不写入任何部分数据。
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

MAX_REASON_LEN = 500


class RecordValidationError(Exception):
    """聚合所有记录的校验错误；errors: [{node_id, message}]。"""

    def __init__(self, errors: list[dict[str, str]]):
        self.errors = errors
        super().__init__("；".join(e["message"] for e in errors))


def parse_dt(value: Any, field: str) -> datetime:
    """解析 naive ISO 时间（与 scheduler 一致，忽略时区）。"""
    text = str(value).strip() if value is not None else ""
    if not text:
        raise ValueError(f"{field}不能为空")
    if text.endswith(("Z", "z")):
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


def validate_and_normalize(
    node_ids: list[str], raw_records: Any
) -> list[dict[str, Any]]:
    """校验整批执行记录并按场景任务顺序输出规整结果。

    成功返回（顺序与 ``node_ids`` 一致）::

        [{"node_id": "a", "executed": True,
          "actual_start": "2026-09-23T22:05", "actual_end": "2026-09-23T22:40",
          "reason": None},
         {"node_id": "b", "executed": False,
          "actual_start": None, "actual_end": None, "reason": "窗口取消"}]

    失败抛出 :class:`RecordValidationError`。
    """
    if not isinstance(raw_records, list):
        raise RecordValidationError(
            [{"node_id": "", "message": "records 必须是数组"}]
        )

    ordered_ids = [str(nid) for nid in node_ids]
    id_set = set(ordered_ids)

    errors: list[dict[str, str]] = []
    # 先做结构性校验（id 缺失/无效/重复），通过的再做内容校验
    accepted: dict[str, dict[str, Any]] = {}
    structurally_seen: set[str] = set()
    valid_seen: set[str] = set()

    for idx, raw in enumerate(raw_records):
        if not isinstance(raw, dict):
            errors.append({"node_id": "", "message": f"第 {idx + 1} 条记录不是对象"})
            continue
        nid = str(raw.get("node_id") or "").strip()
        if not nid:
            errors.append({"node_id": "", "message": f"第 {idx + 1} 条记录缺少任务 id"})
            continue
        if nid not in id_set:
            errors.append({"node_id": nid, "message": f"任务 {nid} 不属于该场景，引用无效"})
            continue
        if nid in structurally_seen:
            errors.append(
                {"node_id": nid, "message": f"任务 {nid} 出现了多条记录（每个任务恰好一条）"}
            )
            continue
        structurally_seen.add(nid)

        executed = raw.get("executed")
        if not isinstance(executed, bool):
            errors.append({
                "node_id": nid,
                "message": f"任务 {nid} 缺少有效的执行状态（executed 必须为 true 或 false）",
            })
            continue

        if executed:
            start = end = None
            try:
                start = parse_dt(raw.get("actual_start"), f"任务 {nid} 的实际开始时间")
            except ValueError as exc:
                errors.append({"node_id": nid, "message": str(exc)})
            try:
                end = parse_dt(raw.get("actual_end"), f"任务 {nid} 的实际结束时间")
            except ValueError as exc:
                errors.append({"node_id": nid, "message": str(exc)})
            if start is not None and end is not None:
                if end < start:
                    errors.append({
                        "node_id": nid,
                        "message": f"任务 {nid} 的实际结束时间不能早于实际开始时间",
                    })
                else:
                    valid_seen.add(nid)
                    accepted[nid] = {
                        "node_id": nid,
                        "executed": True,
                        "actual_start": _iso(start),
                        "actual_end": _iso(end),
                        "reason": None,
                    }
        else:
            reason = str(raw.get("reason") or "").strip()
            if not reason:
                errors.append({
                    "node_id": nid,
                    "message": f"任务 {nid} 已标记为未执行，必须填写未执行原因",
                })
            elif len(reason) > MAX_REASON_LEN:
                errors.append({
                    "node_id": nid,
                    "message": f"任务 {nid} 的未执行原因不能超过 {MAX_REASON_LEN} 字",
                })
            else:
                valid_seen.add(nid)
                accepted[nid] = {
                    "node_id": nid,
                    "executed": False,
                    "actual_start": None,
                    "actual_end": None,
                    "reason": reason,
                }

    missing = [nid for nid in ordered_ids if nid not in valid_seen]
    if missing:
        errors.append({
            "node_id": "",
            "message": "以下任务缺少执行记录（每个任务恰好一条）：" + "、".join(missing),
        })

    if errors:
        raise RecordValidationError(errors)

    return [accepted[nid] for nid in ordered_ids]
