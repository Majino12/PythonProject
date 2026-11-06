短发角色头发归属：离线来源与重建记录

本目录是 v0.20 的模型提示与有界修正证据。所有结果仍为 derived-candidate；像素验证、来源登记、模型自评分均不代表人工绘稿批准，也不证明语义边界没有误差。

文件
- manifest.json：官方 SAM2 来源、权重 SHA-256、源码 commit、许可证及九姿态输入索引。
- {pose}-prompt.json：每张原图独立点选的正/负提示；不是镜像搬运正面坐标。
- {pose}-refinement.json：来源原图/alpha 的 hash、保护多边形、阈值、选定 proposal、最终二值像素 hash。
- {pose}-report.json：模型原始自评分、基础修正与各姿态 v2 修正的数值结果。
- proposals/{pose}.png：原 SAM2.1 Large candidate 2 的二值输出，共约 83KB，仅用于验证细化，不是另一个运行素材。
- SAM2-LICENSE.txt：固定源码版本的 Apache-2.0 许可。
- environment.json：实际作者环境记录，不是已验证的全新环境安装锁文件。
- 最终 wholeHair 数值掩膜在 ../{pose}-hairOwnership.png，本目录不重复保存。
- 各姿态 v2 使用的完整生成露肤参考在 ../build-inputs/{pose}-underpaint.png；它们是生成候选，不是完整裸脸批准稿。运行时裁到 W 支持区的 ../{pose}-underpaint.png 不能替代此重建输入。

模型选择
官方项目：https://github.com/facebookresearch/sam2
固定提交：2b90b9f5ceec907a1c18123530e92e794ad901a4
官方权重：https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_large.pt
SHA-256：2647878d5dfa5098f2f8649825738a9345572bae2d4350a2468587ece47dd318
权重约898MB，不放入本项目，不在运行网页下载或推理。
先比较 Tiny 与 Large，并以官方 truck 样例检查原生 uint8 RGB、唯一归一化及坐标缩放。Large 稀疏点提示比 Tiny 更完整，因此采用 Large。自评分仅是模型估计，没有标注像素真值，不可当作实测准确率。

重建方式（从项目根目录执行）
1. 只重算有界修正，不运行模型：
   python tools/segment-short-hair.py --mode proposals --output work/segmentation-reproduced
   此模式从已归档的模型二值 proposal 起步，逐姿态核对源 hash、眉眼保护、alpha 与最终二值像素 hash。不能把它称为单图模型自动生成。
2. 真正重新运行官方 SAM2，再修正：
   python tools/segment-short-hair.py --mode sam --sam2-source /path/to/sam2 --checkpoint /path/to/sam2.1_hiera_large.pt --output work/segmentation-inferred
   sam2-source 必须是上述官方固定 commit，sam2/ 下不能有已跟踪文件改动。脚本核对源码 commit、官方配置和权重 hash，并使用 CPU float32、8线程、model.eval、官方 predictor，关闭 CUDA 后处理扩展。原生 uint8 RGB 交给官方预处理；原图坐标只由 predictor 缩放一次。
   可加 --pose front 或其他姿态名只运行一张。

需要先自行准备 Python、NumPy、Pillow、OpenCV；sam 模式还需与官方要求相符的 PyTorch/Torchvision、Hydra、iopath、SAM2 源码依赖。脚本不自动安装或下载。官方安装说明：https://github.com/facebookresearch/sam2/blob/2b90b9f5ceec907a1c18123530e92e794ad901a4/INSTALL.md
作者复用的环境与某些包声明的 NumPy 约束不完全一致，详见 environment.json。全新环境、其他硬件/版本不承诺位级相同，必须以输出 reproduction-report.json 的 canonical binary pixel SHA 验证，而不是只看运行结束或 PNG 文件 hash。PNG 编码器差异可能改变文件 hash；canonical hash 使用逐像素 0/1 uint8、行优先字节。

修正规则
基础版只在 SAM 周边12px按原图蓝灰色特征补足，排除独立描定的可见眉段、各姿态登记眼裂与外alpha；眉段减掉原登记的前发交叉排除区，只填不碰保护区的<=32px小孔。
全部姿态 v2 保留基础版结果，再限原 SAM 32px、已生成露肤支持和明显原图差异：B-R>=0/B-G>=8 为冷灰核心；仅1px相邻抗锯齿边可放宽到 B-R>=-12/B-G>=4。暖接触投影归独立 contact residual，不靠粗膨胀头发归属吞入。完整参数与保护多边形在 recipe 中。
脚本只输出比较候选，禁止直接把 --output 指向 assets。先比较、验证，再由材料构建脚本生成前发、W、补画支持和绑定；本工具不生成新画稿，不划分完整前后发，不负责隐藏补画/网格/运行图层艺术验收。

局部真发尖修正：除上述全局32px规则，另在 reviewed-local-tip-inclusions.json 记录其余8方向独立目视的23个窄多边形。只在这些原稿真发尖走向内，允许旧AA色域 B-R>=-12/B-G>=4 作为已审阅局部tip-core；U肤色、原眉眼保护、外alpha和原图变化门槛仍生效，未扩大任何全局色域/半径。v020_audit 已独立看完8张新增局部，未见扩入暖红投影或粉肤色，相邻细丝保持独立。极淡暖混色由同一网格上的contact residual承担，不强行归入不透明头发。

本次实际验证：proposals 模式与 sam 真推理模式均已运行全部9姿态；每张原始proposal、基础修正、最终canonical二值像素hash均一致，眉眼保护与外alpha误归0。结果在项目 validation/v0.20-segmentation-reproduction.json。此结论仅限记录环境和数值重建，不是新的语义准确率或绘稿批准。
