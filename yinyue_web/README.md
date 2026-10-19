# 音绪 · 歌词情感工作台 2.2

一个在本机运行的歌词分析与曲库工具。粘贴歌词即可查看整体情感、逐行情感变化、词汇多样性和高频词；保存后可搜索曲库、查找特征相近的歌曲、导出 JSON。中文响应式界面，无前端构建步骤或 CDN。中文和韩文可使用本机专用情感模型，首次安装需下载约 861 MB 模型权重。

2.2 新增 **音频上传与自动歌词转写、十维情绪画像、在线歌词搜索、开放许可音频试听与下载**。原有曲库继续保留。详细操作、模型来源与限制见 [音频和搜索说明](AUDIO_AND_SEARCH.md)。

## 快速开始

需要 **Python 3.11 或更新版本**（CI 覆盖 3.11–3.13）。推荐使用虚拟环境：

```bash
cd yinyue_web
python3 -m venv .venv
source .venv/bin/activate         # Windows: .venv\Scripts\activate
python -m pip install -r backend/requirements.txt
# 启用更强的中文、韩文模型（推荐）
python -m pip install -r backend/requirements-models.txt
python scripts/setup_models.py
# 可选：多维情绪与音频识词
python -m pip install -r backend/requirements-audio.txt
python scripts/setup_emotion_model.py
python scripts/setup_audio_model.py
python run.py
```

打开 **http://127.0.0.1:5002**。前端与 API 由同一个服务提供，不再需要端口 8000。启动器在端口绑定成功后打开浏览器；按 Ctrl+C 关闭。

```bash
python run.py --no-browser
python run.py --port 5012
```

`python install_dependencies.py --with-models` 可一次安装基础与模型依赖，再运行 `python scripts/setup_models.py` 下载固定版本权重。需要 Python 3.11–3.13；模型在 CPU 上运行，建议至少 8 GB 内存。只有安装步骤需要访问 Hugging Face；分析时仅读取本地模型，不上传歌词、不临时下载。也可只安装基础依赖，界面会明确提示使用词典回退。

## 功能

- **歌词分析**：手动输入歌名、歌手、歌词，或填入原创示例后自行分析；查看整体情感、正负词比例、词汇统计、高频词和逐行情感轨迹。
- **歌词获取**：通过 lyrics.ovh 查询歌手与歌名，成功后自动分析入库。队列逐首处理，明确区分成功与失败；停止按钮停止后续任务，当前请求仍会完成。
- **我的曲库**：搜索、情感筛选、排序、分页、查看详情、单首重新分析、确认删除和 JSON 导出。同标题不同歌手分别保存；同歌手同标题更新已有记录，ID 保持不变。
- **相似推荐**：使用歌曲 ID 选择目标，按情感及词汇特征的固定范围加权距离排序；相似度在 0–100% 之间。相同标题不会覆盖，也不会因新增无关歌曲改变已有两首歌曲的相似度。
- **本地持久化**：SQLite 保存歌词与分析，歌词服务查询结果缓存 24 小时。歌曲与分析在同一个数据库事务中保存，写入失败不会报告成功。

歌词获取需要网络及外部服务支持。找不到歌词、超时、限流及无效响应均会明确显示，可以改为手动粘贴。示例和空状态不伪造曲库统计。

## 分析方法与范围

- **中文**：`IDEA-CCNL/Erlangshen-Roberta-110M-Sentiment`（110M 参数）。
- **韩文**：`Copycats/koelectra-base-v3-generalized-sentiment-analysis`。
- **英文**：保留 TextBlob 与基础情感词典。

中韩模型只学习正面、负面两类，没有中性类别。最大类别概率低于 0.65 时显示“倾向不明确”；这个阈值是展示规则，未经歌词数据校准。概率和置信度均不是准确率。不同语言分行汇总时，正负相抵可显示“混合情绪”。缺少权重、依赖或加载失败时，结果与顶部模型状态会明确提示回退，绝不冒充模型成功。

全文超出模型窗口时按 token 分块并加权汇总，不会静默丢掉后半段。逐行独立预测可与全文判断不同；中韩同一行混写时保留基础方法，分行混写则分别路由。中文分词、韩语词形、高频词及词汇统计仍较简单，不是模型归因解释。

这些模型来自评论领域，尚未在代表性歌词标注集上验证；隐喻、讽刺、叙述视角和跨句语境仍会误判。来源、固定版本、许可证与验证方法见 [模型说明](MODELS.md)。推荐使用整体模型极性和词汇特征，不代表旋律、风格或个人偏好。

旧曲库保留原结果；在歌曲详情点击 **重新分析** 即可生成新版分析，保留 ID、歌词、歌手、年份、类型和收藏关联。

