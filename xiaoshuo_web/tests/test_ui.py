"""Visible reporting guarantees: complete chapter lists, honest modes, safe text."""
import re
import tempfile
import unittest
from flask import render_template
from app import create_app


class ReportModels:
    configured = False
    def describe(self):
        return {"configured": False, "models": {}, "stages": {}}


class ReportRenderingTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.app = create_app({"TESTING": True, "DATA_DIR": self.directory.name}, model_client=ReportModels())

    def tearDown(self):
        self.app.extensions["novel_jobs"].shutdown()
        self.directory.cleanup()

    def render(self, template, result):
        with self.app.test_request_context():
            return render_template(template, result=result)

    def test_entire_chapter_list_and_final_evidence_in_screen_and_export(self):
        result = {
            "novel_info": {"title": "Long novel", "total_chapters": 205, "total_length": 20500},
            "hierarchical_summary": {
                "overall_summary": "Includes ending",
                "overall_evidence_ids": ["ending"],
                "chapter_summaries": [{"chapter_number": index, "title": f"Chapter {index}", "summary": f"Unique chapter marker {index}", "evidence_ids": ["ending"] if index == 205 else []} for index in range(1, 206)]},
            "analysis_metadata": {"mode": "model", "status": "complete", "total_chunks": 205, "processed_chunks": 205, "coverage_ratio": 1},
            "evidence": [{"id": "ending", "chapter": 205, "quote": "The ending remains visible.", "start": 20470, "end": 20497}],
        }
        for template in ("result.html", "export_report.html"):
            html = self.render(template, result)
            self.assertEqual(html.count('class="chapter-entry"'), 205)
            self.assertIn("Unique chapter marker 205", html)
            self.assertIn('href="#evidence-ending"', html)
            self.assertIn('id="evidence-ending"', html)
            self.assertIn("The ending remains visible.", html)
            self.assertIn("100.0%", html)
            self.assertIn("不表示结论准确率", html)

    def test_atomic_summary_statements_keep_their_own_citations(self):
        hostile = '<img src=x onerror="alert(1)">'
        result = {
            "hierarchical_summary": {
                "overall_summary": "Do not render the combined summary twice.",
                "overall_evidence_ids": ["wrong-global-reference"],
                "overall_summary_statements": [
                    {"text": "First supported statement", "evidence_ids": ["first-source"]},
                    {"text": hostile, "evidence_ids": ["second-source"]},
                ],
                "chapter_summaries": [{"chapter_number": 1, "title": "Chapter one",
                    "summary": "Do not render the combined chapter twice.",
                    "evidence_ids": ["wrong-chapter-reference"],
                    "summary_statements": [{"text": "Chapter fact", "evidence_ids": ["chapter-source"]}]}],
            },
            "chunk_analyses": [{"chunk_id": "chunk-1", "chapter": 1,
                "summary": "Do not render the combined chunk twice.", "summary_method": "model",
                "evidence_ids": ["wrong-chunk-reference"],
                "summary_statements": [{"text": "Chunk fact", "evidence_ids": ["chunk-source"]}]}],
        }
        for template in ("result.html", "export_report.html"):
            html = self.render(template, result)
            statements = re.findall(r'<div class="summary-statement mb-3">(.*?)</div>', html, re.S)
            self.assertEqual(len(statements), 4)
            for statement, expected_id in zip(statements, ["first-source", "second-source", "chapter-source", "chunk-source"]):
                self.assertEqual(re.findall(r'href="#evidence-([^"]+)"', statement), [expected_id])
            self.assertNotIn("Do not render", html)
            self.assertNotIn("wrong-global-reference", html)
            self.assertNotIn("wrong-chapter-reference", html)
            self.assertNotIn("wrong-chunk-reference", html)
            self.assertNotIn(hostile, html)
            self.assertIn("&lt;img", html)

    def test_empty_statement_lists_preserve_legacy_and_baseline_summary(self):
        result = {"analysis_metadata": {"mode": "baseline", "status": "complete"},
                  "hierarchical_summary": {"overall_summary": "Original excerpt overview", "overall_summary_statements": [],
                      "overall_evidence_ids": ["overview-source"],
                      "chapter_summaries": [{"chapter_number": 1, "summary": "Original chapter excerpt", "summary_statements": [], "evidence_ids": ["chapter-source"]}]}}
        for template in ("result.html", "export_report.html"):
            html = self.render(template, result)
            self.assertIn("Original excerpt overview", html)
            self.assertIn("Original chapter excerpt", html)
            self.assertIn('href="#evidence-overview-source"', html)
            self.assertIn('href="#evidence-chapter-source"', html)
            self.assertIn("未进行模型语义分析", html)

    def test_source_and_model_text_cannot_inject_markup(self):
        hostile = '<img src=x onerror="alert(1)">'
        result = {"novel_info": {"title": hostile}, "hierarchical_summary": {"overall_summary": hostile},
                  "character_analysis": {"main_characters": [{"name": hostile, "description": hostile}]},
                  "theme_analysis": [{"theme": hostile, "explanation": hostile}],
                  "evidence": [{"id": "quote", "quote": hostile, "context_before": hostile, "context_after": hostile}], "source": hostile}
        for template in ("result.html", "export_report.html"):
            html = self.render(template, result)
            self.assertNotIn(hostile, html)
            self.assertIn("&lt;img", html)

    def test_partial_and_baseline_are_not_presented_as_semantic_success(self):
        partial = {"analysis_metadata": {"mode": "model", "status": "partial", "coverage_ratio": .5, "failed_chunks": ["chunk-2"], "warnings": ["Verifier unavailable"]}}
        for template in ("result.html", "export_report.html"):
            html = self.render(template, partial)
            self.assertIn("部分完成", html)
            self.assertIn("50.0%", html)
            self.assertIn("Verifier unavailable", html)
            baseline = self.render(template, {"analysis_metadata": {"mode": "baseline", "status": "complete", "coverage_ratio": 1}})
            self.assertIn("未进行模型语义分析", baseline)
            self.assertIn("没有经过核对的人物结论", baseline)

    def test_model_duration_explains_possible_cache_without_inventing_hits(self):
        result = {"duration": "0.008s", "analysis_metadata": {"mode": "model", "status": "complete"}}
        for template in ("result.html", "export_report.html"):
            html = self.render(template, result)
            self.assertIn("耗时 0.008s", html)
            self.assertIn("耗时为本次运行时间，可能复用缓存；首次推理可能更久。", html)
            self.assertNotIn("本次缓存复用", html)
            self.assertNotIn("客户端调用", html)
            baseline = self.render(template, {"duration": "0.008s", "analysis_metadata": {"mode": "baseline", "status": "complete"}})
            self.assertNotIn("首次推理可能更久", baseline)

    def test_cache_and_model_call_counts_are_shown_only_when_recorded(self):
        result = {"duration": "0.008s", "analysis_metadata": {"mode": "model", "status": "complete", "cache_hits": 11, "model_calls": 2}}
        for template in ("result.html", "export_report.html"):
            html = self.render(template, result)
            self.assertIn("本次缓存复用 11 次。", html)
            self.assertIn("客户端调用 2 次（含缓存及失败）。", html)
            self.assertNotIn("本次模型调用", html)

    def test_old_and_empty_reports_remain_readable(self):
        for result in ({}, {"novel_info": {"title": "Legacy novel"}, "themes": ["old keyword"]}):
            for template in ("result.html", "export_report.html"):
                html = self.render(template, result)
                self.assertIn("历史报告没有全文覆盖记录", html)
                self.assertIn("没有章节摘要记录", html)

    def test_upload_size_uses_server_config(self):
        self.app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024
        with self.app.test_request_context():
            html = render_template("index.html")
            self.assertIn('data-max-bytes="8388608"', html)
            self.assertIn("请求上限 8 MB", html)
            self.assertIn('minlength="100"', html)


if __name__ == "__main__":
    unittest.main()
