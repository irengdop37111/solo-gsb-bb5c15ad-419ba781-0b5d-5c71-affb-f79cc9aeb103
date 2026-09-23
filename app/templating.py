"""场景模板引擎：变量表达式解析、依赖排序、循环引用 / 时间越界校验。

模板（template）与普通场景的差别仅在于字段可以写成表达式：

- ``{{base_date}}`` / ``{{base_date @ 22:00 + 2h}}`` —— 基准日期（date 类型变量）；
- ``{{upgrade_dur}}m`` / ``{{gap}}m + 15m``          —— 分钟数（duration / offset 变量）；
- ``{{end(a) + 30m}}`` / ``{{start(a) - 15m}}``      —— 前置任务结束 / 开始时间偏移。

不含 ``{{ }}`` 的字段按字面量处理，因此普通场景天然就是"无变量模板"。

解析结果是一个完全具体的场景（与 ``scheduler.solve`` 输入同构），随后交给现有排程器。
"""
from __future__ import annotations

import re
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any

# ---------------------------------------------------------------------------
# 问题码
# ---------------------------------------------------------------------------
# error（结构 / 数据问题，无法生成具体场景）
ERR_PARSE = "expression_error"        # 表达式语法错误
ERR_UNKNOWN_VAR = "unknown_variable"  # 引用了未定义变量
ERR_UNKNOWN_NODE = "unknown_node"     # end(x)/start(x) 引用了不存在的任务
ERR_TYPE = "type_error"               # 日期值用在分钟字段等
ERR_PARAM = "param_error"             # 用户参数缺失 / 类型不对
ERR_CYCLE = "variable_cycle"          # 变量锚点构成循环引用
ERR_ANCHOR = "anchor_unresolved"      # 前置任务没有固定开始时间，end()/start() 无法解析
ERR_DATETIME = "datetime_error"       # 字段无法解析为时间 / 分钟
# warning（具体场景已生成，但交给排程器前需要提示）
WARN_WINDOW = "out_of_window"         # 固定任务越出维护窗口
WARN_BLACKOUT = "out_of_window_blackout"  # 禁排期落在窗口外

HARD_ERRORS = {
    ERR_PARSE, ERR_UNKNOWN_VAR, ERR_UNKNOWN_NODE, ERR_TYPE, ERR_PARAM,
    ERR_CYCLE, ERR_ANCHOR, ERR_DATETIME,
}

_TOKEN_RE = re.compile(
    r"""
      \s*(?:
        (?P<clock>@\s*\d{1,2}:\d{2})
      | (?P<numunit>\d+(?:\.\d+)?[dhm])
      | (?P<num>\d+(?:\.\d+)?)
      | (?P<name>[A-Za-z_一-鿿][A-Za-z0-9_一-鿿]*)
      | (?P<op>[+\-*/()])
      )
    """,
    re.VERBOSE,
)
_EXPR_RE = re.compile(r"^\s*\{\{(.*)\}\}\s*$", re.S)
_VAR_NAME_RE = re.compile(r"^[A-Za-z_一-鿿][A-Za-z0-9_一-鿿]*$")
_TIME_FIELD_LABELS = {
    "window_start": "窗口开始时间",
    "window_end": "窗口结束时间",
    "fixed_start": "固定开始时间",
    "blackout_start": "禁排期开始时间",
    "blackout_end": "禁排期结束时间",
}


class TemplateError(ValueError):
    """模板结构本身不合法（区别于参数 / 解析问题）。"""


# ---------------------------------------------------------------------------
# 表达式 AST
# 原子: ("date", name) ("numvar", name) ("lit_dt", dt) ("lit_num", n, "m")
#       ("anchor", kind, node)
# 组合: ("add", lhs, rhs, sign)  ("mul", lhs, rhs, op)  ("clock", lhs, hm)
# ---------------------------------------------------------------------------

