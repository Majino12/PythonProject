from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import logging
import os
from lyric_analyzer import analyzer
from crawler import crawler
from database import db
from config import Config

# 配置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)


# --- 核心：爬虫+自动分析+自动入库 ---
@app.route('/api/professional/crawl', methods=['POST'])
def crawl_and_analyze():
    try:
        data = request.get_json()
        artist = data.get('artist', '')
        title = data.get('title', '')

        if not artist or not title:
            return jsonify({"error": "Missing artist or title"}), 400

        # 1. 爬取
        result = crawler.crawl_song(artist, title)

        # 2. 分析并入库
        if result.get('status') == 'success' and result.get('lyrics'):
            try:
                analysis = analyzer.analyze_lyrics_comprehensive(result['lyrics'])
                vec = analyzer.create_emotion_vector(analysis)

                song_data = {
                    'title': result['title'],
                    'artist': result['artist'],
                    'lyrics': result['lyrics'],
                    'genre': 'Pop',
                    'year': 2023
                }

                song_id = db.store_crawled_song_with_analysis(song_data, analysis, vec)

                result['db_saved'] = True
                result['song_id'] = song_id
                result['sentiment'] = analysis.get('consensus_sentiment', 'Neutral')
                result['analysis'] = analysis  # 返回分析详情供前端直接显示
                logger.info(f"✅ Processed: {title}")
            except Exception as inner_e:
                logger.error(f"Analysis failed: {inner_e}")
                result['sentiment'] = 'Analysis Failed'

        return jsonify(result)
    except Exception as e:
        logger.error(f"Crawl error: {e}")
        return jsonify({"error": str(e)}), 500


@app.route('/api/professional/crawl_batch', methods=['POST'])
def crawl_batch():
    try:
        songs = request.get_json().get('songs', [])
        results = []
        for song in songs:
            crawl_res = crawler.crawl_song(song['artist'], song['title'])
            if crawl_res.get('status') == 'success':
                analysis = analyzer.analyze_lyrics_comprehensive(crawl_res['lyrics'])
                vec = analyzer.create_emotion_vector(analysis)
                db.store_crawled_song_with_analysis(crawl_res, analysis, vec)
                crawl_res['saved'] = True
            results.append(crawl_res)
        return jsonify({"crawled_songs": results})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# --- 推荐与查询 ---
@app.route('/api/recommend', methods=['POST'])
def recommend():
    try:
        data = request.get_json()
        target = data.get('target_song')
        library = analyzer.analyze_song_library()

        if target not in library:
            return jsonify({"error": "Song not found"}), 404

        recs = analyzer.find_similar_songs(target, library)
        formatted = []
        for r in recs:
            formatted.append({
                "title": r[0],
                "similarity": r[1],
                "genre": r[2],
                "artist": r[3]
            })
        return jsonify({"recommendations": formatted})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/library', methods=['GET'])
def get_library():
    try:
        songs = db.get_all_songs_with_analysis()
        for s in songs:
            if s.get('analysis'):
                s['sentiment'] = s['analysis'].get('consensus_sentiment', 'Analyzed')
            else:
                s['sentiment'] = 'No analysis'
        return jsonify({"songs": songs, "total": len(songs)})
    except Exception as e:
        return jsonify({"songs": [], "error": str(e)})


@app.route('/api/stats', methods=['GET'])
def get_stats():
    return jsonify(db.get_analysis_stats())


@app.route('/api/add_song', methods=['POST'])
def add_manual_song():
    """手动添加歌曲接口 - 修复版：直接返回分析结果"""
    try:
        data = request.get_json()
        title = data.get('title')
        artist = data.get('artist')
        lyrics = data.get('lyrics')

        if not title or not lyrics:
            return jsonify({"error": "Missing fields"}), 400

        # 1. 执行分析
        analysis = analyzer.analyze_lyrics_comprehensive(lyrics)
        vec = analyzer.create_emotion_vector(analysis)

        # 2. 存入数据库
        song_data = {'title': title, 'artist': artist, 'lyrics': lyrics, 'genre': 'Manual', 'year': None}
        db.store_crawled_song_with_analysis(song_data, analysis, vec)

        # 3. 关键修改：直接返回分析数据给前端，不要让前端去猜
        sentiment = analysis.get('consensus_sentiment', 'Neutral')

        return jsonify({
            "success": True,
            "title": title,
            "artist": artist,
            "sentiment": sentiment,
            "analysis": analysis  # 直接返回详细数据对象
        })
    except Exception as e:
        logger.error(f"Add song error: {e}")
        return jsonify({"error": str(e)}), 500


# --- 静态文件 ---
@app.route('/')
def index():
    return send_from_directory('../frontend', 'index.html')


@app.route('/<path:path>')
def static_files(path):
    return send_from_directory('../frontend', path)


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5002, debug=Config.DEBUG)