# 维护窗口排程 Web 应用（Maintenance Window Scheduler）

在指定维护窗口内，对带**服务依赖 DAG、维护时长、资源占用、禁排时间段**的一批维护任务自动求解：
计算满足依赖与资源容量约束的**可执行顺序和开始/结束时间**，检测**循环依赖**与**资源重叠**，
给出**可定位的冲突链**；甘特图上可拖动调整窗口并即时重算，支持场景保存/恢复与 JSON 导出。

另提供**场景模板**：可把窗口、资源、任务及依赖保存为**含变量的模板**（基准日期、任务时长、
前置任务结束时间偏移），输入参数后**预览并实例化为独立场景**，系统解析变量依赖、校验循环引用
与时间越界后再交给排程器计算；模板、实例与解析后的参数均可写入 JSON 导出。

**实际执行记录**：对已保存场景，可按任务 ID 逐任务登记维护**实际**开始/结束时间，
或标记**未执行并填写原因**（每任务恰好一条）；保存后逐任务展示相对计划的
**开始偏差**（早/晚多少分钟）、**时长偏差**（提前结束/超时）与**未执行项原因**。
缺时间、结束早于开始、引用无效、缺漏或重复都会**整次拒绝保存**，不产生部分数据。

- 后端：FastAPI + SQLite（标准库 `sqlite3`，零额外 ORM 依赖）
- 前端：原生 HTML / CSS / JavaScript（Canvas 绘制甘特图，无任何前端构建步骤）
- 部署：单镜像 Docker / docker compose 一键启动

---

## 一、快速开始

### 方式 A：docker compose（推荐，一键）

```bash
docker compose up -d --build
```

启动后浏览器访问：

> **http://localhost:8000**

打开页面后：左侧编辑维护窗口/资源/任务/依赖，右侧即时排程；顶栏可保存场景，
保存并恢复后在右侧底部「**📋 实际执行记录**」登记实际执行情况与偏差对比，
顶栏「🧩 场景模板」进入模板工作台。

停止：

```bash
docker compose down            # 保留数据（命名卷 scheduler-data）
docker compose down -v         # 同时删除保存的场景数据
```

### 方式 B：单条 docker 命令

```bash
docker build -t maintenance-scheduler .
docker run -d --name mw \
  -p 8000:8000 \
  -v mw-data:/data \
  maintenance-scheduler
```

### 方式 C：本地直接运行（不使用 Docker）

需要 Python 3.11+：

```bash
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
# 默认 SQLite 数据库：./data/maintenance.db（可用 MW_DATA_DIR 指定目录）
```

> 健康检查：`GET http://localhost:8000/api/health`
> 交互式 API 文档（Swagger）：`http://localhost:8000/docs`

---

## 二、访问端口与配置

| 项 | 默认值 | 说明 / 环境变量 |
| --- | --- | --- |
| Web 访问端口 | `8000` | compose 通过 `APP_PORT` 可改：`APP_PORT=9000 docker compose up -d --build` |
| 数据目录 | `/data` | `MW_DATA_DIR`：SQLite 数据库所在目录（容器内已挂卷持久化） |
| 数据库文件 | `<数据目录>/maintenance.db` | `MW_DB_PATH`：直接指定数据库文件完整路径 |

修改宿主映射端口示例：

```bash
APP_PORT=9000 docker compose up -d --build   # 访问 http://localhost:9000
```

数据持久化：compose 使用命名卷 `scheduler-data` 挂载到容器 `/data`；
如希望数据库落在宿主目录，可把 `docker-compose.yml` 中的卷改为 `./data:/data`。

---

## 三、功能说明

### 1. 数据录入（左侧编辑面板）

- **维护窗口**：整体允许执行维护的开始/结束时间（`datetime-local`，5 分钟粒度）。
- **资源容量**：任意命名的共享资源（如 `DBA`、`网络组`、`应用组`）及容量上限（整数/小数）。
- **维护任务**：名称、时长（分钟）、对每种资源的占用量、可选的**固定开始时间**。
  - 不填固定开始时间 → 任务为**弹性**，由算法在窗口内寻找最早可行时刻；
  - 填写固定开始时间 → 任务**锁定**到该时刻，系统校验它是否越窗、违反依赖/禁排期/资源约束。
- **依赖关系**：`前置 → 后继`，表示前置完成后后继才能开始；多条边构成 DAG。
- **不可维护时间段（禁排期）**：命名时间区间，任何任务都不得与之重叠（如计费批处理窗口）。