class _Parser:
    """极简 tokenizer + 递归下降：expr := term ((+|-) term)* ; term := factor ((*|/) factor)*"""

    def __init__(self, text: str):
        self.tokens: list[tuple[str, str]] = []
        pos = 0
        for m in _TOKEN_RE.finditer(text):
            if m.start() != pos:
                raise TemplateError(f"无法解析的字符：{text[pos:m.start()].strip()!r}")
            pos = m.end()
            if m.group("numunit") is not None:
                raw = m.group("numunit")
                self.tokens.append(("num", raw[:-1]))
                self.tokens.append(("unit", raw[-1]))
                continue
            for g in ("clock", "num", "name", "op"):
                if m.group(g) is not None:
                    self.tokens.append((g, m.group(g).replace(" ", "")))
                    break
        if pos != len(text):
            raise TemplateError(f"无法解析的字符：{text[pos:].strip()!r}")
        self.i = 0

    def peek(self) -> tuple[str, str] | None:
        return self.tokens[self.i] if self.i < len(self.tokens) else None

    def next(self) -> tuple[str, str] | None:
        tok = self.peek()
        if tok:
            self.i += 1
        return tok

    def parse(self) -> tuple:
        if not self.tokens:
            raise TemplateError("空表达式")
        node = self.parse_expr()
        # @HH:MM 可出现在表达式末尾，作用于整个时间表达式
        if self.peek() and self.peek()[0] == "clock":
            _, hm = self.next()  # type: ignore[misc]
            node = ("clock", node, hm[1:])
        if self.i != len(self.tokens):
            raise TemplateError(f"表达式尾部存在多余符号：{self.tokens[self.i][1]!r}")
        return node

    def parse_expr(self) -> tuple:
        node = self.parse_term()
        while self.peek() and self.peek()[0] == "op" and self.peek()[1] in "+-":
            _, op = self.next()  # type: ignore[misc]
            rhs = self.parse_term()
            node = ("add", node, rhs, 1 if op == "+" else -1)
        return node

    def parse_term(self) -> tuple:
        node = self.parse_factor()
        while self.peek() and self.peek()[0] == "op" and self.peek()[1] in "*/":
            _, op = self.next()  # type: ignore[misc]
            rhs = self.parse_factor()
            node = ("mul", node, rhs, op)
        return node

    def parse_factor(self) -> tuple:
        tok = self.next()
        if tok is None:
            raise TemplateError("表达式不完整")
        kind, raw = tok

        if kind == "op" and raw == "(":
            node = self.parse_expr()
            close = self.next()
            if not close or close != ("op", ")"):
                raise TemplateError("缺少右括号 )")
        elif kind == "num":
            unit = self.next()
            if unit and unit[0] == "unit":
                node = ("lit_num", float(raw), unit[1])
            else:
                if unit:
                    self.i -= 1
                node = ("lit_num", float(raw), None)
        elif kind == "clock":
            # @HH:MM 只能出现在表达式起始（或括号首），作用于整棵左树
            node = ("clock", None, raw[1:])
        elif kind == "name":
            if raw in ("end", "start"):
                paren = self.next()
                if not paren or paren != ("op", "("):
                    raise TemplateError(f"{raw}(…) 需要括号，如 {raw}(任务id)")
                inner = self.next()
                if not inner or inner[0] != "name":
                    raise TemplateError(f"{raw}(…) 内必须是任务 id")
                target = inner[1]
                close = self.next()
                if not close or close != ("op", ")"):
                    raise TemplateError(f"{raw}(…) 缺少右括号")
                node = ("anchor", raw, target)
            else:
                # 裸标识符：类型在求值期按上下文推断（date / numvar）
                node = ("name", raw)
                # 变量本身以分钟计：允许可选的 m（如 guard m），h/d 无意义
                if self.peek() and self.peek()[0] == "unit":
                    _, unit = self.next()  # type: ignore[misc]
                    if unit != "m":
                        raise TemplateError(
                            f"变量 {raw} 本身已是分钟数，不能再乘单位 {unit}（可写 {raw} 或 {raw} m）"
                        )
        else:
            raise TemplateError(f"意外的符号：{raw!r}")

        return node


def parse_expression(text: str) -> tuple:
    """解析 ``{{ ... }}`` 内的表达式文本为 AST。"""
    return _Parser(text).parse()


# ---------------------------------------------------------------------------
# AST 工具：变量 / 锚点依赖
# ---------------------------------------------------------------------------

def _walk(node: tuple):
    yield node
    for child in node[1:]:
        if isinstance(child, tuple):
            yield from _walk(child)
        # ("clock", lhs, hm) 中 lhs 可能为 None
    if node[0] == "clock" and node[1] is not None:
        pass


def ast_variables(node: tuple) -> set[str]:
    return {n[1] for n in _walk(node) if n[0] == "name"}


def ast_anchors(node: tuple) -> set[tuple[str, str]]:
    return {(n[1], n[2]) for n in _walk(node) if n[0] == "anchor"}


# ---------------------------------------------------------------------------
# 模板规整
# ---------------------------------------------------------------------------

_VALID_VAR_TYPES = {"date", "duration", "offset"}


