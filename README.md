# PythonProject · Web 与 AI 应用实验集

收录三个独立运行的应用原型：绘制式 2D 虚拟形象工具 **MoeMotion**（保留旧 3D 入口）、带原文证据的小说全文分析工具，以及 **音绪** 多语歌词与音频工作台。

**项目分类：应用实验 · Web 与 AI**  
**技术：Python · Flask · JavaScript · Three.js · 自然语言处理**

```bash
git clone https://github.com/Majino12/PythonProject.git
cd PythonProject
```

## 项目导航

| 项目 | 用途 | 主要技术 | 入口 |
| --- | --- | --- | --- |
| **MoeMotion / VTuberProject** | 连续转头、透明分层、五档眼口、独立视线、面部跟踪与 OBS 输出 | JavaScript、Canvas、Three.js、three-vrm、MediaPipe、Node.js | [项目说明](VTuberProject/README.md) · [源码](VTuberProject/) |
| **小说全文分析 2.0** | 全文分块、混合模型阅读与证据复核、章节及全书报告 | Python、Flask、Ollama、兼容模型 API | [项目说明](xiaoshuo_web/README.md) · [源码](xiaoshuo_web/) |
| **音绪 / 音乐与歌词情绪工作台 2.3** | 音频情绪、编曲/旋律建议、可选识词与曲库 | Python、Flask、TextBlob、Transformers、CLAP、Whisper、SQLite | [项目说明](yinyue_web/README.md) · [音频与搜索](yinyue_web/AUDIO_AND_SEARCH.md) · [源码](yinyue_web/) |

各子目录有独立的运行入口和依赖；仓库根目录没有统一启动命令。

## MoeMotion

版本：`0.21.0`。九方向鼻线、眼睑与嘴部先按源画稿轮廓对齐，再连续转头；眼、口、眉及视线保留实际中间进度，减少离散切换和五官重影。沿用透明分层、遮挡补画和局部前发网格。

```sh
cd VTuberProject
npm start
```

打开 <http://127.0.0.1:4173>。摄像头、微动和直播需主动开启。独立输出可调整构图并接入同机 OBS 浏览器源（1280×720）；新动作片段 v4 保存实际头位、表情进度及微动。[OBS 接入](VTuberProject/OBS-SETUP.txt) · [项目说明](VTuberProject/README.md)

本轮 **1088/1088** 自动测试通过；30/60fps请求各8组实际转头通过。浏览器原画端点与表情端点保持一致，接缝可见像素差≤2，原始透明RGB差异另行保留。双画面对比实际约23/29次绘制每秒，不承诺稳定60fps。[连续五官与动作验证](VTuberProject/docs/FEATURE-MOTION-v0.21.txt)

已检查鼻线和闭眼重影明显改善；半闭眼与发尖相邻处仍可能轻微弯折，眉部仍依赖画稿混合，完整隐区与全头绑定尚未补齐。真人摄像头、长时间直播和实际OBS未在本轮实机验收。下载历史按日期保存在本机项目目录，不作为运行素材。

旧 Luna／3D、原画与批准记录保留。许可见 [原素材](VTuberProject/assets/THIRD_PARTY_NOTICES.txt)、[RIFE](VTuberProject/assets/short-hair-motion-v1/LICENSE-RIFE.txt)、[动漫分割](VTuberProject/assets/short-hair-alpha-v1/LICENSE-anime-seg.txt)。[分层说明](VTuberProject/docs/FRINGE-2D.txt) · [市场对比历史](VTuberProject/docs/MARKET-COMPARISON-v0.19.txt)

## 小说全文分析 · 2.0

完整处理上传原文，支持中英文章节、超长章节分块与全书汇总。本地默认由 Qwen3.5 9B 负责分块提取、汇总和普通结论复核，4B 专门核验人物描述的直接引文与归属；也能为不同阶段混用兼容云端 API。人物、事件、主题附逐字原文证据；报告展示覆盖范围与失败块。未配置模型时提供明确标注的全文摘录和统计。

需要 Python 3.11+。在仓库根目录执行：

```bash
cd xiaoshuo_web
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python run.py
```

访问 <http://127.0.0.1:5003>。开启本地模型需安装 Ollama、下载模型并配置 `.env`，具体见 [小说分析 README](xiaoshuo_web/README.md)。支持 TXT、文本型 PDF、DOCX；网页仅提取当前页。任务异步执行，进度来自实际工作量，结果可导出 JSON / HTML 或打印为 PDF。服务重启会明确标记被中断任务。

全文覆盖率不等于准确率，模型结论仍需人工核对。未再使用旧版前 15 章截取、固定位置猜高潮与虚假进度。自动测试：`python -m unittest discover -s tests -v`。

## 音乐与歌词情绪分析 · 音绪 2.3

中文音乐工作台，支持无需歌词的音乐音频情绪分析，以及依据节奏、能量、音色和音高线索生成的编曲与旋律修改建议。使用本地 CLAP 音频语义模型、可解释声学特征和可选 Whisper 识词，保留十维歌词情绪、在线歌词搜索、开放许可音频下载及曲库管理。中文歌词使用 Erlangshen、韩文使用 KoELECTRA；音乐与歌词分别展示结果、模型和限制。歌词和分析原子保存到本机 SQLite。

需要 Python 3.11 或更新版本。在独立虚拟环境安装：

```bash
cd yinyue_web
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r backend/requirements.txt
python -m pip install -r backend/requirements-models.txt
python scripts/setup_models.py
python run.py
```

访问 <http://127.0.0.1:5002>。单个服务提供前端与 API；无需端口 8000 或 CDN。上述步骤安装基础应用与中韩情感模型，首次需下载约 861 MB 权重，之后离线推理。音频转写和十维情绪画像还需各自的依赖与模型，按 [音频和搜索说明](yinyue_web/AUDIO_AND_SEARCH.md#安装) 完成可选安装；仅安装基础依赖时也能运行，界面会明确标注模型回退状态。

按歌手和歌名获取歌词使用 lyrics.ovh，歌词搜索使用 LRCLIB，开放许可音频搜索使用 Wikimedia Commons；这些在线功能取决于对应服务的可用性。手动歌词分析可离线运行。

旧版曾跟踪数据库文件，**Git 拉取升级前请先在仓库外备份 `yinyue_web/data/`，升级后放回**。新版本不再上传曲库、缓存或日志。详细功能、配置与限制见 [音绪说明](yinyue_web/README.md)。

## 目录结构

```text
PythonProject/
├── VTuberProject/   # MoeMotion：短发 2D 工作台与旧版 3D 入口
├── xiaoshuo_web/    # 带原文证据的小说全文分析
└── yinyue_web/      # 音绪：多语歌词、音频转写与曲库
```

## 运行说明

这些项目用于本地实验与功能演示。各子项目的运行环境与验证命令见其独立说明。音绪支持 Python 3.11+，并提供隔离真实数据的自动化测试。

MoeMotion 的开发验证使用 Node.js 22，在 `VTuberProject` 目录执行 `npm run check` 和 `npm test`；GitHub 自动测试运行同样的命令。