页面右上角「**示例**」按钮会载入一个内置夜间窗口示例，便于快速体验。

### 2. 自动排程（右侧结果面板）

- 顶部状态栏：可行性、已排/总数、冲突数、总跨度（makespan）。
- **甘特图（Canvas）**：
  - 蓝色条＝弹性排程，紫色条 🔒＝固定开始时间；红色底纹为禁排期；红色虚线占位＝未排程任务。
  - 条间贝塞尔箭头表示依赖关系，横轴为时间刻度。
- **执行顺序表**：按开始时间排序的执行清单（开始/结束、时长、前置、资源占用）。

**冲突链可定位**：所有告警按类型列出，点击任意一条，甘特图上相关任务会红框高亮、
相关依赖边变红，并在冲突文字中显示链路，例如 `A → B → C`。

检测的冲突类型：

| 类型 | 含义 |
| --- | --- |
| `循环依赖 cycle` | Tarjan SCC 找出所有环，给出环上节点与闭环边（含自环），环上任务全部不排程 |
| `悬空依赖 dangling_edge` | 依赖边引用了已删除/不存在的任务 |
| `无法排程 unschedulable` | 受资源容量、禁排期挤压或窗口长度限制，窗口内放不下 |
| `依赖阻塞 dependency_blocked` | 前置任务未能排程，后继无法确定开始时间（沿依赖链传播） |
| `固定越界 fixed_window` | 固定任务超出维护窗口 |
| `固定冲突 fixed_predecessor` | 固定开始时间早于前置最早完成时间 |
| `禁排冲突 fixed_blackout` | 固定任务与禁排期重叠 |
| `资源冲突 fixed_resource` / `容量超限 fixed_capacity` | 固定时刻资源超容量，或单任务占用超过资源总容量 |

### 3. 拖动调整后即时重算

- 鼠标**拖动甘特条整体移动**：按 5 分钟吸附改变开始时间，任务随即变为"固定"，
  自动触发防抖重算（约 120–180ms），右侧结果即时更新；
- **拖动条右边缘**：调整任务时长后即时重算；
- **双击甘特条**：解除固定，恢复为弹性排程；
- 勾选框「拖动后即时重算」可关闭自动模式，改用「▶ 立即排程」手动触发。

### 4. 场景保存 / 恢复

- 输入场景名称 →「💾 保存场景」：同名场景执行**更新（upsert）**，异名新建。
- 下拉框选择历史场景 →「↺ 恢复」：完整还原窗口、资源、任务、依赖、禁排期并重算。
- 「🗑」删除当前选中场景。所有场景持久化在 SQLite `scenarios` 表。

> 提示：顶栏场景下拉显示名称与最近更新时间；执行记录功能仅在**已保存场景**上可用，
> 编辑器有未保存改动时请先保存场景，以保证「计划时间」与记录引用的任务版本一致。

### 5. 实际执行记录（逐任务偏差对比）

在右侧结果区底部「**📋 实际执行记录**」面板操作（需先恢复一个已保存场景）：

1. 点击「**✍ 登记实际执行**」打开登记表，表中按场景里的每个计划任务（按 ID）生成一行，
   **每任务恰好一条**记录：
   - **已执行**：填写实际开始、实际结束时间（分钟粒度）；
   - **未执行**：把状态切为「未执行」并**必填原因**（如“备用网络未到位、窗口取消”）。
2. 「💾 保存执行记录（整批）」一次性提交全部任务：
   - 已执行项缺少任一时间、时间格式无效、**实际结束早于开始**；
   - 未执行项未填原因；记录**缺漏 / 重复 / 引用了场景外任务**；
   - 以上任一情况都会**整次拒绝保存**，错误框列出全部问题并高亮对应行，
     **不留任何部分数据**（前端先做一遍校验，后端在同一事务中再次校验后才落库）。
3. 保存成功后逐任务展示对比结果：
   - **开始偏差**：实际开始 − 计划开始，正数红色“晚于计划”，负数绿色“早于计划”，0 为准点；
   - **时长偏差**：实际时长（实际结束−实际开始）− 计划时长，正为超时、负为提前结束；
   - **未执行项**：顶部汇总条列出未执行数量与每条原因，表格中整行红色标记；
   - 计划本身未能排程的任务无法比较偏差，会标注“计划未排程”。
4. 再次提交为**整批替换**（以最近一次提交为准）；删除场景时其执行记录一并清理。

执行记录持久化在 SQLite `execution_records` 表（主键 `场景 id + 任务 id`）。