def _normalize_variables(raw_vars: Any) -> dict[str, dict[str, Any]]:
    if raw_vars is None:
        return {}
    if not isinstance(raw_vars, list):
        raise TemplateError("variables 必须是数组")
    variables: dict[str, dict[str, Any]] = {}
    for raw in raw_vars:
        if not isinstance(raw, dict):
            raise TemplateError("变量定义必须是对象")
        name = str(raw.get("name", "")).strip()
        if not name:
            raise TemplateError("存在缺少 name 的变量")
        if not _VAR_NAME_RE.match(name):
            raise TemplateError(f"变量名不合法（需字母/下划线/中文开头）：{name}")
        if name in ("end", "start"):
            raise TemplateError(f"变量名不能使用保留字：{name}")
        if name in variables:
            raise TemplateError(f"变量名重复：{name}")
        vtype = str(raw.get("type", "duration")).strip()
        if vtype not in _VALID_VAR_TYPES:
            raise TemplateError(f"变量 {name} 的 type 必须是 date / duration / offset")
        default = raw.get("default")
        if vtype == "date":
            if default in (None, ""):
                default_val = None
            else:
                try:
                    default_val = _coerce_date(default)
                except ValueError:
                    raise TemplateError(f"变量 {name} 的默认日期无效：{default}")
        else:
            if default in (None, ""):
                default_val = None
            else:
                try:
                    default_val = int(float(default))
                except (TypeError, ValueError):
                    raise TemplateError(f"变量 {name} 的默认值必须是分钟整数")
                if default_val < 0:
                    # 负数默认无意义：忽略为"未设置"，留待参数阶段必填校验
                    default_val = None
        variables[name] = {
            "name": name,
            "type": vtype,
            "label": str(raw.get("label") or name),
            "default": default_val,
        }
    return variables


