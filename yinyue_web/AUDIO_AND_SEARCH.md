# 音乐分析、识词、情绪画像与在线搜索（2.3）

## 直接分析音乐并获取修改建议

“音乐分析”默认只处理音频，不需要歌词，也不需要安装 Whisper。上传旋律、伴奏或完整歌曲后，选择创作方向：保持原风格、更加明亮振奋、更加平静舒缓、更加暗沉紧张。报告包含音乐情绪描述、可测量特征、分段能量变化、编曲建议和旋律建议。每条建议列出当前音频依据、可尝试的修改与预期听感；这些是创作实验建议，不会改写原音频，也不生成新编曲或乐谱。

模式支持“只分析音乐”“音乐分析并尝试识词”“只识别歌词”。同时分析时先完成音乐报告，再尝试歌词识别；识词缺失或失败仍保留音乐报告。默认仅分析音乐可避免纯音乐被语音模型误识别为歌词。需要识词时由用户选择对应模式，输出仍须试听校对，不能据此自动断言有无演唱。

音乐报告可导出 JSON；目前与音频任务一起在服务内保留一小时，重启后消失，不会自动写入歌词曲库。要长期保留请导出报告；原始音频只临时处理，完成后清除服务器副本。

### 音乐音频模型与可解释特征

- 音乐模型：[LAION clap-htsat-unfused](https://huggingface.co/laion/clap-htsat-unfused)，Apache-2.0，使用原仓库 [safetensors 转换](https://huggingface.co/laion/clap-htsat-unfused/discussions/3)，固定 revision `79b58ed25fc00386262a2bea4b19fd21dc4310a0`，权重约 615 MB。显式下载时核对 SHA-256；运行时只读取本地 safetensors，不执行远程代码。
- 音频 CLAP 是通用音频语义模型，未做本项目的音乐情绪专项微调；根据实际音频与欢快、平静、忧伤、紧张、活力、温柔浪漫、梦幻、激烈八组描述的余弦相似度排序；每组使用三种描述的平均表征。无需歌词，也不是歌词语义或说话人情绪分类。分数不是情绪概率、强度或准确率；模型没有针对本项目的歌曲和个人听感做校准。
- 最多比较四个均匀分布的十秒片段，显示实际时间范围及覆盖比例。不足三秒、静音不提供模型情绪结果；短于十秒的片段会提示上下文有限。用于分析的音频解码为 16 kHz 单声道，输入 CLAP 时重采样至其要求的 48 kHz；不会还原 8 kHz 以上的原始细节。
- 可解释信号分析提供估计节奏、响度/动态、频谱亮度、低频和音高线索。节拍可能存在倍速/半速歧义；音高是混音中的主导周期线索，不能当作已分离的人声、准确主旋律、和弦或调式。对缺少证据的特征显示不足，不凭空补齐。
- 音频 CLAP 不可用时继续显示信号特征及明确标注的规则情绪线索。规则倾向同样不是训练得到的准确率，也不能把大调/速度/响度单独等同于某种确定情绪。建议的依据来自可测量特征，音乐模型排序只供听感比较。

这些结果是分析与创作辅助。动态指输入文件的数值变化，不是经校准的播放声压；音量变化也不能单独证明情绪变化。复调、失真、打击乐和人声叠加会削弱主导音高解释。

## 使用流程

1. 打开“音乐分析”，选择本机音频和识词模式。支持 MP3、WAV、M4A、FLAC、OGG/OGA、Opus、AAC、AIFF/AIF、WebM，单个文件最多 30 MiB、10 分钟。
2. 选择自动检测或指定中文、韩文、英文。开始后显示后台任务状态和按已识别时间计算的进度，可以取消；取消会在当前模型片段结束后生效。CPU 转写可能比音频本身更长，进度不是时间保证。
3. 播放原音频并校对识别文字，再导入分析工作台保存。可导出校对后的 TXT；非空歌词行数仍与识别片段数一致时，也可导出带段落时间戳的 LRC。时间戳沿用模型估计，并非人工对齐；修改行数后需另行调整时间点。
4. 输入已知歌名和歌手，可搜索发布的歌词版本供校正。确认对应歌手、专辑和版本后再导入，避免同名歌曲误匹配。
5. 分析结果保留原有正负倾向，新增喜悦、悲伤、愤怒、恐惧、爱恋、思念、希望、平静、孤独、怀旧十类情绪画像。

上传的音频只在本机临时处理，任务结束、失败或取消后删除服务器临时副本；不会删除用户选择的原文件。转写任务结果在进程内保留一小时，页面刷新可恢复尚未过期的任务，重启服务后任务消失。转写不会直接写入曲库，确认并分析后才保存歌词。单进程同时执行一个转写任务，最多另有一个等待任务。

同一浏览器标签页刷新后，已完成任务的校对文字、歌名和歌手草稿也会恢复，前提是浏览器会话存储可用。重新选择同一原音频即可恢复播放和逐段试听，无需重新识别，也不会覆盖校对草稿。文件名、大小或修改时间不同会被视为新音频，并开始新的工作草稿。刷新后需再次勾选校对确认；会话草稿不代替下载 TXT 或保存到曲库。

## 安装

```bash
python install_dependencies.py --with-models --with-audio --with-music
python scripts/setup_models.py
python scripts/setup_emotion_model.py
python scripts/setup_audio_model.py
python scripts/setup_music_mood.py
python run.py
```

现有 2.2 用户无需重复安装原模型；安装 `backend/requirements-music.txt` 并运行 `scripts/setup_music_mood.py` 即可新增音乐分析。仅需声学特征与规则建议时，无需下载 CLAP，也无需 Whisper。完整安装模型权重约 3.6 GB，建议至少 16 GB 内存。首次模型加载较慢，后续进程内复用。已在 macOS arm64 / Python 3.12 验证，当前音频依赖的 macOS arm64 wheels 需要 macOS 14 或更新版本。CI 使用真实合成信号验证特征及模拟模型验证接口，覆盖 Python 3.11–3.13，不会自动下载权重。

`YINYUE_MODEL_DIR` 指定统一模型根目录：`zh/`、`ko/`、`emotion/`、`audio/`、`music_mood/`。单独运行安装脚本时也可设置 `YINYUE_AUDIO_MODEL_DIR`、`YINYUE_EMOTION_MODEL_DIR` 或 `YINYUE_MUSIC_MOOD_MODEL_DIR`；Web 服务统一使用 `YINYUE_MODEL_DIR` 下对应子目录。关闭歌词多维情绪模型可设置 `YINYUE_EMOTIONS_ENABLED=false`，关闭 音频 CLAP 可设置 `YINYUE_MUSIC_MOOD_ENABLED=false`。缺少 Whisper 时仅识词请求返回 503，音乐分析仍可运行；缺少音乐依赖时音乐模式返回 503；缺少 音频 CLAP 时明确使用声学特征与规则线索，不冒充模型结果。

## 音频模型与边界

- 原模型：[OpenAI Whisper large-v3-turbo](https://huggingface.co/openai/whisper-large-v3-turbo)，809M 参数、多语、MIT。
- 运行权重：[dropbox-dash/faster-whisper-large-v3-turbo](https://huggingface.co/dropbox-dash/faster-whisper-large-v3-turbo)，固定 revision `0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf`。
- 引擎：[faster-whisper](https://github.com/SYSTRAN/faster-whisper) 1.2.1、CTranslate2 4.8.3，CPU int8，最多四线程；PyAV 解码为 16 kHz 单声道，无需额外安装 ffmpeg 命令。Python 3.12+ 使用 PyAV 19.0.1；Python 3.11 使用兼容的 [PyAV 18.1.0](https://pypi.org/project/av/18.1.0/)，由依赖文件自动选择。
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
| GET | `/api/audio/status` | 识词状态与独立的 `music` 分析状态 |
| POST | `/api/audio/jobs` | multipart `file`、`language=auto/zh/ko/en`、`mode=music/combined/transcribe`、`goal=preserve/uplifting/calmer/darker`，202 返回 job |
| GET | `/api/audio/jobs/<id>` | queued/running/cancelling/completed/failed/cancelled、进度和结果 |
| DELETE | `/api/audio/jobs/<id>` | 请求取消任务 |
| GET | `/api/search/lyrics?q=…` | 搜索歌词候选，不自动入库 |
| GET | `/api/search/lyrics/<id>` | 获取选定歌词版本 |
| GET | `/api/search/lyrics/<id>/download?format=txt` | 下载 TXT，或 `format=lrc` |
| GET | `/api/search/audio?q=…` | 搜索符合许可要求的音频 |
| GET | `/api/search/audio/download?id=File:…` | 复核来源后下载音频 |

文本 JSON 请求仍限 2 MiB；文件上传请求总大小上限 32 MiB。写入曲库沿用原有 `/api/add_song`。`/api/health` 同时返回音频及各情感模型的就绪状态。

API 未提供 `mode` 时保留 2.2 的仅识词行为；新版界面明确提交 `mode=music` 作为默认。任务结果在原识词字段之外增加 `mode`、`music_analysis`（音乐/组合模式）与 `transcription_status`，后者区分 `skipped/completed/unavailable/failed`。取消是整项任务取消，不发布部分结果。

## 验证与未证明的能力

- 2.3 对原创无歌词旋律进行了真实端到端测试：72 / 144 BPM 两段分别估计为 72 / 144 BPM，并按不同创作目标输出编曲与旋律建议；8 秒静音与 0.4 秒短音不输出情绪、节拍或修改建议。公有领域 Arirang 片段的组合模式同时返回音乐报告和韩文识词。报告字段全部可序列化为严格 JSON。
- 音频 CLAP 真实语义冒烟中，原创器乐对“器乐”描述的相似度高于“犬吠”，演唱片段对“演唱”高于“器乐”；这只验证跨模态语义区分，没有证明音乐情绪准确率。两首不同速度的合成旋律均可能接近忧伤/平静，故不以文件名或速度为情绪真值，也不宣传某个准确率。初始化同时检查权重加载完整性与文本向量退化，失败时保留特征分析并明确停用模型分数。
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