## 数据与升级

默认数据目录为 `data/`，数据库为 `data/songs.db`。升级沿用旧表结构和歌曲 ID，不重建或清空已有曲库。备份时先关闭应用，再复制整个 `data/` 目录。

数据库、缓存、日志、虚拟环境和 Python 字节码已从版本管理中移除并忽略；它们仍保存在本机。新克隆的仓库从空曲库开始。**从旧 Git 版本拉取本次升级前，应先将原有 `data/` 复制到仓库外备份，升级后再放回**，因为 Git 会删除旧版曾跟踪的数据文件。JSON 导出可用于检查及留档，当前未提供 JSON 导入界面。

## 配置与运行

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `YINYUE_DATA_DIR` | 项目内 `data/` | 数据目录 |
| `YINYUE_DATABASE_PATH` | 数据目录中的 `songs.db` | 数据库路径 |
| `YINYUE_CACHE_DIR` | 数据目录中的 `cache/` | 歌词缓存目录 |
| `YINYUE_MODEL_DIR` | 数据目录中的 `models/` | 本地模型目录 |
| `YINYUE_MODELS_ENABLED` | `true` | 设为 `false` 明确关闭专用模型 |
| `YINYUE_HOST` | `127.0.0.1` | 监听地址 |
| `YINYUE_PORT` | `5002` | 监听端口 |

默认关闭调试，面向单用户本机使用。若需长期部署，可安装 WSGI 服务并使用应用工厂，例如 `waitress-serve --call backend.app:create_app`；公开部署前需另行配置身份验证、访问权限与 HTTPS。参见 [Flask 部署文档](https://flask.palletsprojects.com/en/stable/deploying/)。

## API

所有接口使用同源 `/api` 路径。写入请求采用 `Content-Type: application/json`，错误返回 JSON 和相应 HTTP 状态码。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 服务健康、版本、中韩模型就绪/缺失/错误状态 |
| GET | `/api/library` | 曲库；支持 `q`、`sentiment`、`sort`、`page`、`per_page` |
| GET | `/api/stats` | 实时曲库统计 |
| GET | `/api/songs/<id>` | 单首歌曲详情 |
| POST | `/api/add_song` | `{title, artist, lyrics}` 分析并保存 |
| POST | `/api/professional/crawl` | `{title, artist}` 获取并分析歌词 |
| POST | `/api/professional/crawl_batch` | `{songs: [{title, artist}]}`，最多 10 首 |
| POST | `/api/recommend` | `{song_id, top_k: 5}` 推荐相似歌曲 |
| POST | `/api/songs/<id>/reanalyze` | 使用当前模型重新分析已有歌词 |
| DELETE | `/api/songs/<id>` | 删除歌曲及关联数据 |
| GET | `/api/export` | 导出完整曲库 JSON |

歌名、歌手限制各 200 字符，歌词 50,000 字符，单次 JSON 请求上限 2 MiB；音频上传单独限制 30 MiB / 10 分钟。旧 `target_song` 标题推荐参数仅在曲库内标题唯一时接受；新客户端应使用 `song_id`。

## 验证

```bash
python -m unittest discover -s tests -v
python -m compileall -q backend scripts run.py install_dependencies.py
node --check frontend/js/app.js
```

测试使用临时数据库和模拟歌词服务，不修改真实曲库，也不依赖外部歌词服务在线。覆盖输入校验、原子保存、删除关联记录、同名歌曲、分页与统计、情感分析、推荐稳定性、缓存及网络错误。GitHub Actions 自动运行上述检查。单元测试使用模拟模型，不下载权重；本机真实模型验证另行运行：

```bash
python scripts/evaluate_sentiment.py --outputjson work/sentiment-evaluation.json
```

回归样本在模型试跑前冻结，是 32 条原创中韩短句，其中 28 条有正负预期，4 条中性/混合表达用于诊断。它刻意覆盖旧词典薄弱表达，不是代表性准确率基准；脚本保留全部预测与错例，任何样本发生模型回退都会以非零状态退出。

## 项目结构

```text
yinyue_web/
├── run.py                    # 单服务启动器
├── backend/
│   ├── app.py                # Flask 应用工厂及 API
│   ├── database.py           # SQLite 事务与查询
│   ├── lyric_analyzer.py     # 词汇、情感和相似度
│   ├── sentiment_models.py   # 固定版本、本地推理、长文本分块
│   ├── requirements-models.txt
│   ├── crawler.py            # 歌词服务与缓存
│   ├── config.py             # 环境配置
│   └── requirements.txt
├── frontend/                 # 无构建依赖的中文界面
├── tests/                    # 离线自动化测试
└── data/                     # 本机数据（不上传 Git）
```