def _coerce_date(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value.replace(tzinfo=None) if value.tzinfo else value
    text = str(value).strip()
    if not text:
        raise ValueError("空日期")
    if text.endswith("Z"):
        text = text[:-1]
    # 仅 YYYY-MM-DD 时补零点
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return datetime.strptime(text, "%Y-%m-%d")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        raise ValueError(f"日期格式无效：{text}")
    return dt.replace(tzinfo=None) if dt.tzinfo else dt


def _parse_clock(hm: str) -> tuple[int, int]:
    h, m = hm.split(":")
    hi, mi = int(h), int(m)
    if not (0 <= hi <= 23 and 0 <= mi <= 59):
        raise TemplateError(f"时钟时间越界：@{hm}")
    return hi, mi


def _extract_expr(value: Any) -> tuple[Any, bool]:
    """返回 (表达式文本或原值, 是否为表达式)。"""
    if not isinstance(value, str):
        return value, False
    m = _EXPR_RE.match(value)
    if m:
        return m.group(1), True
    return value, False


def normalize_template(payload: dict[str, Any]) -> dict[str, Any]:
    """校验模板结构并预解析所有表达式 AST；结构错误抛 TemplateError。"""
    if not isinstance(payload, dict):
        raise TemplateError("模板必须是 JSON 对象")
    variables = _normalize_variables(payload.get("variables"))

    scen = payload.get("scenario")
    if scen is None:
        # 兼容直接把场景字段平铺在模板根对象
        scen = payload
    if not isinstance(scen, dict):
        raise TemplateError("scenario 必须是对象")

    raw_nodes = scen.get("nodes", [])
    if not isinstance(raw_nodes, list):
        raise TemplateError("nodes 必须是数组")

    nodes: dict[str, dict[str, Any]] = {}
    for raw in raw_nodes:
        nid = str(raw.get("id", "")).strip()
        if not nid:
            raise TemplateError("存在缺少 id 的维护项")
        if nid in nodes:
            raise TemplateError(f"维护项 id 重复：{nid}")
        duration_raw = raw.get("duration_minutes")
        duration_ast = None
        if isinstance(duration_raw, str) and _EXPR_RE.match(duration_raw):
            duration_ast = parse_expression(_EXPR_RE.match(duration_raw).group(1))
        fixed_raw = raw.get("fixed_start")
        fixed_ast = None
        if isinstance(fixed_raw, str) and _EXPR_RE.match(fixed_raw):
            fixed_ast = parse_expression(_EXPR_RE.match(fixed_raw).group(1))

        raw_res = raw.get("resources") or {}
        if not isinstance(raw_res, dict):
            raise TemplateError(f"维护项 {nid} 的 resources 必须是对象")
        resources: dict[str, float] = {}
        for rname, amount in raw_res.items():
            try:
                amount = float(amount)
            except (TypeError, ValueError):
                raise TemplateError(f"维护项 {nid} 的资源 {rname} 占用必须是数字")
            if amount < 0:
                raise TemplateError(f"维护项 {nid} 的资源 {rname} 占用不能为负")
            if amount > 0:
                resources[str(rname)] = amount

        nodes[nid] = {
            "id": nid,
            "name": str(raw.get("name") or nid),
            "duration_raw": duration_raw,
            "duration_ast": duration_ast,
            "fixed_raw": fixed_raw,
            "fixed_ast": fixed_ast,
            "resources": resources,
        }

    window_asts = {}
    for key in ("window_start", "window_end"):
        raw = scen.get(key)
        if isinstance(raw, str) and _EXPR_RE.match(raw):
            window_asts[key] = parse_expression(_EXPR_RE.match(raw).group(1))

    blackouts = []
    for idx, raw in enumerate(scen.get("blackouts", []) or []):
        item = {"name": str(raw.get("name") or f"禁排期{idx + 1}"), "asts": {}, "raw": {}}
        for key, label in (("start", "blackout_start"), ("end", "blackout_end")):
            v = raw.get(key)
            if isinstance(v, str) and _EXPR_RE.match(v):
                item["asts"][key] = parse_expression(_EXPR_RE.match(v).group(1))
            item["raw"][key] = v
        blackouts.append(item)

    edges = []
    seen = set()
    for raw in scen.get("edges", []) or []:
        s, t = str(raw.get("source", "")).strip(), str(raw.get("target", "")).strip()
        if not s or not t:
            raise TemplateError("依赖边必须同时包含 source 和 target")
        if (s, t) not in seen:
            seen.add((s, t))
            edges.append((s, t))

    resources = scen.get("resources") or {}
    if not isinstance(resources, dict):
        raise TemplateError("resources 必须是对象")

    return {
        "name": str(payload.get("name") or scen.get("name") or ""),
        "variables": variables,
        "window_raw": {k: scen.get(k) for k in ("window_start", "window_end")},
        "window_asts": window_asts,
        "resources": resources,
        "nodes": nodes,
        "edges": edges,
        "blackouts": blackouts,
    }


# ---------------------------------------------------------------------------
# 求值
# ---------------------------------------------------------------------------

def _unit_minutes(unit: str | None, number: float) -> float:
    if unit is None:
        return number
    if unit == "m":
        return number
    if unit == "h":
        return number * 60
    return number * 1440  # d


class _Resolver:
    def __init__(self, tpl: dict[str, Any], params: dict[str, Any]):
        self.tpl = tpl
        self.variables = tpl["variables"]
        self.params = params
        self.issues: list[dict[str, Any]] = []
        # 已求值结果
        self.var_values: dict[str, datetime | int | None] = {}
        self.durations: dict[str, int] = {}
        self.fixed: dict[str, datetime] = {}
        self.starts: dict[str, datetime] = {}
        self.ends: dict[str, datetime] = {}

    def issue(self, severity: str, code: str, message: str, **extra: Any) -> None:
        item = {"severity": severity, "code": code, "message": message}
        item.update(extra)
        self.issues.append(item)

    # -- 参数 ---------------------------------------------------------------

    def prepare_params(self) -> dict[str, Any]:
        applied: dict[str, Any] = {}
        for name, spec in self.variables.items():
            if name in self.params and self.params[name] not in (None, ""):
                raw = self.params[name]
            elif spec["default"] is not None:
                raw = spec["default"]
            else:
                self.issue("error", ERR_PARAM, f"缺少必填参数：{spec['label']}（变量 {name}）",
                           variable=name)
                continue
            try:
                if spec["type"] == "date":
                    val: Any = _coerce_date(raw)
                else:
                    val = int(round(float(raw)))
                    if val < 0:
                        raise ValueError("分钟数不能为负")
            except (TypeError, ValueError) as exc:
                self.issue("error", ERR_PARAM,
                           f"参数 {spec['label']}（{name}）无效：{exc}", variable=name)
                continue
            self.var_values[name] = val
            applied[name] = (
                val.strftime("%Y-%m-%dT%H:%M") if isinstance(val, datetime) else val
            )
        return applied

    # -- 原子表达式引用检查 --------------------------------------------------

    def check_refs(self) -> None:
        def check_node(node: tuple, field: str) -> None:
            for n in _walk(node):
                if n[0] == "name":
                    if n[1] not in self.variables:
                        self.issue("error", ERR_UNKNOWN_VAR,
                                   f"{field} 引用了未定义的变量：{n[1]}", variable=n[1], field=field)
                elif n[0] == "anchor" and n[2] not in self.tpl["nodes"]:
                    self.issue("error", ERR_UNKNOWN_NODE,
                               f"{field} 中的 {n[1]}({n[2]}) 引用了不存在的任务",
                               node=n[2], field=field)

        for nid, n in self.tpl["nodes"].items():
            label = f"任务「{n['name']}」"
            if n["duration_ast"]:
                check_node(n["duration_ast"], f"{label}时长")
            if n["fixed_ast"]:
                check_node(n["fixed_ast"], f"{label}固定开始时间")
        for key, ast in self.tpl["window_asts"].items():
            check_node(ast, _TIME_FIELD_LABELS[key])
        for b in self.tpl["blackouts"]:
            for key, ast in b["asts"].items():
                check_node(ast, f"禁排期「{b['name']}」{ '开始' if key == 'start' else '结束'}时间")

    def _anchor_time(self, kind: str, target: str) -> datetime | None:
        table = self.ends if kind == "end" else self.starts
        return table.get(target)

    # -- 求值 ---------------------------------------------------------------

    def eval_number(self, node: tuple, field: str) -> int | None:
        """在"分钟数"上下文中求值，必须得到非负整数。"""
        try:
            val = self._num(node, field)
        except _EvalError as exc:
            self.issue("error", exc.code, f"{field}：{exc.message}", field=field,
                       **exc.extra)
            return None
        if val is None:
            return None
        if abs(val - round(val)) > 1e-9:
            self.issue("error", ERR_TYPE, f"{field} 的结果必须是整数分钟（得到 {val}）", field=field)
            return None
        ival = int(round(val))
        if ival < 0:
            self.issue("error", ERR_TYPE, f"{field} 不能为负（得到 {ival}）", field=field)
            return None
        return ival

    def _num(self, node: tuple, field: str) -> float | None:
        tag = node[0]
        if tag == "lit_num":
            return _unit_minutes(node[2], node[1])
        if tag == "name":
            spec = self.variables.get(node[1])
            if spec and spec["type"] == "date":
                raise _EvalError(ERR_TYPE, f"日期变量 {node[1]} 不能用在分钟字段",
                                 variable=node[1])
            val = self.var_values.get(node[1])
            return None if val is None else float(val)  # type: ignore[arg-type]
        if tag == "anchor":
            raise _EvalError(ERR_TYPE, f"{node[1]}({node[2]}) 是时间值，不能用在分钟字段")
        if tag == "clock":
            raise _EvalError(ERR_PARSE, "@HH:MM 只能用于时间表达式")
        if tag == "add":
            a, b = self._num(node[1], field), self._num(node[2], field)
            if a is None or b is None:
                return None
            return a + node[3] * b
        if tag == "mul":
            a, b = self._num(node[1], field), self._num(node[2], field)
            if a is None or b is None:
                return None
            if node[3] == "*":
                return a * b
            if b == 0:
                raise _EvalError(ERR_TYPE, "除数为 0")
            return a / b
        raise _EvalError(ERR_PARSE, f"不支持的表达式节点：{tag}")

    def eval_datetime(self, node: tuple, field: str) -> datetime | None:
        """在"日期时间"上下文中求值。"""
        try:
            val = self._dt(node, field)
        except _EvalError as exc:
            self.issue("error", exc.code, f"{field}：{exc.message}", field=field,
                       **exc.extra)
            return None
        except TemplateError as exc:
            self.issue("error", ERR_PARSE, f"{field}：{exc}", field=field)
            return None
        return val

    def _dt(self, node: tuple, field: str) -> datetime | None:
        tag = node[0]
        if tag == "lit_num":
            raise _EvalError(ERR_TYPE, "分钟数不能直接用作日期时间，请先与基准日期相加")
        if tag == "name":
            spec = self.variables.get(node[1])
            if spec and spec["type"] != "date":
                raise _EvalError(ERR_TYPE,
                                 f"变量 {node[1]} 是{spec['type']}类型（分钟数），"
                                 f"不能单独作为时间；可写 {{{{ {node[1]} @ 00:00 }}}} 或与基准日期相加",
                                 variable=node[1])
            val = self.var_values.get(node[1])
            return val if isinstance(val, datetime) else None  # type: ignore[return-value]
        if tag == "anchor":
            t = self._anchor_time(node[1], node[2])
            if t is None:
                raise _EvalError(ERR_ANCHOR,
                                 f"任务 {node[2]} 没有可解析的固定开始时间，"
                                 f"无法计算 {node[1]}({node[2]})；请确保其前置链上的任务均为固定开始",
                                 node=node[2], anchor=node[1])
            return t
        if tag == "clock":
            h, m = _parse_clock(node[2])
            if node[1] is None:
                raise _EvalError(ERR_PARSE, "@HH:MM 需要指定基准日期，如 base_date @ 22:00")
            base = self._dt(node[1], field)
            if base is None:
                return None
            return base.replace(hour=h, minute=m, second=0, microsecond=0)
        if tag == "add":
            kind = self._add_kind(node)
            if kind == "time":
                base = self._dt(node[1], field)
                mins = self._num(node[2], field)
                if base is None or mins is None:
                    return None
                return base + timedelta(minutes=node[3] * mins)
            # 两个时间值相加减没有意义
            raise _EvalError(ERR_TYPE, "两个日期时间不能直接相加；时间偏移量必须是分钟数（如 30m）")
        if tag == "mul":
            raise _EvalError(ERR_TYPE, "日期时间不能做乘除")
        raise _EvalError(ERR_PARSE, f"不支持的表达式节点：{tag}")

    def _add_kind(self, node: tuple) -> str:
        """判断 add 节点是否为「时间 ± 分钟数」。左值决定类型。"""
        left = node[1]
        if left[0] in ("anchor", "clock"):
            return "time"
        if left[0] == "lit_num":
            return "num"
        if left[0] == "name":
            spec = self.variables.get(left[1])
            return "time" if spec and spec["type"] == "date" else "num"
        if left[0] == "add":
            return self._add_kind(left)
        return "num"


class _EvalError(Exception):
    def __init__(self, code: str, message: str, **extra: Any):
        super().__init__(message)
        self.code = code
        self.message = message
        self.extra = extra


# ---------------------------------------------------------------------------
# 循环引用检测（变量锚点图）
# ---------------------------------------------------------------------------

def find_anchor_cycles(tpl: dict[str, Any]) -> list[list[str]]:
    """检测固定开始时间表达式中 end()/start() 构成的环。

    边含义：节点 v 的固定时间依赖锚点节点 u → 边 u → v；v 在 u 之后才能确定。
    """
    adj: dict[str, set[str]] = {nid: set() for nid in tpl["nodes"]}
    for nid, n in tpl["nodes"].items():
        if not n["fixed_ast"]:
            continue
        for kind, target in ast_anchors(n["fixed_ast"]):
            if target in adj:
                adj[target].add(nid)

    # Tarjan SCC（迭代版，与 scheduler.find_cycles 同思路）
    index_of: dict[str, int] = {}
    low: dict[str, int] = {}
    stack: list[str] = []
    on_stack: set[str] = set()
    counter = 0
    sccs: list[list[str]] = []

    def strongconnect(root: str) -> None:
        nonlocal counter
        work: list[tuple[str, int]] = [(root, 0)]
        index_of[root] = low[root] = counter
        counter += 1
        stack.append(root)
        on_stack.add(root)
        while work:
            v, pi = work[-1]
            neigh = sorted(adj[v])
            if pi < len(neigh):
                w = neigh[pi]
                work[-1] = (v, pi + 1)
                if w not in index_of:
                    index_of[w] = low[w] = counter
                    counter += 1
                    stack.append(w)
                    on_stack.add(w)
                    work.append((w, 0))
                elif w in on_stack:
                    low[v] = min(low[v], index_of[w])
            else:
                work.pop()
                if low[v] == index_of[v]:
                    comp: list[str] = []
                    while True:
                        w = stack.pop()
                        on_stack.discard(w)
                        comp.append(w)
                        if w == v:
                            break
                    sccs.append(comp)
                if work:
                    p = work[-1][0]
                    low[p] = min(low[p], low[v])

    for nid in tpl["nodes"]:
        if nid not in index_of:
            strongconnect(nid)

    cycles: list[list[str]] = []
    for comp in sccs:
        if len(comp) == 1:
            v = comp[0]
            if v in adj[v]:
                cycles.append([v])
            continue
        comp_set = set(comp)
        start = sorted(comp)[0]
        path = [start]
        visited = {start}
        cur = start
        while True:
            nxt = next((w for w in sorted(adj[cur]) if w in comp_set and w not in visited), None)
            if nxt is None:
                break
            path.append(nxt)
            visited.add(nxt)
            cur = nxt
            if start in adj[cur]:
                break
        cycles.append(path)
    return cycles


# ---------------------------------------------------------------------------
# 字面量回退解析
# ---------------------------------------------------------------------------

def _literal_datetime(value: Any, field: str) -> datetime:
    if isinstance(value, datetime):
        return value.replace(tzinfo=None) if value.tzinfo else value
    text = str(value).strip() if value is not None else ""
    if not text:
        raise ValueError(f"缺少必填的{field}")
    if text.endswith("Z"):
        text = text[:-1]
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        raise ValueError(f"{field}格式无效：{text}")
    return dt.replace(tzinfo=None) if dt.tzinfo else dt


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M")


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------

def resolve(payload: dict[str, Any], params: dict[str, Any] | None = None) -> dict[str, Any]:
    """解析模板 → 具体场景。返回 scenario / resolved / issues / params。

    - 结构错误抛 TemplateError（HTTP 422）；
    - 参数 / 循环 / 越界等问题收集在 issues 中；
      存在 error 时 scenario 为 None，warning 时 scenario 仍可交给排程器。
    """
    tpl = normalize_template(payload)
    resolver = _Resolver(tpl, params or {})

    applied = resolver.prepare_params()
    resolver.check_refs()

    # 时长解析（不依赖任何时间锚点）
    for nid, n in tpl["nodes"].items():
        if n["duration_ast"] is not None:
            val = resolver.eval_number(n["duration_ast"], f"任务「{n['name']}」时长")
            if val is not None and val > 0:
                resolver.durations[nid] = val
            elif val == 0:
                resolver.issue("error", ERR_TYPE,
                               f"任务「{n['name']}」时长必须大于 0", node=nid)
        else:
            try:
                dv = int(float(n["duration_raw"]))
                if dv <= 0:
                    raise ValueError
                resolver.durations[nid] = dv
            except (TypeError, ValueError):
                resolver.issue("error", ERR_DATETIME,
                               f"任务「{n['name']}」时长必须是正整数分钟", node=nid)

    # 循环引用（固定时间锚点）
    cycles = find_anchor_cycles(tpl)
    for cyc in cycles:
        resolver.issue(
            "error", ERR_CYCLE,
            "固定开始时间的前置偏移构成循环引用：" + " → ".join(
                tpl["nodes"][c]["name"] for c in cyc + [cyc[0]]),
            chain=cyc,
            nodes=cyc,
        )

    # 窗口解析
    window: dict[str, datetime] = {}
    for key in ("window_start", "window_end"):
        raw = tpl["window_raw"][key]
        ast = tpl["window_asts"].get(key)
        label = _TIME_FIELD_LABELS[key]
        val = resolver.eval_datetime(ast, label) if ast is not None else None
        if ast is None:
            try:
                val = _literal_datetime(raw, label)
            except ValueError as exc:
                resolver.issue("error", ERR_DATETIME, str(exc))
        if val is not None:
            window[key] = val

    # 固定开始时间：按锚点依赖波次推进，直到不动点
    cyclic_nodes = {c for cyc in cycles for c in cyc}
    fixed_pending = {
        nid for nid, n in tpl["nodes"].items()
        if n["fixed_ast"] is not None and nid not in cyclic_nodes
    }
    # 求值失败的节点（其下游锚点错误属于级联噪声，不再重复报告）
    failed_anchor_nodes: set[str] = set()
    # 上游根因：时长解析失败的节点（end() 锚点无法计算）
    duration_failed = {nid for nid in tpl["nodes"] if nid not in resolver.durations}

    while fixed_pending:
        progressed = False
        for nid in sorted(fixed_pending):
            n = tpl["nodes"][nid]
            # 锚点必须全部可解析（且 duration 已知）
            anchors = ast_anchors(n["fixed_ast"])
            ready = True
            blocked_by_failed = False
            for kind, target in anchors:
                if target not in tpl["nodes"]:
                    continue  # 已由 check_refs 报错
                table = resolver.ends if kind == "end" else resolver.starts
                if target not in table:
                    upstream_fixed = tpl["nodes"][target]["fixed_ast"] is not None
                    if (target in failed_anchor_nodes or target in cyclic_nodes
                            or target in duration_failed
                            or (upstream_fixed and kind == "end" and target in resolver.starts)):
                        blocked_by_failed = True
                    ready = False
                    break
            if blocked_by_failed:
                # 上游已报根因，这里静默标记为失败
                fixed_pending.discard(nid)
                failed_anchor_nodes.add(nid)
                progressed = True
                continue
            if not ready:
                continue
            val = resolver.eval_datetime(n["fixed_ast"], f"任务「{n['name']}」固定开始时间")
            if val is None:
                fixed_pending.discard(nid)  # 已产生 issue
                failed_anchor_nodes.add(nid)
                progressed = True
                continue
            resolver.fixed[nid] = resolver.starts[nid] = val
            if nid in resolver.durations:
                resolver.ends[nid] = val + timedelta(minutes=resolver.durations[nid])
            fixed_pending.discard(nid)
            progressed = True
        if not progressed:
            break

    # 剩余无法解析的固定时间 → anchor_unresolved
    for nid in sorted(fixed_pending):
        n = tpl["nodes"][nid]
        anchors = ast_anchors(n["fixed_ast"])
        missing = sorted({
            target for kind, target in anchors
            if target in tpl["nodes"]
            and (target not in resolver.ends if kind == "end" else target not in resolver.starts)
        })
        names = "、".join(tpl["nodes"][m]["name"] for m in missing)
        resolver.issue(
            "error", ERR_ANCHOR,
            f"任务「{n['name']}」的固定开始时间依赖前置任务的结束/开始时间，"
            f"但 {names} 未设置可解析的固定开始时间（弹性任务的时间需由排程器计算，"
            f"不能作为模板变量的锚点）",
            node=nid, nodes=[nid] + missing,
        )

    # 禁排期解析
    blackouts: list[dict[str, Any]] = []
    for b in tpl["blackouts"]:
        parsed: dict[str, datetime] = {}
        ok = True
        for key in ("start", "end"):
            ast = b["asts"].get(key)
            label = f"禁排期「{b['name']}」{'开始' if key == 'start' else '结束'}时间"
            if ast is not None:
                val = resolver.eval_datetime(ast, label)
            else:
                try:
                    val = _literal_datetime(b["raw"][key], label)
                except ValueError as exc:
                    resolver.issue("error", ERR_DATETIME, str(exc))
                    val = None
            if val is None:
                ok = False
            else:
                parsed[key] = val
        if ok:
            blackouts.append({
                "name": b["name"], "start": parsed["start"], "end": parsed["end"],
            })

    has_error = any(i["severity"] == "error" for i in resolver.issues)

    # 时间越界 warning（需要完整窗口）
    if not has_error and "window_start" in window and "window_end" in window:
        ws, we = window["window_start"], window["window_end"]
        if ws >= we:
            resolver.issue("error", ERR_DATETIME,
                           "维护窗口开始时间必须早于结束时间",
                           field="window")
        else:
            for nid in sorted(resolver.fixed):
                start = resolver.fixed[nid]
                end = start + timedelta(minutes=resolver.durations.get(nid, 0))
                if start < ws or end > we:
                    n = tpl["nodes"][nid]
                    resolver.issue(
                        "warning", WARN_WINDOW,
                        f"任务「{n['name']}」固定时段 {start:%m-%d %H:%M} ~ {end:%m-%d %H:%M} "
                        f"越出维护窗口（{ws:%m-%d %H:%M} ~ {we:%m-%d %H:%M}）",
                        node=nid, start=_iso(start), end=_iso(end),
                    )
            for b in blackouts:
                if b["end"] <= ws or b["start"] >= we:
                    resolver.issue(
                        "warning", WARN_BLACKOUT,
                        f"禁排期「{b['name']}」（{b['start']:%m-%d %H:%M} ~ "
                        f"{b['end']:%m-%d %H:%M}）完全在维护窗口之外",
                        blackout=b["name"],
                    )

    has_error = any(i["severity"] == "error" for i in resolver.issues)

    # 组装具体场景
    scenario: dict[str, Any] | None = None
    resolved: dict[str, Any] = {
        "variables": applied,
        "window": (
            {k: _iso(v) for k, v in window.items()}
            if "window_start" in window and "window_end" in window else None
        ),
        "durations": {nid: d for nid, d in resolver.durations.items()},
        "fixed_starts": {nid: _iso(v) for nid, v in sorted(resolver.fixed.items())},
        "anchor_times": {
            nid: {"start": _iso(resolver.starts[nid]),
                  "end": _iso(resolver.ends[nid]) if nid in resolver.ends else None}
            for nid in sorted(set(resolver.starts) | set(resolver.ends))
        },
        "blackouts": [
            {"name": b["name"], "start": _iso(b["start"]), "end": _iso(b["end"])}
            for b in blackouts
        ],
    }

    if not has_error:
        nodes_out = []
        for nid, n in tpl["nodes"].items():
            nodes_out.append({
                "id": nid,
                "name": n["name"],
                "duration_minutes": resolver.durations[nid],
                "resources": n["resources"] if isinstance(n["resources"], dict) else {},
                "fixed_start": _iso(resolver.fixed[nid]) if nid in resolver.fixed else None,
            })
        scenario = {
            "window_start": _iso(window["window_start"]),
            "window_end": _iso(window["window_end"]),
            "resources": {str(k): float(v) for k, v in tpl["resources"].items()},
            "nodes": nodes_out,
            "edges": [{"source": s, "target": t} for s, t in tpl["edges"]],
            "blackouts": [
                {"name": b["name"], "start": _iso(b["start"]), "end": _iso(b["end"])}
                for b in blackouts
            ],
        }

    return {
        "scenario": scenario,
        "resolved": resolved,
        "issues": resolver.issues,
        "params": applied,
    }
