"""请求模型（场景存储、排程接口、场景模板）。"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ScenarioIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    data: dict[str, Any]


class TemplateIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    data: dict[str, Any]


class TemplatePreviewIn(BaseModel):
    data: dict[str, Any]
    params: dict[str, Any] = Field(default_factory=dict)


class TemplateInstantiateIn(BaseModel):
    """从模板实例化为独立场景。

    template_id 与 data 二选一：给 id 时从库中读取模板，否则用请求体内联模板。
    """
    template_id: int | None = None
    data: dict[str, Any] | None = None
    params: dict[str, Any] = Field(default_factory=dict)
    name: str = Field(min_length=1, max_length=200)


class ExecutionRecordIn(BaseModel):
    """单个任务的实际执行记录：已执行（实际开始/结束）或未执行（原因）。"""
    node_id: str = Field(min_length=1, max_length=200)
    executed: bool
    actual_start: str | None = None
    actual_end: str | None = None
    reason: str | None = Field(default=None, max_length=500)


class ExecutionRecordsIn(BaseModel):
    """一次提交整场景全部任务的执行记录（每任务恰好一条）。"""
    records: list[ExecutionRecordIn]
