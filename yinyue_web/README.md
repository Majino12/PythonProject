
lyric-emotion-analyzer-2025/ 

├── run.py                    시작 진입점 

├── backend/                  백엔드 로직 

│   ├── app.py                라우팅 컨트롤러 

│   ├── database.py           데이터베이스 접근 계층 (DAO) 

│   ├── crawler.py            데이터 수집 계층 

│   ├── lyric_analyzer.py     핵심 알고리즘 계층 (RoBERTa + VADER) 

│   └── requirements.txt      의존성 관리 

├── frontend/                 프론트엔드 리소스 

│   ├── index.html            뷰 템플릿 

│   ├── css/style.css         스타일 정의 

│   └── js/app.js             상호작용 로직 

└── data/                     영속적 저장소 

    └── songs.db              데이터베이스 파일 