# 中文与韩文情感模型

2.1 使用两个专用二分类 Transformer，在本机 CPU 上推理。英文仍使用 TextBlob 和基础词典。本项目不把评论领域指标宣传成歌词准确率。

## 模型来源与版本

| 语言 | 模型 | 固定 revision | 许可证 |
| --- | --- | --- | --- |
| 中文 | [IDEA-CCNL/Erlangshen-Roberta-110M-Sentiment](https://huggingface.co/IDEA-CCNL/Erlangshen-Roberta-110M-Sentiment) | `6845a34e9284761a0f17e062e2a810dde992a214` | Apache-2.0 |
| 韩文 | [Copycats/koelectra-base-v3-generalized-sentiment-analysis](https://huggingface.co/Copycats/koelectra-base-v3-generalized-sentiment-analysis) | `370f325ce11aabd837b89bfb3ffdc26fde354689` | Apache-2.0 |

中文权重选用原模型仓库中 Hugging Face `SFconvertbot` 提交的 [safetensors 转换 PR #3](https://huggingface.co/IDEA-CCNL/Erlangshen-Roberta-110M-Sentiment/discussions/3)，不是已合入 main 的版本。PR 声明为原 `.bin` 的等价转换；项目锁定转换提交并仅加载 safetensors，不执行仓库自定义代码。中文原 main revision 为 `7c257c5cde3225d0789acfa8d67eb043289b0295`。

两者标签方向均为 `0=negative`、`1=positive`。中文见[作者文档](https://fengshenbang-doc.readthedocs.io/zh/latest/docs/%E4%BA%8C%E9%83%8E%E7%A5%9E%E7%B3%BB%E5%88%97/Erlangshen-Roberta-110M-Sentiment.html)；韩文见[作者训练仓库](https://github.com/jaehyeongAN/KoELECTRA-finetuned-sentiment-analysis)。中文作者使用八个中文情感数据集，韩文作者使用购物、电影、游戏评论，均非歌词专项训练。许可证和上游模型说明见上述仓库，权重不随 Git 仓库分发。

## 安装与本地推理

```bash
python -m pip install -r backend/requirements.txt -r backend/requirements-models.txt
python scripts/setup_models.py                 # 两种模型，权重约 861 MB
python scripts/setup_models.py --language zh   # 也可单独安装
python run.py
```

建议 Python 3.11–3.13、至少 8 GB 内存。已在 macOS arm64 / Python 3.12 / PyTorch 2.9.1 / Transformers 4.57.6 上验证。第一次分析需要加载权重，会比后续请求慢；两种模型共用进程缓存，最多 4 个 CPU 推理线程、批次最多 8 个片段。

默认目录 `data/models/{zh,ko}/`。可用 `YINYUE_MODEL_DIR` 或安装脚本 `--model-dir` 指定；二者需指向同一位置。安装脚本从固定 revision 下载允许清单内的文件，完成后写入包含大小和 SHA-256 的 manifest；推理首次加载校验文件。安装中断后重新运行即可复用下载。

Web 请求不会下载模型；加载显式设置 `local_files_only=True`、`trust_remote_code=False` 和 `use_safetensors=True`。歌词不发送至 Hugging Face。`/api/health` 返回文件和依赖就绪状态；实际加载错误也会记录在状态中。修复模型或依赖后重启服务。

新歌词在模型缺失时仍可使用明确标识的基础词典回退。已有歌曲点击“重新分析”遇到模型失败会返回 503 并保留原有分析，避免将已有模型结果覆盖成回退结果。

## 分数含义

- 模型输出只有正、负概率；整体极性为 `P(positive) − P(negative)`，范围 -1 到 1。
- 最大概率低于 0.65 时显示“倾向不明确”。这是保守的界面规则，**不是经歌词校准的置信阈值，也不是中性类别**。两个模型都可能把中性陈述自信地判成正面；高置信不保证正确。
- 过长歌词分为不超过模型窗口的 token 片段，按有效 token 数加权汇总；覆盖全文，但块与块之间没有注意力上下文。
- 逐行预测独立于全文预测。中、韩分行混写时按语言分别计算，再按字符长度汇总；含英文独立行时纳入原英文分析。跨语言汇总不是校准概率，因此不显示伪造的整体置信度。
- 同一行同时含中文和韩文时采用基础方法，明确说明覆盖局限；含假名的日文不会当作中文。同行英文借词保留在中韩模型输入中。
- 跨语言汇总绝对极性不超过 0.3 时显示“倾向不明确”；若模型行中同时出现明确正、负判断则显示“混合情绪”。这仍是展示规则。
- 词数和高频词采用旧有简单切分；不是模型可解释性证据。推荐向量的整体极性使用新分析值，历史未重新分析的记录继续保留旧值。

## 真实模型验证（2026-10-19）

在首次试跑前冻结了 32 条原创短句，文件为 `tests/fixtures/sentiment_examples.json`，SHA-256 为 `7e332260dbb0f8264b6848b12c962a3a338c6d5234a2365c72cbb88791f3e07b`。每种语言 7 正、7 负、1 中性、1 模糊/混合。样本刻意针对词典的漏词、否定、转折和含蓄表达，不是抽样基准；下面是与样本作者预期的一致数，**不是通用准确率**。

| 原创正负案例 | 旧词典一致数 | 新模型一致数 | 新模型倾向不明确 | 模型不可用 |
| --- | ---: | ---: | ---: | ---: |
| 中文 14 条 | 2 | 10 | 2 | 0 |
| 韩文 14 条 | 0 | 9 | 1 | 0 |

中性和模糊案例未加入上表：两种模型均把各自的中性句判为正面；中文模糊句为倾向不明确，韩文模糊句为正面。含蓄负面表达仍有明确误判，完整报告保留全部错例，不调整样本或阈值以提高这个集合的分数。

```bash
python scripts/evaluate_sentiment.py --outputjson work/sentiment-evaluation.json
```

输出包含每条预期、旧词典及新模型预测、置信度、模型版本和局限。任何模型回退或推理异常都会非零退出。CI 使用模拟模型检查语言路由、长文不截断、分块加权、离线加载、概率边界、回退和数据库行为；真实权重验证需另行安装并执行上述命令。
