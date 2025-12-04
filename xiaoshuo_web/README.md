
# Keyword Analysis and Summarization System for Web Novel/News Texts(小说分析系统 / 웹 소설/뉴스 텍스트의 키워드 분석 및 요약 생성 시스템)


## 🇨🇳 中文说明

小说分析系统 是一个基于 Python 和 AI 技术（NLP/机器学习）构建的 Web 应用程序，旨在深度分析小说文本内容。它能够自动提取人物关系、绘制情感曲线、识别关键主题，并生成详细的可视化分析报告。

### 主要功能

  * **多模式输入**：支持直接文本粘贴、文件上传（.txt, .docx, .pdf）以及网页爬虫（自动抓取新闻或小说章节）。
  * **人物分析**：自动识别主要人物，计算出场频率，生成人物关系网络，并追踪人物发展曲线。
  * **情节结构**：通过情感分析绘制情节起伏曲线，识别开端、高潮和结尾。
  * **主题提取**：利用 KeyBERT 和 TF-IDF 算法提取文本核心主题和关键词。
  * **数据可视化**：提供丰富的交互式图表（Chart.js），包括词云、频率直方图和情感折线图。
  * **控制台监控**：实时监控系统资源（CPU/内存）和分析任务历史。
  * **多语言界面**：内置中文、英文、韩文三种语言界面切换。
  * **报告导出**：支持将分析结果导出为 PDF、HTML 或 JSON 格式。

### 技术栈

  * **后端**：Flask, NLTK, spaCy, scikit-learn, Sumy, KeyBERT, TextBlob
  * **前端**：Bootstrap 5, Chart.js, Toastify.js
  * **工具**：BeautifulSoup4 (爬虫), PDFPlumber (PDF解析)

### 快速开始


#### 1\. 安装依赖

```bash
pip install -r requirements.txt
```

#### 2\. 下载 NLP 模型

为了获得最佳的人物识别效果，建议下载 spaCy 的英文模型：

```bash
python -m spacy download en_core_web_sm
```

*(注：程序启动时也会自动检查并尝试下载 NLTK 数据)*

#### 4\. 启动应用

```bash
python run.py
```

系统会自动在浏览器中打开 `http://127.0.0.1:5003`。

### 📂 目录结构

```text
xiaoshuo_web/
│
├── app.py                  # [核心] Flask 后端入口，处理路由和 API
├── config.py               # [配置] 项目路径、密钥和文件上传限制配置
├── novel_analyzer.py       # [核心] 自然语言处理、爬虫和文本分析逻辑
├── run.py                  # [启动] 自动化启动脚本 (检查依赖 + 打开浏览器)
├── requirements.txt        # [依赖] 项目所需的 Python 库列表
├── README.md               # [文档] 项目说明文档 (中/英/韩)
│
├── static/                 # [静态资源目录]
│   ├── css/
│   │   └── style.css       # 全局样式表 (包含深色模式适配)
│   │
│   ├── js/
│   │   ├── dashboard.js    # 控制台逻辑 (图表、系统监控)
│   │   ├── i18n.js         # 前端国际化处理核心逻辑
│   │   ├── script.js       # 通用交互逻辑 (文件验证、主题切换)
│   │   └── utils.js        # 工具函数 (时间格式化等)
│   │
│   ├── locales/            # [语言包目录]
│   │   ├── cn.json         # 中文翻译
│   │   ├── en.json         # 英文翻译
│   │   └── kr.json         # 韩文翻译
│   │
│   ├── results/            # [自动生成] 用于存储分析生成的 .json 结果文件
│   └── uploads/            # [自动生成] 用于存储用户上传的小说文件
│
└── templates/              # [HTML 模板目录]
    ├── base.html           # 基础布局 (导航栏、页脚、资源引用)
    ├── index.html          # 首页 (分析入口、表单、进度模态框)
    ├── dashboard.html      # 控制台 (统计数据、历史记录)
    ├── result.html         # 分析结果页 (图表展示、详细数据)
    ├── features.html       # 功能特色页
    ├── tutorial.html       # 使用教程页
    ├── about.html          # 关于页
    ├── error.html          # 错误提示页
    └── export_report.html  # 导出报告专用模板 (打印/下载用)
```

-----

## 🇺🇸 English Documentation

