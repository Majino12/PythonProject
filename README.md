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
| **MoeMotion / VTuberProject** | 九方向短发 2D 角色、五档眼睑／张嘴、独立视线、ARKit 命名通道与可选面部跟踪 | JavaScript、Canvas、Three.js、three-vrm、MediaPipe、Node.js | [项目说明](VTuberProject/README.md) · [源码](VTuberProject/) |
| **小说全文分析 2.0** | 全文分块、混合模型阅读与证据复核、章节及全书报告 | Python、Flask、Ollama、兼容模型 API | [项目说明](xiaoshuo_web/README.md) · [源码](xiaoshuo_web/) |
| **音绪 / 歌词情感工作台 2.2** | 多语歌词分析、本地音频转写、情绪画像、曲库与相似推荐 | Python、Flask、TextBlob、Transformers、Whisper、SQLite | [项目说明](yinyue_web/README.md) · [音频与搜索](yinyue_web/AUDIO_AND_SEARCH.md) · [源码](yinyue_web/) |

各子目录有独立的运行入口和依赖；仓库根目录没有统一启动命令。

## MoeMotion

当前子项目版本为 `0.15.0`，默认打开短发角色 2D 工作台：九个准备好的头部方向、五档眼睑与张嘴、眉毛动作、独立视线和 22 个 ARKit 命名通道。八个非正面方向新增 16 张选定源稿，眼睑与张嘴逐张经过已有档位；提供 30／60 fps 请求选项和实际绘制统计。

需要 Node.js 18 或更新版本。在仓库根目录执行：

```bash
cd VTuberProject
npm start
```

访问 <http://127.0.0.1:4173>，可直接手动搭配方向与表情或播放演示。开启摄像头是可选操作，首次需要联网下载 MediaPipe 面部模型；默认启动不加载 3D、不请求摄像头，也不调用图像生成服务。工作台支持本地项目保存、单帧系数 JSON、PNG 和无声录像导出。

九方向是有限画稿，不是连续转头；30／60 fps 是绘制和录像请求，不保证设备始终达到，也不代表每秒有 60 张独立原稿。当前保留画稿背景，没有虚拟摄像头、iPhone 接收器或 VTube Studio 连接。全套自动测试 589 项通过，浏览器完成 718 次原生像素比较、1060 项断言；实际摄像头硬件尚未启用验证。

旧 Luna／3D 应用仍可通过 `legacy-studio.html` 访问，其功能与许可见 [旧版说明](VTuberProject/LEGACY-README.md) 和 [素材来源与许可](VTuberProject/assets/THIRD_PARTY_NOTICES.txt)。本次没有修改 3D 功能。完整能力、限制、素材来源与验证结果见 [VTuberProject README](VTuberProject/README.md)。

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

## 歌词情感分析 · 音绪 2.2

中文歌词工作台，新增本地 Whisper 音频识词、十维情绪画像、在线歌词搜索及开放许可音频下载，提供手动歌词分析、逐行情感变化、高频词、歌词查询、曲库搜索筛选与 JSON 导出，以及按歌曲 ID 区分的相似推荐。英文使用 TextBlob 与情感词典，中文使用 Erlangshen、韩文使用 KoELECTRA 本地专用模型；展示置信度、模型版本和回退状态。歌词和分析原子保存到本机 SQLite。

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
