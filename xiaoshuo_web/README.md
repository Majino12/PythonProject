# 小说全文分析 · 2.0

按完整原文逐段阅读的小说分析工具。中文、英文章节都保留；长章节继续切块，最后一章、最后一个字符也进入处理。提供章节摘要、全书汇总、带原文证据的人物与事件、全文统计、后台进度和报告导出。

旧版的“前 15 章 / 每章 3000 字”摘要、前 30 万字符截取、固定比例猜测高潮、用共现推断关系、随机耗时与模拟进度已移除。全文覆盖率表示处理范围，**不代表准确率**。模型结论仍需结合原文核对。

## 快速启动

Python 3.11+，每个应用使用独立虚拟环境：

```bash
cd xiaoshuo_web
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python run.py
```

访问 http://127.0.0.1:5003 。未配置模型时，自动模式仅提供明确标注的全文摘录与统计，不编造语义结论。依赖安装和应用导入不会自动下载模型。

## 本地混合模型

安装 [Ollama](https://ollama.com/download) 0.34 或更新版本（本机实测 0.40.6），启动本地服务，在另一个终端下载：

```bash
ollama serve
# 已有 Ollama 后台服务时无需重复启动
```

```bash
ollama pull qwen3.5:4b
ollama pull qwen3.5:9b
cp .env.example .env
python scripts/check_models.py
python run.py
```

默认配置：9B 负责分块提取、汇总、普通结论的直接证据与上下文复核，4B 专门核验人物描述的直接引文与归属；各阶段默认关闭推理模式。较小模型承担所有批量审核时出现过误拒与错配引用，因此主流程使用 9B，人物归属另设模型角色。这是小样本试验后的配置，不证明对其他小说普遍更准确。16GB Mac 可先使用这一组合；实际内存与速度取决于上下文、模型切换和其他运行程序。更紧凑的设备可把四个角色都设置为 `qwen3.5:4b`，更大内存设备可显式选择更大模型。支持 thinking 的模型可以设置 `NOVEL_VERIFY_THINKING=enabled`；本机一次单条审核实测在 300 秒内未完成，所以未设为默认，也未据此证明推理模式更准确。首次下载需要数 GB 空间，下载完成后本地推理不需要联网。

模型规格来自 [Ollama Qwen3.5 模型页](https://ollama.com/library/qwen3.5)，客户端按 [Ollama Chat API](https://docs.ollama.com/api/chat) 调用 JSON 输出。模型名称与可用性以 `python scripts/check_models.py` 的实测为准。

## 云端与混合提供方

支持提供 JSON 输出的兼容 Chat Completions 接口。提取、引文核验、上下文复核、汇总可分别配置，密钥仅从 `.env` / 环境变量读取，不进入 Git 或报告。选择云端阶段会将该阶段原文片段或带引文的分析记录发送至所配置服务；本地模式不发送小说到云端。

例如全部使用 DeepSeek（需要自己的 API Key）：

```dotenv
NOVEL_MODEL_PROVIDER=compatible
NOVEL_BASE_URL=https://api.deepseek.com
NOVEL_API_KEY=填写自己的密钥
NOVEL_COMPATIBLE_THINKING=disabled
NOVEL_MAP_MODEL=deepseek-flash
NOVEL_QUOTE_MODEL=deepseek-v4-pro
NOVEL_REDUCE_MODEL=deepseek-v4-pro
NOVEL_VERIFY_MODEL=deepseek-v4-pro
```

上述名称根据 2026-10-19 的 [DeepSeek 官方模型表](https://api-docs.deepseek.com/quick_start/pricing/) 核实。服务可能更新名称；不保证未来永远可用。也可保留本地 map/quote，仅配置 reduce/verify 云端服务。任一角色可独立设置 `NOVEL_MAP_PROVIDER`、`NOVEL_MAP_BASE_URL`、`NOVEL_MAP_API_KEY`、`NOVEL_MAP_MODEL`（把 MAP 替换为 QUOTE / REDUCE / VERIFY 即可）。quote 未显式设置时继承 verify 的服务地址与凭据；本地默认 4B，兼容云端默认继承 verify 模型。保留本地 quote 时请明确设置 `NOVEL_QUOTE_PROVIDER=ollama` 和本地 `NOVEL_QUOTE_BASE_URL`。

远程端点要求 HTTPS；本机端点允许 HTTP。API 不可用、超时、JSON 无效或输出被截断会明确失败或标为部分结果，不会悄悄用规则结果冒充模型分析。模型配置存在不代表模型已下载或服务器在线；运行检测脚本检查。

## 分析过程与报告

1. 保留原文换行和章节边界，识别中文章节、英文 Chapter 等标题；无标题文本也按段落/长度完整切块。正文限额超出时明确拒绝，不截去尾部。
2. 每个块都提取叙述、人物、事件、主题与逐字引文。引文必须能在该原文块定位，并扩展为包含命中片段的完整句（最多 1200 字符，不能完整纳入时拒绝该证据）；记录章节、块号和字符偏移。
3. 审核分两关：先仅根据引文本身核对当前结论、主体和亲属归属，不向这一步提供邻接段落；通过后再检查相邻上下文中的否定、传言和限定。上下文审核不能补救引文本身缺少支持的结论。两关都通过才保留，仍不能保证模型判断一定正确。
4. 分层汇总完整章节和全书，所有分块都参与。汇总模型只返回要保留的事实编号，由程序复制对应原句和完整引用、沿用已有审核结果，模型没有改写或合并新事实的输出通道。非法编号被拒绝，记录原文覆盖和失败块。全书摘要另外保留末章引用位置最靠后的至多两条已验证叙事事实，减少压缩时遗漏结尾的情况。不会将整本书直接塞进一个超长请求后让服务静默截断。
5. 报告展示方法、模型、覆盖、警告、每章摘要、引用与全文统计。基础模式只显示摘录与统计；不生成猜测的人物关系、主题或情绪曲线。

中文计数与英文按空格分词不同；统计字段说明应与具体报告一起阅读。引文存在仅证明原文有这句话，不能单独证明所有解释正确。书中不可靠叙述、讽刺、隐喻、别名、跨章伏笔可能仍被遗漏或误解。整本上传文本的覆盖不等于出版版本完整性；软件不知道是否缺章。

## 输入与边界

- TXT：UTF-8 / UTF-8 BOM / UTF-16 BOM / GB18030；错误编码会提示。
- DOCX：正文段落与表格按阅读顺序提取；不做批注、图片 OCR。
- PDF：读取文本层；扫描页或有内容却无文本层的页明确报错，避免把缺页当全文。
- 网页：只分析当前页面提取的正文，不自动追踪整部小说目录。整本分析请上传完整文件。
- 默认上传 64 MB、正文 2000 万字符。限额保护资源使用；不会自动缩短输入。
- JSON / HTML 导出；PDF 使用浏览器“打印 → 保存为 PDF”。

## 任务、保存与部署

`POST /analyze` 返回 202 与任务 ID；`GET /analysis/status/<id>` 返回真实 queued / processing / completed / failed、阶段、已完成块数与总块数。未知任务返回 404。浏览器刷新不停止后台任务，但**服务进程重启会中断任务并标记失败，需重新提交原文**，任务 ID 本身不续算；默认启用响应缓存，重新提交完全相同的原文和配置时可复用已完成的模型调用，避免从零推理。

默认一个任务执行、两个任务排队，超过返回 429。任务状态与报告在 `data/jobs`、`data/results` 原子保存，不放入 `static`。原文上传文件不持久保存。模型响应缓存保存在私有 `data/model_cache`，包含分析及引用，默认有效期 7 天，按端点、模型和完整请求摘要匹配；不保存 API Key 或原始请求正文。模型提供方原地升级同名模型时，请清理此缓存或设置 `NOVEL_CACHE_ENABLED=0` 重新测算。仓库原先已跟踪的上传文件、旧报告和缓存保留存档，本次不删除；忽略规则防止新增运行数据进入提交，但不会撤销已有文件的跟踪。应用禁止访问旧版上传和报告静态目录，也不会将旧报告作为新结果使用。

当前是单进程本地应用，请只启动一个服务进程。不要使用多进程 Gunicorn 或让多个实例共用 data 目录。默认只监听 127.0.0.1；本版本没有账户隔离，不宜直接公开到互联网。

## 配置

下表为未设置环境变量时的代码默认值；随附 `.env.example` 将普通请求超时设为 300 秒，供本地模型使用。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `NOVEL_MODEL_PROVIDER` | `disabled` | `disabled` / `ollama` / `compatible` |
| `NOVEL_MODEL_TIMEOUT` | 180 | 每次模型请求读超时（秒） |
| `NOVEL_MODEL_RETRIES` | 2 | 连接、429、5xx 的额外重试次数 |
| `NOVEL_MAX_PROMPT_CHARS` | 24000 | 模型输入字符硬上限；超限报错 |
| `NOVEL_MAX_OUTPUT_TOKENS` | 4096 | 单次输出预算 |
| `NOVEL_VERIFY_THINKING` | Ollama 为 disabled | 可选 enabled 开启审核推理；兼容云端仅按显式配置发送 |
| `NOVEL_QUOTE_MODEL` | Ollama 为 qwen3.5:4b | 人物直接引文核验；服务、预算、超时等可用 QUOTE 前缀单独配置 |
| `NOVEL_VERIFY_MAX_OUTPUT_TOKENS` | 至少 8192 | 审核输出预算，包含服务方计入的推理用量 |
| `NOVEL_VERIFY_TIMEOUT` | 至少 300 | 审核单次请求超时（秒） |
| `NOVEL_CONTEXT_TOKENS` | 32768 | Ollama 上下文预算 |
| `NOVEL_CACHE_ENABLED` | 1 | 是否复用 7 天内相同模型请求的响应 |
| `NOVEL_CHUNK_CHARS` | 6000 | 分块字符预算 |
| `NOVEL_REDUCE_INPUT_CHARS` | 18000 | 汇总批次字符预算 |
| `NOVEL_DATA_DIR` | `xiaoshuo_web/data` | 私有任务与报告目录 |
| `NOVEL_MAX_CONTENT_LENGTH` | 67108864 | 请求体字节上限 |
| `NOVEL_MAX_ANALYSIS_TEXT_LENGTH` | 20000000 | 正文字数上限 |
| `NOVEL_JOB_WORKERS` | 1 | 同时分析的任务数 |
| `NOVEL_JOB_QUEUE_SIZE` | 2 | 等待队列长度 |

大模型与长篇逐块处理可能耗时较长；本机 4B/9B 的两章短篇实测也需要数分钟，百万字整书应预留长时间运行。页面显示工作进度，未估算时不声称几秒完成。API 用量取决于分块数与复核、汇总请求数。

## 验证

```bash
python -m unittest discover -s tests -v
python scripts/check_models.py  # 只检测连接与模型名，不进行推理
node --test tests/test_ui.js    # Node 18+，无需 npm 依赖
python scripts/evaluate_pipeline.py --live --output data/live-check.json
python scripts/evaluate_verifier.py --live --output data/verifier-check.json  # 4个正负审核案例，非准确率评测
```

自动化测试使用可控模型替身验证覆盖、原文证据拒绝、异常响应、任务状态、文件提取与导出，不把替身测试当模型准确率。真实模型测试与结果记录见 `VALIDATION.md`。需要带人工标注的不同作品评测才能报告准确率，本项目没有宣称未测得的提升百分比。
