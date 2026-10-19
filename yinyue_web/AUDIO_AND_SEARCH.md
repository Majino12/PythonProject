# 音频识词、情绪画像与在线搜索（2.2）

## 使用流程

1. 打开“音频识词”，选择本机音频。支持 MP3、WAV、M4A、FLAC、OGG/OGA、Opus、AAC、AIFF/AIF、WebM，单个文件最多 30 MiB、10 分钟。
2. 选择自动检测或指定中文、韩文、英文。开始后显示后台任务状态和按已识别时间计算的进度，可以取消；取消会在当前模型片段结束后生效。CPU 转写可能比音频本身更长，进度不是时间保证。
3. 播放原音频并校对识别文字，再导入分析工作台保存。可导出校对后的 TXT；非空歌词行数仍与识别片段数一致时，也可导出带段落时间戳的 LRC。时间戳沿用模型估计，并非人工对齐；修改行数后需另行调整时间点。
4. 输入已知歌名和歌手，可搜索发布的歌词版本供校正。确认对应歌手、专辑和版本后再导入，避免同名歌曲误匹配。
5. 分析结果保留原有正负倾向，新增喜悦、悲伤、愤怒、恐惧、爱恋、思念、希望、平静、孤独、怀旧十类情绪画像。

上传的音频只在本机临时处理，任务结束、失败或取消后删除服务器临时副本；不会删除用户选择的原文件。转写任务结果在进程内保留一小时，页面刷新可恢复尚未过期的任务，重启服务后任务消失。转写不会直接写入曲库，确认并分析后才保存歌词。单进程同时执行一个转写任务，最多另有一个等待任务。

同一浏览器标签页刷新后，已完成任务的校对文字、歌名和歌手草稿也会恢复，前提是浏览器会话存储可用。重新选择同一原音频即可恢复播放和逐段试听，无需重新识别，也不会覆盖校对草稿。文件名、大小或修改时间不同会被视为新音频，并开始新的工作草稿。刷新后需再次勾选校对确认；会话草稿不代替下载 TXT 或保存到曲库。

## 安装

```bash
python install_dependencies.py --with-models --with-audio
python scripts/setup_models.py
python scripts/setup_emotion_model.py
python scripts/setup_audio_model.py
python run.py
```

现有 2.1 用户已装中韩情感模型时，无需重复下载它们。新增模型共约 2.2 GB；加上已有两种模型，权重约 3 GB。建议至少 16 GB 内存。首次模型加载较慢，后续进程内复用。已在 macOS arm64 / Python 3.12 验证，当前音频依赖的 macOS arm64 wheels 需要 macOS 14 或更新版本。CI 使用模拟推理验证 Python 3.11–3.13，不会自动下载权重。

`YINYUE_MODEL_DIR` 指定统一模型根目录：`zh/`、`ko/`、`emotion/`、`audio/`。单独运行安装脚本时也可设置 `YINYUE_AUDIO_MODEL_DIR` 或 `YINYUE_EMOTION_MODEL_DIR`；Web 服务统一使用 `YINYUE_MODEL_DIR` 下对应子目录。关闭多维情绪模型可设置 `YINYUE_EMOTIONS_ENABLED=false`。缺少模型时页面会明确显示，音频上传返回 503，不会伪造转写结果。

## 音频模型与边界

