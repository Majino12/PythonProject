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
| **歌词情感分析** | 分析歌词情感与词汇特征，保存歌曲并按特征推荐相似歌曲 | Python、Flask、TextBlob、scikit-learn、SQLite | [项目说明](yinyue_web/README.md) · [源码](yinyue_web/) |

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

## 歌词情感分析

支持手动录入歌曲与歌词，也提供按歌手和歌名从 lyrics.ovh 获取歌词的入口。使用 TextBlob 与自定义英文情感词典分析歌词，提取词汇多样性等特征，并以标准化后的特征向量和余弦相似度推荐歌曲。歌曲与分析结果保存在本地 SQLite 数据库。

需要 Python 3。建议使用单独的虚拟环境；在仓库根目录执行：

```bash
cd yinyue_web
python -m pip install -r backend/requirements.txt
python run.py
```

启动器会开启 Flask 后端（端口 `5002`）与静态前端（端口 `8000`），并打开 <http://localhost:8000/professional_crawler.html>。歌词获取依赖外部服务是否返回对应歌曲。

目前主要面向英文歌词。

## 目录结构

```text
PythonProject/
├── VTuberProject/   # MoeMotion：浏览器内的 2D / 3D 虚拟形象原型
├── xiaoshuo_web/    # 小说与新闻文本分析
└── yinyue_web/      # 歌词情感分析与相似歌曲推荐
```

## 运行说明

这些项目用于本地实验与功能演示。Python 子项目尚未统一声明支持的 Python 版本；启动说明依据仓库内的依赖文件与启动脚本整理，具体环境兼容性仍需实际安装验证。

MoeMotion 提供 `npm run check` 和 `npm test` 命令，可在 `VTuberProject` 目录中执行。