### 6. JSON 导出

「⬇ 导出 JSON」会下载 `maintenance-schedule-<时间戳>.json`（模板实例则为
`maintenance-template-instance-<时间戳>.json`），内容同时包含：

```json
{
  "exported_at": "导出时间(UTC)",
  "scenario": { "…当前编辑场景的完整输入…" },
  "result":   { "feasible": true, "items": [ …排程明细… ], "order": [],
                "unscheduled": [], "conflicts": [], "stats": {}, "window": {} },
  "execution": { "…该场景已保存的实际执行记录（存在时附带）…" },
  "kind": "template_instance",
  "template": { "…模板定义（仅模板实例）…" },
  "params":   { "…实例化时输入的参数（仅模板实例）…" },
  "resolved": { "…解析后的参数、固定时间、锚点时间（仅模板实例）…" }
}
```

### 7. 场景模板（含变量）

点击顶栏「**🧩 场景模板**」打开模板工作台，左右两栏：左边定义模板，右边输入参数 → 预览 → 实例化。

**模板变量（三种类型）**：

| 类型 | 含义 | 取值 |
| --- | --- | --- |
| `date` | **基准日期**，窗口 / 固定开始 / 禁排期围绕它做日期偏移 | 日期或 `datetime-local` |
| `duration` | **任务时长**（分钟），用于任务时长字段 | 非负整数分钟 |
| `offset` | **前置任务结束时间偏移**（分钟），用于固定开始表达式 | 非负整数分钟 |

变量可设置默认值；无默认值的变量在实例化时必填。

**表达式语法**（字段整体写在 `{{ ... }}` 中）：

| 表达式 | 含义 |
| --- | --- |
| `{{base_date @ 22:00}}` | 基准日期当晚 22:00 |
| `{{base_date + 1d @ 06:00}}` | 基准日期次日 06:00（`1d`=天、`2h`=小时、`30m`=分钟） |
| `{{base_date + 2h + 30m}}` | 基准日期 00:00 起偏移 2 小时 30 分 |
| `{{end(a) + 30m}}` | 任务 `a` **结束**后 30 分钟开始（前置结束时间偏移） |
| `{{start(b) - 15m}}` | 任务 `b` **开始**前 15 分钟 |
| `{{upgrade_dur}}` | 时长 / 偏移变量直接作为分钟数（可写 `{{d / 2 + 10m}}`，支持 `+ - * /`） |

> 说明：`end(x)` / `start(x)` 锚点要求任务 `x` 本身具有**可解析的固定开始时间**；
> 弹性任务的时间由排程器在运行期计算，不能作为模板锚点（会报 `anchor_unresolved`）。

**从现有场景生成模板**：在主编辑器中维护好窗口/任务/禁排期后，模板工作台里点击
「**⤓ 从当前编辑器场景生成**」，系统自动建立 `base_date` 基准日期变量，并把窗口、固定开始时间、
禁排期全部转换为 `{{base_date …}}` 表达式；随后可把任务的固定开始手工改写为
`{{end(前置任务) + 偏移}}` 形式。

**预览与实例化**：

1. 在右栏「① 输入实例化参数」填入参数（留空使用默认值）；
2. 「**👁 预览解析并排程**」：显示解析后的窗口、变量值、每个固定任务的绝对时间、
   `end()/start()` 锚点时间表，以及迷你甘特图与排程可行性；
3. 存在**错误**（表达式语法、未定义变量、**变量循环引用**、必填参数缺失、锚点不可解析、
   窗口非法）时不生成实例；**时间越界**（固定任务越窗、禁排期落在窗外）以黄色警告展示，
   仍可预览排程（排程器会进一步给出 `fixed_window` 等冲突）；
4. 「**🚀 实例化并保存**」：解析结果作为**独立场景**存入 `scenarios` 表并载入主编辑器，
   之后可自由拖动 / 修改，且后续编辑模板**不影响**已生成的实例（重名自动追加序号）。

**模板的保存与导出**：模板本身保存在 SQLite `templates` 表（CRUD 与场景一致）；
「**⬇ 导出模板 JSON**」下载 `maintenance-template-<时间戳>.json`，包含
`template`（模板定义）、`params`（输入参数）、`resolved`（解析后的全部参数 / 窗口 /
时长 / 固定时间 / 锚点时间 / 禁排期）、`issues`（校验问题）、`scenario`（实例场景）
与 `result`（排程结果）。

---

## 四、排程算法说明