- 原模型：[OpenAI Whisper large-v3-turbo](https://huggingface.co/openai/whisper-large-v3-turbo)，809M 参数、多语、MIT。
- 运行权重：[dropbox-dash/faster-whisper-large-v3-turbo](https://huggingface.co/dropbox-dash/faster-whisper-large-v3-turbo)，固定 revision `0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf`。
- 引擎：[faster-whisper](https://github.com/SYSTRAN/faster-whisper) 1.2.1、CTranslate2 4.8.3，CPU int8，最多四线程；PyAV 19.0.1 解码为 16 kHz 单声道，无需额外安装 ffmpeg 命令。
- 下载白名单文件并校验 SHA-256；CT2 `model.bin` 为本地原生张量格式，非 Python pickle。Web 请求只读取本地文件，不下载模型、不上传音频。

Whisper 主要针对语音识别。伴奏、合唱、音色处理、演唱拖音、语言混用都可能造成漏词和幻觉。关闭语音 VAD 以免误删唱词，使用 beam search、无语音信号和重复输出检查；静音直接返回无可靠歌词。有效副歌重复保留。仍需用户校对，不能将“自动识别”理解为准确歌词保证。

## 多维情绪模型与分数

使用 [MoritzLaurer/mDeBERTa-v3-base-mnli-xnli](https://huggingface.co/MoritzLaurer/mDeBERTa-v3-base-mnli-xnli)，MIT、safetensors，revision `8adb042d524ecd5c26d3e3ba0e3fbcf7e2d0864c`。这是多语自然语言推断模型，通过固定情绪描述进行零样本语义匹配，**没有用歌词情绪标签专项训练**。中文与英文属于其任务微调语言；韩文使用跨语言迁移，界面保留这一限制。

每类匹配度独立计算为 entailment/(entailment+contradiction)，不要求相加为 100%，不代表情绪强度、准确率或临床判断。额外保留三分类 entailment evidence：低于 0.35 时界面仅标“支持不足”，不展示百分比或填充横条，避免模型实际偏 neutral 却因二项归一化产生高匹配度的误导。有语义支持的类别优先排列。只有匹配度至少 0.5 且 evidence 至少 0.35 的前最多三类显示为主导情绪，这些都是展示规则。较短文字会提示语义线索有限，即使有主导标签也需结合完整歌词判断。

最多分析四个均匀分布片段、每片段 192 个内容 token；长歌词显示实际覆盖比例与抽样限制。原有正负模型仍覆盖全部歌词，情绪画像单独标注覆盖范围。两个功能互为补充，不能把正面判定直接解释为所有情绪都积极。

## 在线来源、下载与署名

- **歌词**：[LRCLIB API](https://lrclib.net/docs)，搜索返回歌名、歌手、专辑、时长、纯文本与同步歌词，用户选择版本后导入或下载 TXT/LRC。有些记录只有一种歌词或为纯音乐。接口拥堵、超时、限流和空结果会如实显示；歌词自身权利归原权利人，API 可访问不等于歌词是公有领域。
- **音频**：[Wikimedia Commons](https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia)。仅展示文件元数据明确标为 CC0、CC BY、CC BY-SA 或公有领域、类型为音频且小于 30 MiB 的记录；CC BY 类必须有作者。页面保留作者、许可链接、出处、credit、attribution 和 restrictions，可保存署名信息。商业歌曲未必有可下载版本，空结果不能自动换成未经授权的音源。

音频下载仅接受 Commons 文件记录 ID；服务器每次重新核对许可、类型、大小及官方 `upload.wikimedia.org` URL，禁止跳转到其他地址，校验完整下载后才返回文件。没有任意链接下载代理，也不支持绕过平台付费或 DRM。分享或再利用时应遵守对应许可，保留要求的署名和相同方式共享条件。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/audio/status` | 本地音频模型状态 |
| POST | `/api/audio/jobs` | multipart `file`、`language=auto/zh/ko/en`，202 返回 job |
| GET | `/api/audio/jobs/<id>` | queued/running/cancelling/completed/failed/cancelled、进度和结果 |
| DELETE | `/api/audio/jobs/<id>` | 请求取消任务 |
| GET | `/api/search/lyrics?q=…` | 搜索歌词候选，不自动入库 |
| GET | `/api/search/lyrics/<id>` | 获取选定歌词版本 |
| GET | `/api/search/lyrics/<id>/download?format=txt` | 下载 TXT，或 `format=lrc` |
| GET | `/api/search/audio?q=…` | 搜索符合许可要求的音频 |
| GET | `/api/search/audio/download?id=File:…` | 复核来源后下载音频 |

文本 JSON 请求仍限 2 MiB；文件上传请求总大小上限 32 MiB。写入曲库沿用原有 `/api/add_song`。`/api/health` 同时返回音频及各情感模型的就绪状态。

## 验证与未证明的能力

- 原创中文、韩文、英文短句经本机 TTS 生成，再使用真实模型转写；三条识别字符与原文一致（忽略标点和空格），静音没有生成歌词。这是小型**语音集成冒烟**，不是唱歌准确率测量。十一种音频扩展名的真实解码均验证通过。
- 另以 Wikimedia Commons 公有领域录音 [Arirang.ogg](https://commons.wikimedia.org/wiki/File:Arirang.ogg) 开头 20 秒进行真实演唱转写，指定韩文后输出“아리랑 아리랑 아라리오”，该次本机推理耗时约 7.02 秒。没有建立人工逐字参考，因此不计算唱词准确率；这条记录只验证该演唱样本可完成识别，不能推及其他歌曲、伴奏条件或整首歌。
- 预先冻结 33 条原创多维情绪样本：每语种十条情绪样本和一条无情绪诊断。top1 与作者标注一致数为中文 6/10、韩文 8/10、英文 10/10；top3 包含标注为 9/10、9/10、10/10。三条无情绪文本均未显示主导情绪。中韩“失败后仍然相信未来”的希望样本有漏判，报告保留所有失败。
- 上述集合很小且人工撰写，不能作为真实歌词泛化准确率。正负模型沿用 2.1 的验证记录，参见 [MODELS.md](MODELS.md)。

```bash
python -m unittest discover -s tests -v
python scripts/evaluate_emotions.py --output work/emotion-evaluation.json
python scripts/evaluate_sentiment.py --outputjson work/sentiment-evaluation.json
node --check frontend/js/app.js
node --check frontend/js/media.js
```