Keyword Analysis and Summarization System for Web Novel/News Texts is a web-based application built with Python and AI technologies (NLP/Machine Learning) designed for deep analysis of novel texts. It automatically extracts character relationships, plots sentiment arcs, identifies key themes, and generates detailed visual reports.

### Key Features

  * **Multi-Input Support**: Direct text input, file uploads (.txt, .docx, .pdf), and web crawling (News/Novel sites).
  * **Character Analysis**: Identifies main characters, calculates frequency, maps relationships, and tracks character development arcs.
  * **Plot Structure**: Visualizes the narrative arc through sentiment analysis (Exposition, Climax, Resolution).
  * **Theme Extraction**: Extracts core themes and keywords using KeyBERT and TF-IDF.
  * **Data Visualization**: Interactive charts via Chart.js, including word clouds and sentiment curves.
  * **Dashboard**: Real-time monitoring of system resources (CPU/RAM) and analysis history.
  * **Multi-Language UI**: Switch between English, Chinese, and Korean.
  * **Export**: Download reports in PDF, HTML, or JSON formats.

### Tech Stack

  * **Backend**: Flask, NLTK, spaCy, scikit-learn, Sumy, KeyBERT, TextBlob
  * **Frontend**: Bootstrap 5, Chart.js, Toastify.js
  * **Utilities**: BeautifulSoup4 (Crawler), PDFPlumber (PDF parsing)

### Quick Start



#### 1\. Install Dependencies

```bash
pip install -r requirements.txt
```

#### 2\. Download NLP Models

For the best character recognition results, install the spaCy English model:

```bash
python -m spacy download en_core_web_sm
```

*(Note: The app will also check and download NLTK data on startup)*

#### 3\. Run the Application

```bash
python run.py
```

The browser will automatically open `http://127.0.0.1:5003`.


### 📂 Directory structure

```text
xiaoshuo_web/
│
├── app.py                  # [Core] Flask backend entry, handles routing and API
├── config.py               # [Configuration] Project paths, secret keys, and file upload limits configuration
├── novel_analyzer.py       # [Core] Natural Language Processing, crawler, and text analysis logic
├── run.py                  # [Launch] Automation startup script (checks dependencies + opens browser)
├── requirements.txt        # [Dependencies] List of required Python libraries for the project
├── README.md               # [Documentation] Project documentation (in Chinese/English/Korean)
│
├── static/                 # [Static Resources Directory]
│   ├── css/
│   │   └── style.css       # Global stylesheet (includes dark mode adaptation)
│   │
│   ├── js/
│   │   ├── dashboard.js    # Console logic (charts, system monitoring)
│   │   ├── i18n.js         # Frontend internationalization core logic
│   │   ├── script.js       # General interaction logic (file validation, theme switching)
│   │   └── utils.js        # Utility functions (time formatting, etc.)
│   │
│   ├── locales/            # [Language Packs Directory]
│   │   ├── cn.json         # Chinese translations
│   │   ├── en.json         # English translations
│   │   └── kr.json         # Korean translations
│   │
│   ├── results/            # [Auto-generated] Stores analysis-generated .json result files
│   └── uploads/            # [Auto-generated] Stores user-uploaded novel files
│
└── templates/              # [HTML Templates Directory]
    ├── base.html           # Base layout (navigation bar, footer, resource references)
    ├── index.html          # Homepage (analysis entry, forms, progress modal)
    ├── dashboard.html      # Console (statistics, history log)
    ├── result.html         # Results page (chart display, detailed data)
    ├── features.html       # Features page
    ├── tutorial.html       # Tutorial page
    ├── about.html          # About page
    ├── error.html          # Error prompt page
    └── export_report.html  # Export report template (for printing/downloading)
```

-----

## 🇰🇷 한국어 설명

웹 소설/뉴스 텍스트의 키워드 분석 및 요약 생성 시스템 은 Python과 AI 기술(NLP/머신러닝)을 기반으로 구축된 웹 애플리케이션으로, 소설 텍스트를 심층적으로 분석합니다. 인물 관계 추출, 감정 곡선 시각화, 주요 주제 식별 및 상세 분석 보고서를 자동으로 생성합니다.