0. **模板解析（仅模板实例化时，见 `templating.py`）**：词法/语法分析表达式 → 参数装配
   （缺省值回填）→ 变量与锚点引用检查 → **Tarjan 检测 `end()/start()` 锚点循环引用** →
   先解析全部任务时长，再按锚点依赖波次推进解析窗口、固定开始时间、禁排期 →
   **时间越界校验**（固定任务越窗 / 禁排期在窗外，作为 warning）→ 输出与普通场景同构的具体场景。
1. **输入规整与校验**：时间格式、时长、资源用量、id 唯一性、区间合法性。
2. **环检测**：Tarjan 强连通分量找出所有循环依赖（含自环），还原可读环路径；
   环上任务标记不可排程，环外任务照常求解。
3. **拓扑排序**：Kahn 算法得到可执行顺序（固定时间任务优先，其余按 id 稳定排序）。
4. **贪心最早可行槽位**（按拓扑序）：
   - 候选起点 = max(窗口起点, 所有前置完成时刻)；
   - 若与禁排期重叠 → 跳到禁排期结束；
   - 事件点扫描检查每种资源的并发占用是否超容量 → 跳到冲突占用的最早释放时刻；
   - 重复直到找到可行起点；超出窗口终点或单任务需求 > 资源总容量则判定不可排程。
5. **固定时间任务**不参与寻找，直接在指定时刻逐项做窗口/依赖/禁排期/资源校验。
6. 不可排程沿出边传播为"依赖阻塞"，并输出可定位的冲突链。

> 注：该贪心（列表调度类）对"找到满足全部约束的可行计划"是完备的：
> 单任务需求不超容量、窗口确实放得下时，推迟式求解一定能排下；放不下时给出具体挤压来源。

---

## 五、HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/schedule` | 提交场景 JSON，返回排程结果与冲突链 |
| POST | `/api/export` | 同 schedule，结果以 JSON 文件下载（可携带 `__template__/__params__/__resolved__/__issues__` 导出模板实例） |
| GET | `/api/scenarios` | 场景列表（id/名称/时间戳） |
| POST | `/api/scenarios` | 新建或按同名更新场景 `{name, data}` |
| GET | `/api/scenarios/{id}` | 恢复某场景（含完整 data） |
| PUT | `/api/scenarios/{id}` | 更新场景 |
| DELETE | `/api/scenarios/{id}` | 删除场景（其执行记录在同一事务级联清理） |
| GET | `/api/scenarios/{id}/execution` | 读取场景的实际执行记录（按任务顺序，含 `complete` 标记） |
| PUT | `/api/scenarios/{id}/execution` | 整批保存执行记录 `{records:[…]}`；校验不过返回 422 + 全部 `errors`，不写入部分数据 |
| GET | `/api/templates` | 模板列表 |
| POST | `/api/templates` | 新建 / 同名更新模板 `{name, data}`（保存前做结构校验） |
| GET | `/api/templates/{id}` | 获取模板（含完整 data） |
| PUT | `/api/templates/{id}` | 更新模板 |
| DELETE | `/api/templates/{id}` | 删除模板 |
| POST | `/api/templates/preview` | `{data, params}` 解析变量并排程（不落库）；error 以 422 返回 `issues` |
| POST | `/api/templates/instantiate` | 解析 → 排程 → 保存为独立场景，返回编辑器 state 与排程结果 |
| POST | `/api/templates/export` | 模板 / 参数 / 解析值 / 实例场景 / 排程结果合并导出为 JSON 文件 |
| GET | `/api/health` | 健康检查 |

排程请求体示例：

```json
{
  "window_start": "2026-09-23T22:00",
  "window_end":   "2026-09-24T06:00",
  "resources": { "DBA": 1, "网络组": 1 },
  "nodes": [
    { "id": "a", "name": "主备切换", "duration_minutes": 30,
      "resources": { "DBA": 1 }, "fixed_start": null },
    { "id": "b", "name": "版本升级", "duration_minutes": 90,
      "resources": { "DBA": 1 }, "fixed_start": "2026-09-24T01:00" }
  ],
  "edges": [ { "source": "a", "target": "b" } ],
  "blackouts": [
    { "name": "计费批处理", "start": "2026-09-24T00:00", "end": "2026-09-24T00:30" }
  ]
}
```

执行记录请求体（`PUT /api/scenarios/{id}/execution`，每任务恰好一条）：

