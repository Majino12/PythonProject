# PythonProject · Web 与 AI 应用实验集

收录三个独立运行的应用原型：让单张角色图动起来的 **MoeMotion**、小说与新闻文本分析工具，以及歌词情感分析与相似歌曲推荐工具。

**项目分类：应用实验 · Web 与 AI**  
**技术：Python · Flask · JavaScript · Three.js · 自然语言处理**

```bash
git clone https://github.com/Majino12/PythonProject.git
cd PythonProject
```

## 项目导航

| 项目 | 用途 | 主要技术 | 入口 |
| --- | --- | --- | --- |
| **MoeMotion / VTuberProject** | 原图 2D 动画、精细 VRM 模板与轻量 3D 角色，支持摄像头动作跟踪 | JavaScript、Canvas、Three.js、three-vrm、MediaPipe、Node.js | [项目说明](VTuberProject/README.md) · [源码](VTuberProject/) |
| **小说 / 新闻文本分析** | 提取摘要、人物、关键词和情感变化，查看分析报告 | Python、Flask、NLTK、spaCy、KeyBERT、TextBlob | [项目说明](xiaoshuo_web/README.md) · [源码](xiaoshuo_web/) |
| **歌词情感分析** | 分析歌词情感与词汇特征，保存歌曲并按特征推荐相似歌曲 | Python、Flask、TextBlob、SQLite | [项目说明](yinyue_web/README.md) · [源码](yinyue_web/) |

各子目录有独立的运行入口和依赖；仓库根目录没有统一启动命令。

## MoeMotion

将一张 PNG、JPG 或 WEBP 角色图变为可互动的虚拟形象。支持原图 2D 动画、参考图片配色的授权精细 VRM 模板、轻量程序化 3D、自动演示、摄像头面部与身体跟踪、项目保存、视频录制和模型导出。当前子项目版本为 `0.8.0`。精细 3D 保留模板的脸型、发型和服装版型，不是原图的三维重建。

需要 Node.js 18 或更新版本。在仓库根目录执行：

```bash
cd VTuberProject
npm start
```

访问 <http://127.0.0.1:4173>。可以先用示例角色体验自动演示，再导入图片或开启摄像头。

首次使用跟踪与 3D 功能需要联网加载相关模型和运行文件。页面还提供可选的 OpenAI 图片生成入口，需要自行填写 API Key；角色描述和 API Key 会经本机服务发送到 OpenAI。导入图片、摄像头跟踪与 3D 构建在本机处理。

精细版导出保留骨骼、表情、配色与模型许可的 VRM；轻量版导出 GLB，两者均不包含当前动作。内置模型受其原许可约束，见 [素材来源与许可](VTuberProject/assets/THIRD_PARTY_NOTICES.txt)。详细能力与格式说明见 [MoeMotion README](VTuberProject/README.md)。

## 小说 / 新闻文本分析

通过粘贴文本、上传 UTF-8 TXT 文件或输入网页地址进行分析。提供摘要、人物统计、简单共现关系、关键词、情感曲线和可读性统计，并保存分析历史。

需要 Python 3。建议在独立虚拟环境中安装依赖；在仓库根目录执行：

```bash
cd xiaoshuo_web
python -m pip install -r requirements.txt
python -m pip install psutil
python -m spacy download en_core_web_sm
python run.py
```

访问 <http://127.0.0.1:5003>。`psutil` 是现有启动脚本和后端使用、但尚未列入该目录依赖清单的依赖。

分析流程主要使用英文分词、英文停用词和英文模型；中文、英文、韩文界面切换不代表三种语言的分析效果相同。首次运行可能下载 NLTK 数据及相关模型。

当前后端按 UTF-8 文本读取上传文件。报告可以导出 JSON 或 HTML；PDF 选项返回 HTML 报告，可再通过浏览器打印为 PDF。

## 歌词情感分析 · 音绪 2.0

中文歌词工作台，提供手动歌词分析、逐行情感变化、高频词、歌词查询、曲库搜索筛选与 JSON 导出，以及按歌曲 ID 区分的相似推荐。英文使用 TextBlob 与情感词典，中文和韩文提供基础词典分析并展示局限。歌词和分析原子保存到本机 SQLite。

需要 Python 3.11 或更新版本。在独立虚拟环境安装：

```bash
cd yinyue_web
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r backend/requirements.txt
python run.py
```

访问 <http://127.0.0.1:5002>。单个服务提供前端与 API；无需端口 8000、CDN 或额外模型下载。歌词在线查询取决于 lyrics.ovh 的可用性，手动分析可离线运行。

旧版曾跟踪数据库文件，**Git 拉取升级前请先在仓库外备份 `yinyue_web/data/`，升级后放回**。新版本不再上传曲库、缓存或日志。详细功能、配置与限制见 [音绪说明](yinyue_web/README.md)。

## 目录结构

```text
PythonProject/
├── VTuberProject/   # MoeMotion：浏览器内的 2D / 3D 虚拟形象原型
├── xiaoshuo_web/    # 小说与新闻文本分析
└── yinyue_web/      # 歌词情感分析与相似歌曲推荐
```

## 运行说明

这些项目用于本地实验与功能演示。各子项目的运行环境与验证命令见其独立说明。音绪支持 Python 3.11+，并提供隔离真实数据的自动化测试。

MoeMotion 提供 `npm run check` 和 `npm test` 命令，可在 `VTuberProject` 目录中执行。