### 주요 기능

  * **다양한 입력 방식**: 텍스트 직접 입력, 파일 업로드(.txt, .docx, .pdf), 웹 크롤링(뉴스 또는 소설 사이트)을 지원합니다.
  * **인물 분석**: 주요 인물을 자동으로 식별하고 등장 빈도, 인물 관계도 및 인물 발전 과정을 추적합니다.
  * **플롯 구조**: 감정 분석을 통해 서사 구조(발단, 절정, 결말)를 시각화합니다.
  * **주제 추출**: KeyBERT 및 TF-IDF 알고리즘을 사용하여 핵심 주제와 키워드를 추출합니다.
  * **데이터 시각화**: Chart.js를 활용한 다양한 인터랙티브 차트 제공 (단어 구름, 감정 곡선 등).
  * **대시보드**: 시스템 리소스(CPU/메모리) 및 분석 기록을 실시간으로 모니터링합니다.
  * **다국어 인터페이스**: 한국어, 영어, 중국어 UI를 지원합니다.
  * **내보내기**: 분석 결과를 PDF, HTML 또는 JSON 형식으로 다운로드할 수 있습니다.

### 기술 스택

  * **백엔드**: Flask, NLTK, spaCy, scikit-learn, Sumy, KeyBERT, TextBlob
  * **프론트엔드**: Bootstrap 5, Chart.js, Toastify.js
  * **유틸리티**: BeautifulSoup4 (크롤러), PDFPlumber (PDF 파싱)

### 빠른 시작


#### 1\. 의존성 설치

```bash
pip install -r requirements.txt
```

#### 2\. NLP 모델 다운로드

정확한 인물 인식을 위해 spaCy 영어 모델을 설치하는 것을 권장합니다:

```bash
python -m spacy download en_core_web_sm
```

*(참고: 앱 실행 시 NLTK 데이터도 자동으로 확인하고 다운로드합니다)*

#### 3\. 애플리케이션 실행

```bash
python run.py
```

브라우저가 자동으로 열리며 `http://127.0.0.1:5003`에 접속됩니다.


### 📂 디렉토리 구조

```text
xiaoshuo_web/
│
├── app.py                  # [핵심] Flask 백엔드 진입점, 라우팅 및 API 처리
├── config.py               # [설정] 프로젝트 경로, 시크릿 키 및 파일 업로드 제한 설정
├── novel_analyzer.py       # [핵심] 자연어 처리, 크롤러 및 텍스트 분석 로직
├── run.py                  # [시작] 자동화 시작 스크립트 (의존성 확인 + 브라우저 열기)
├── requirements.txt        # [의존성] 프로젝트에 필요한 Python 라이브러리 목록
├── README.md               # [문서] 프로젝트 설명 문서 (중/영/한)
│
├── static/                 # [정적 리소스 디렉터리]
│   ├── css/
│   │   └── style.css       # 전역 스타일시트 (다크 모드 적용 포함)
│   │
│   ├── js/
│   │   ├── dashboard.js    # 콘솔 로직 (차트, 시스템 모니터링)
│   │   ├── i18n.js         # 프론트엔드 국제화 핵심 로직
│   │   ├── script.js       # 일반 상호작용 로직 (파일 검증, 테마 전환)
│   │   └── utils.js        # 유틸리티 함수 (시간 포맷팅 등)
│   │
│   ├── locales/            # [언어 패키지 디렉터리]
│   │   ├── cn.json         # 중국어 번역
│   │   ├── en.json         # 영어 번역
│   │   └── kr.json         # 한국어 번역
│   │
│   ├── results/            # [자동 생성] 분석으로 생성된 .json 결과 파일 저장
│   └── uploads/            # [자동 생성] 사용자 업로드 소설 파일 저장
│
└── templates/              # [HTML 템플릿 디렉터리]
    ├── base.html           # 기본 레이아웃 (네비게이션 바, 푸터, 리소스 참조)
    ├── index.html          # 홈페이지 (분석 시작점, 폼, 진행 모달창)
    ├── dashboard.html      # 콘솔 (통계 데이터, 기록)
    ├── result.html         # 결과 페이지 (차트 표시, 상세 데이터)
    ├── features.html       # 기능 소개 페이지
    ├── tutorial.html       # 사용 튜토리얼 페이지
    ├── about.html          # 프로젝트 소개 페이지
    ├── error.html          # 오류 안내 페이지
    └── export_report.html  # 보고서 내보내기 전용 템플릿 (인쇄/다운로드용)
```

-----