```json
{
  "records": [
    { "node_id": "a", "executed": true,
      "actual_start": "2026-09-23T22:05", "actual_end": "2026-09-23T22:40", "reason": null },
    { "node_id": "b", "executed": false,
      "actual_start": null, "actual_end": null, "reason": "DBA 通宵不可用，取消执行" }
  ]
}
```

校验失败时 `422` 返回（前端整次拒绝、高亮出错行）：

```json
{ "detail": { "message": "执行记录校验未通过，整次保存已拒绝",
              "errors": [ { "node_id": "b", "message": "任务 b 的实际结束时间不能早于实际开始时间" } ] } }
```

模板请求体示例（`POST /api/templates/preview`）：

```json
{
  "data": {
    "name": "夜间数据库升级模板",
    "variables": [
      { "name": "base_date", "type": "date", "default": "2026-09-23" },
      { "name": "upgrade_dur", "type": "duration", "default": 90 },
      { "name": "guard", "type": "offset", "default": 15 }
    ],
    "scenario": {
      "window_start": "{{base_date @ 22:00}}",
      "window_end":   "{{base_date + 1d @ 06:00}}",
      "resources": { "DBA": 1 },
      "nodes": [
        { "id": "a", "name": "主备切换", "duration_minutes": 30,
          "resources": { "DBA": 1 }, "fixed_start": "{{base_date @ 22:00}}" },
        { "id": "b", "name": "版本升级", "duration_minutes": "{{upgrade_dur}}",
          "resources": { "DBA": 1 }, "fixed_start": "{{end(a) + guard}}" },
        { "id": "c", "name": "流量切回", "duration_minutes": 20,
          "resources": { "DBA": 1 }, "fixed_start": "{{end(b) + 30m}}" }
      ],
      "edges": [ { "source": "a", "target": "b" }, { "source": "b", "target": "c" } ],
      "blackouts": [
        { "name": "计费批处理",
          "start": "{{base_date + 1d @ 00:00}}", "end": "{{base_date + 1d @ 00:30}}" }
      ]
    }
  },
  "params": { "base_date": "2026-10-01", "upgrade_dur": 60, "guard": 20 }
}
```

实例化（`POST /api/templates/instantiate`）在上述基础上增加 `"template_id"`（可选，
不传则使用内联 `data`）与 `"name"`（实例场景名称），返回 `{id, name, data, result, resolved, issues}`。

---

## 六、目录结构与测试

```
.
├── app/
│   ├── main.py            # FastAPI：API、SQLite（scenarios/templates/execution_records）、静态托管、导出
│   ├── scheduler.py       # DAG 环检测 / 拓扑排序 / 资源+禁排期排程
│   ├── execution.py       # 实际执行记录校验（缺漏/重复/无效引用/缺时间/结束早于开始/缺原因）
│   ├── templating.py      # 场景模板：表达式词法/语法、变量解析、锚点环检测、时间越界校验
│   ├── models.py          # Pydantic 模型
│   └── static/
│       ├── index.html     # 编辑器 + 结果区 + 执行记录面板/弹窗 + 模板工作台弹窗
│       ├── app.js         # 原生 JS：表格编辑、Canvas 甘特图、拖拽、场景、执行记录、导出
│       ├── templates.js   # 模板工作台：变量编辑、参数预览、迷你甘特、实例化
│       └── styles.css
├── test_scheduler.py      # 排程核心测试（53 项断言，无需第三方库）
├── test_execution.py      # 执行记录校验与 API 测试（39 项断言，需 fastapi/httpx）
├── test_frontend_exec.js  # 执行记录前端流程测试（25 项断言，仅需 node）
├── test_templating.py     # 模板引擎测试（47 项断言，无需第三方库）
├── requirements.txt
├── Dockerfile
└── docker-compose.yml
```

运行后端测试：

```bash
pip install -r requirements.txt   # 测试仅依赖 fastapi（含 pydantic）；API 测试另需 httpx
python test_scheduler.py
python test_execution.py
python test_templating.py
node test_frontend_exec.js        # 前端执行记录登记 / 校验 / 偏差展示流程
```

---

## 七、常见问题

- **端口被占用**：`APP_PORT=9000 docker compose up -d --build`。
- **改了依赖镜像不生效**：`docker compose build --no-cache`。
- **时间按什么时区？** 前端使用浏览器本地时间生成 `datetime-local`，后端按朴素时间存储与计算，
  不做时区换算；容器与使用者在同一时区语义下即可。
- **资源容量能是小数吗？** 可以，如某资源 0.5 的占用也支持。
