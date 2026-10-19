"""Deterministic regression tests; no external books, models or network calls."""
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from novel_analyzer import SimpleNovelAnalyzer, _AnalysisRun, split_chapters, split_chunks
from model_client import ModelClient, ModelError


class FakeModel:
    configured = True

    def __init__(self):
        self.calls = []

    def describe(self):
        return {"models": {"map": "fake-map", "reduce": "fake-reduce", "verify": "fake-verify"}}

    def generate_json(self, messages, role="map"):
        payload = json.loads(messages[-1]["content"])
        self.calls.append((role, payload, sum(len(message["content"]) for message in messages)))
        if role == "map":
            text = payload["text"].strip()
            sentences = [sentence for sentence in re.findall(r"[^。\n]+。?", text) if sentence.strip()]
            quote = sentences[-1][-200:]
            return {"summary": [{"text": quote, "quote": quote}], "events": [{"event": quote, "quote": quote}],
                    "characters": [{"name": "林青", "description": quote, "quote": quote}] if "林青" in quote else [],
                    "relationships": [], "themes": []}
        if role == "verify":
            return {"verdicts": [{"id": claim["id"], "supported": "不受支持" not in claim["text"]} for claim in payload["claims"]]}
        item = payload["items"][-1]
        return {"statements": [{"text": item["text"], "evidence_ids": item["evidence_ids"][:2]}]}


class OfflineModel(FakeModel):
    configured = False

    def generate_json(self, messages, role="map"):
        raise AssertionError("baseline must never call a model")


class AnalyzerTests(unittest.TestCase):
    def test_chinese_english_headings_preserve_every_character(self):
        text = "\ufeff\n  第一章 起点\r\n短。\r\n第十二回 尾声\n终局。\nChApTeR XXI Final\nLast sentence.\n"
        chapters = split_chapters(text)
        self.assertEqual(len(chapters), 3)
        self.assertEqual("".join(chapter.text for chapter in chapters), text)
        chunks = split_chunks(chapters, 11)
        self.assertEqual("".join(chunk.text for chunk in chunks), text)
        self.assertTrue(all(len(chunk.text) <= 11 for chunk in chunks))
        for chunk in chunks:
            self.assertEqual(text[chunk.start:chunk.end], chunk.text)
        self.assertEqual(chunks[-1].end, len(text))

    def test_preface_and_short_chapters_are_retained(self):
        text = "确实属于正文的前言。\n第一章 开始\n短。\n第二章 结束\n终。"
        chapters = split_chapters(text)
        self.assertEqual(len(chapters), 3)
        self.assertEqual("".join(chapter.text for chapter in chapters), text)

    def test_adjacent_duplicate_export_headings_are_one_chapter(self):
        text = "1.第1章绯红\n第1章 绯红\n正文很短。\n2.第2章来客\n\n第2章来客\n短。\n第2章来客\n再次出现，但之前有正文。"
        chapters = split_chapters(text)
        self.assertEqual(len(chapters), 3)
        self.assertEqual(chapters[0].title, "第1章 绯红")
        self.assertEqual(chapters[1].title, "第2章来客")
        self.assertIn("1.第1章绯红", chapters[0].text)
        self.assertEqual("".join(chapter.text for chapter in chapters), text)
        chunks = split_chunks(chapters, 12)
        self.assertEqual("".join(chunk.text for chunk in chunks), text)

    def test_truncated_duplicate_heading_uses_longer_title(self):
        title = "第50章老尼尔的还钱办法（第三更求推荐票）"
        text = title[:-2] + "\n" + title + "\n内容。\n第51章不同正文\n第51章不同正文的第二个标题\n结尾。"
        chapters = split_chapters(text)
        self.assertEqual(chapters[0].title, title)
        self.assertEqual(len(chapters), 2)
        self.assertEqual("".join(chapter.text for chapter in chapters), text)
        reverse = split_chapters(title + "\n" + title[:-2] + "\n内容。")
        self.assertEqual(len(reverse), 1)
        self.assertEqual(reverse[0].title, title)
        # Same number alone is insufficient; different non-prefix titles remain.
        distinct = split_chapters("第50章老尼尔的还钱办法\n第50章林青的另一个故事\n正文。")
        self.assertEqual(len(distinct), 2)

    def test_full_book_over_300k_and_over_15_chapters_includes_ending(self):
        text = "".join(f"第{i}章 故事\n" + "林青看见远山，继续寻找旧日的答案。" * 1100 + f"\n林青完成第{i}次调查。\n" for i in range(1, 22))
        text += "林青在最后一页揭露了钟楼的秘密，众人终于团聚。"
        self.assertGreater(len(text), 300000)
        model = FakeModel()
        progress = []
        result = SimpleNovelAnalyzer(model_client=model).analyze_novel_text(text, progress_callback=progress.append)
        self.assertNotIn("error", result)
        maps = [payload for role, payload, _ in model.calls if role == "map"]
        self.assertEqual("".join(payload["text"] for payload in maps), text)
        self.assertEqual(len(result["hierarchical_summary"]["chapter_summaries"]), 21)
        self.assertEqual(len(result["text_statistics"]["chapter_stats"]), 21)
        self.assertEqual(result["novel_info"]["total_length"], len(text))
        self.assertEqual(result["analysis_metadata"]["analyzed_characters"], len(text))
        self.assertEqual(result["analysis_metadata"]["coverage_ratio"], 1)
        self.assertEqual(result["analysis_metadata"]["status"], "complete")
        self.assertIn("钟楼的秘密", result["hierarchical_summary"]["overall_summary"])
        self.assertIn("钟楼的秘密", result["plot_analysis"]["key_events"][-1]["event"])
        self.assertEqual(len(result["chunk_analyses"]), len(maps))
        person = next(person for person in result["character_analysis"]["main_characters"] if person["name"] == "林青")
        self.assertEqual(person["total_mentions"], text.count("林青"))
        self.assertEqual(len(result["character_analysis"]["character_development"]["林青"]), 21)
        self.assertTrue(all(length <= 24000 for _, _, length in model.calls))
        first_verify = next(index for index, (role, _, _) in enumerate(model.calls) if role == "verify")
        self.assertTrue(all(role == "map" for role, _, _ in model.calls[:first_verify]))
        self.assertTrue(all(role != "map" for role, _, _ in model.calls[first_verify:]))
        self.assertEqual(progress[-1]["progress"], 100)
        self.assertEqual([event["progress"] for event in progress], sorted(event["progress"] for event in progress))
        for item in result["evidence"]:
            self.assertEqual(text[item["start"]:item["end"]], item["quote"])

    def test_long_unpunctuated_chapter_tail_in_baseline(self):
        text = "第一章 很长\n" + "山" * 310005 + "林青在最后一页找到密信"
        result = SimpleNovelAnalyzer(model_client=OfflineModel()).analyze_novel_text(text)
        self.assertEqual(result["analysis_metadata"]["mode"], "baseline")
        self.assertEqual(result["analysis_metadata"]["coverage_ratio"], 1)
        self.assertIn("最后一页找到密信", result["hierarchical_summary"]["overall_summary"])
        self.assertEqual(result["themes"], [])
        self.assertEqual(result["character_analysis"]["character_relationships"], [])
        self.assertEqual(result["plot_analysis"]["plot_structure"], {})
        self.assertEqual(result["text_statistics"]["basic_stats"]["total_characters"], len(text))

    def test_exact_quotes_and_verifier_reject_fabricated_claims(self):
        class Adversarial(FakeModel):
            def generate_json(self, messages, role="map"):
                if role != "map":
                    return super().generate_json(messages, role)
                quote = "林青和白云站在桥边。"
                return {"summary": [{"text": quote, "quote": quote}],
                        "events": [{"event": "凭空造出龙", "quote": "不存在的龙出现了"},
                                   {"event": "不受支持的谋杀发生", "quote": quote}],
                        "relationships": [{"source": "林青", "target": "白云", "relationship": "不受支持的恋爱关系", "quote": quote}]}
        text = "林青和白云站在桥边。" * 20
        result = SimpleNovelAnalyzer(model_client=Adversarial()).analyze_novel_text(text)
        self.assertNotIn("error", result)
        self.assertEqual(result["plot_analysis"]["key_events"], [])
        self.assertEqual(result["character_analysis"]["character_relationships"], [])
        self.assertNotIn("凭空", json.dumps(result, ensure_ascii=False))
        self.assertTrue(any("拒绝" in warning for warning in result["analysis_metadata"]["warnings"]))

    def test_single_malformed_chunk_is_partial_and_others_continue(self):
        class MalformedOne(FakeModel):
            def generate_json(self, messages, role="map"):
                payload = json.loads(messages[-1]["content"])
                if role == "map" and payload["chapter"] == 2:
                    return {"summary": "not a structured array"}
                return super().generate_json(messages, role)
        text = "".join(f"第{i}章\n" + "林青沿路寻找答案。" * 20 + "\n" for i in range(1, 4))
        result = SimpleNovelAnalyzer(model_client=MalformedOne()).analyze_novel_text(text)
        self.assertNotIn("error", result)
        self.assertEqual(result["analysis_metadata"]["status"], "partial")
        self.assertEqual(result["analysis_metadata"]["attempted_chunks"], 3)
        self.assertEqual(result["analysis_metadata"]["processed_chunks"], 2)
        self.assertLess(result["analysis_metadata"]["coverage_ratio"], 1)
        self.assertEqual(len(result["hierarchical_summary"]["chapter_summaries"]), 3)

    def test_all_malformed_results_are_error_not_fake_success(self):
        class Malformed(FakeModel):
            def generate_json(self, messages, role="map"):
                return {"nonsense": "yes"}
        result = SimpleNovelAnalyzer(model_client=Malformed()).analyze_novel_text("事实依据不足。" * 50)
        self.assertIn("error", result)
        self.assertEqual(result["analysis_metadata"]["coverage_ratio"], 0)

    def test_missing_verifier_verdict_is_not_complete_coverage(self):
        class IncompleteVerifier(FakeModel):
            def generate_json(self, messages, role="map"):
                if role == "verify":
                    payload = json.loads(messages[-1]["content"])
                    return {"verdicts": [{"id": claim["id"], "supported": True} for claim in payload["claims"][:-1]]}
                return super().generate_json(messages, role)
        result = SimpleNovelAnalyzer(model_client=IncompleteVerifier()).analyze_novel_text("林青沿路寻找答案。" * 20)
        self.assertIn("error", result)
        self.assertEqual(result["analysis_metadata"]["processed_chunks"], 0)

    def test_provider_failure_circuit_breaker(self):
        class Unavailable(FakeModel):
            def generate_json(self, messages, role="map"):
                self.calls.append(role)
                raise ModelError("map 模型连接失败或超时；请检查服务是否启动")
        model = Unavailable()
        result = SimpleNovelAnalyzer(model_client=model).analyze_novel_text("林青沿路寻找答案。" * 10000)
        self.assertIn("error", result)
        self.assertEqual(len(model.calls), 3)
        self.assertEqual(result["analysis_metadata"]["attempted_chunks"], 3)
        self.assertGreater(result["analysis_metadata"]["total_chunks"], 3)

    def test_verifier_outage_stops_after_three_requests(self):
        class VerifierUnavailable(FakeModel):
            def __init__(self):
                super().__init__()
                self.verifier_calls = 0

            def generate_json(self, messages, role="map"):
                if role == "verify":
                    self.verifier_calls += 1
                    raise ModelError("verify 模型连接失败或超时；请检查服务是否启动")
                return super().generate_json(messages, role)
        model = VerifierUnavailable()
        result = SimpleNovelAnalyzer(model_client=model).analyze_novel_text("林青沿路寻找答案。" * 10000)
        self.assertIn("error", result)
        self.assertEqual(model.verifier_calls, 3)
        self.assertGreater(result["analysis_metadata"]["total_chunks"], 3)

    def test_reducer_outage_preserves_sources_and_marks_chapters_partial(self):
        class ReducerUnavailable(FakeModel):
            def __init__(self):
                super().__init__()
                self.reducer_calls = 0

            def generate_json(self, messages, role="map"):
                if role == "reduce":
                    self.reducer_calls += 1
                    raise ModelError("reduce 模型请求失败（HTTP 503）")
                return super().generate_json(messages, role)
        model = ReducerUnavailable()
        text = "".join(f"第{i}章\n" + "林青继续寻找答案。" * 30 + "\n" for i in range(1, 12))
        result = SimpleNovelAnalyzer(model_client=model).analyze_novel_text(text)
        self.assertNotIn("error", result)
        self.assertEqual(model.reducer_calls, 3)
        self.assertEqual(result["analysis_metadata"]["status"], "partial")
        self.assertEqual(result["analysis_metadata"]["coverage_ratio"], 1)
        self.assertTrue(all(chapter["status"] == "partial" for chapter in result["hierarchical_summary"]["chapter_summaries"]))
        self.assertEqual(len(result["plot_analysis"]["key_events"]), 11)

    def test_hierarchical_reduction_processes_many_chapters_in_bounded_batches(self):
        text = "".join(f"第{i}章\n" + "林青继续寻找答案。" * 20 + "林青完成这一章的调查。\n" for i in range(1, 102))
        text += "林青在终章打开了尘封的信件，谜底终于揭晓。"
        model = FakeModel()
        result = SimpleNovelAnalyzer(model_client=model, settings={"reduce_input_chars": 10000}).analyze_novel_text(text)
        whole_book_calls = [payload for role, payload, _ in model.calls if role == "reduce" and payload["scope"] == "全书整体摘要"]
        self.assertGreater(len(whole_book_calls), 1)
        self.assertEqual(len(result["hierarchical_summary"]["chapter_summaries"]), 101)
        self.assertTrue(all(size < 24000 for _, _, size in model.calls))
        self.assertIn("谜底终于揭晓", result["hierarchical_summary"]["overall_summary"])

    def test_atomic_summary_keeps_supported_statements_when_other_atoms_fail(self):
        class MixedAtoms(FakeModel):
            def generate_json(self, messages, role="map"):
                if role != "reduce":
                    return super().generate_json(messages, role)
                payload = json.loads(messages[-1]["content"])
                item = payload["items"][-1]
                return {"statements": [
                    {"text": item["text"], "evidence_ids": item["evidence_ids"][:1]},
                    {"text": "不受支持的和解与共识", "evidence_ids": item["evidence_ids"][:1]},
                    {"text": "虚构引用", "evidence_ids": ["does-not-exist"]}]}
        text = "第一章\n" + "林青仍在寻找答案。" * 20 + "\n第二章\n" + "林青尚未原谅陈明。" * 20
        result = SimpleNovelAnalyzer(model_client=MixedAtoms()).analyze_novel_text(text)
        self.assertEqual(result["analysis_metadata"]["status"], "complete")
        self.assertEqual(len(result["hierarchical_summary"]["overall_summary_statements"]), 1)
        self.assertIn("尚未原谅", result["hierarchical_summary"]["overall_summary"])
        self.assertNotIn("和解与共识", json.dumps(result, ensure_ascii=False))
        self.assertNotIn("虚构引用", json.dumps(result, ensure_ascii=False))
        self.assertTrue(all(chapter["status"] == "verified" for chapter in result["hierarchical_summary"]["chapter_summaries"]))

    def test_atomic_reducer_may_return_multiple_statements_and_still_converges(self):
        class FullAtoms(FakeModel):
            def generate_json(self, messages, role="map"):
                if role != "reduce":
                    return super().generate_json(messages, role)
                payload = json.loads(messages[-1]["content"])
                self.calls.append((role, payload, sum(len(message["content"]) for message in messages)))
                return {"statements": [{"text": item["text"], "evidence_ids": item["evidence_ids"][:2]}
                                       for item in payload["items"][-payload["statement_limit"]:]]}
        text = "".join(f"第{i}章\n" + "林青继续调查旧案。" * 20 + f"林青完成第{i}次访问。\n" for i in range(1, 102))
        model = FullAtoms()
        result = SimpleNovelAnalyzer(model_client=model, settings={"reduce_input_chars": 10000}).analyze_novel_text(text)
        self.assertEqual(result["analysis_metadata"]["status"], "complete")
        atoms = result["hierarchical_summary"]["overall_summary_statements"]
        self.assertGreater(len(atoms), 1)
        self.assertLessEqual(len(atoms), 8)
        self.assertIn("第101次访问", atoms[-1]["text"])
        self.assertTrue(all(size < 24000 for _, _, size in model.calls))
        self.assertLess(len(model.calls), 1000)

    def test_adjacent_negation_context_reaches_verifier(self):
        class ContextVerifier(FakeModel):
            def generate_json(self, messages, role="map"):
                payload = json.loads(messages[-1]["content"])
                if role == "map":
                    quote = "林青与陈明在桥上放下一盏河灯。"
                    return {"summary": [{"text": quote, "quote": quote}],
                            "events": [{"event": "林青与陈明达成共识。", "quote": quote}]}
                if role == "verify":
                    return {"verdicts": [{"id": claim["id"], "supported": not (
                        "达成共识" in claim["text"] and any("尚未原谅" in evidence["context_after"] for evidence in claim["evidence"]))}
                        for claim in payload["claims"]]}
                return super().generate_json(messages, role)
        text = "小镇旧事迟迟没有解开。" * 20 + "林青与陈明在桥上放下一盏河灯。她明确表示自己尚未原谅所有隐瞒真相的人。"
        result = SimpleNovelAnalyzer(model_client=ContextVerifier()).analyze_novel_text(text)
        self.assertEqual(result["analysis_metadata"]["status"], "complete")
        self.assertEqual(result["plot_analysis"]["key_events"], [])
        self.assertTrue(any("尚未原谅" in evidence["context_after"] for evidence in result["evidence"]))

    def test_verifier_batches_separate_kinds_and_retain_semantic_fields(self):
        model = FakeModel()
        analyzer = SimpleNovelAnalyzer(model_client=model)
        text = "林青与陈明在桥边放河灯。她明确表示自己尚未原谅陈明。" + "夜色仍然笼罩着小镇。" * 20
        run = _AnalysisRun(analyzer, text, "分组验证", None, "model")
        evidence_id = run._evidence(run.chunks[0], "林青与陈明在桥边放河灯。")
        candidates = [run._new_claim("summary", f"林青与陈明在桥边放河灯，第{i}条。", [evidence_id], chapter=1, chunk_id="chunk-000001")
                      for i in range(7)]
        candidates.extend([
            run._new_claim("character", "林青在桥边放河灯。", [evidence_id], name="林青"),
            run._new_claim("relationship", "共同放河灯。", [evidence_id], character1="林青", character2="陈明"),
            run._new_claim("theme", "一起行动仍有未解心结。", [evidence_id], theme="未解的心结"),
            run._new_claim("event", "林青与陈明放河灯。", [evidence_id])])
        accepted = run._verify(candidates)
        self.assertEqual({claim["id"] for claim in accepted}, {claim["id"] for claim in candidates})
        batches = [payload for role, payload, _ in model.calls if role == "verify"]
        self.assertEqual([len(batch["claims"]) for batch in batches if batch["kind"] == "summary"], [6, 1])
        kinds = {claim["id"]: claim["kind"] for claim in candidates}
        for batch in batches:
            self.assertLessEqual(len(batch["claims"]), 6)
            self.assertTrue(all(kinds[claim["id"]] == batch["kind"] for claim in batch["claims"]))
            for claim in batch["claims"]:
                self.assertTrue({"chapter", "chunk_id", "evidence_ids", "kind"}.isdisjoint(claim))
                self.assertEqual(set(claim["evidence"][0]), {"quote", "context_before", "context_after"})
                self.assertIn("尚未原谅", claim["evidence"][0]["context_after"])
        by_kind = {batch["kind"]: batch["claims"][0] for batch in batches}
        self.assertEqual(by_kind["character"]["name"], "林青")
        self.assertEqual((by_kind["relationship"]["character1"], by_kind["relationship"]["character2"]), ("林青", "陈明"))
        self.assertEqual(by_kind["theme"]["theme"], "未解的心结")

    def test_verifier_character_budget_still_applies_below_six_items(self):
        model = FakeModel()
        analyzer = SimpleNovelAnalyzer(model_client=model, settings={"reduce_input_chars": 10000})
        text = "甲" * 600 + "乙" * 600 + "丙" * 600 + "丁" * 600
        run = _AnalysisRun(analyzer, text, "预算验证", None, "model")
        ids = [run._evidence(run.chunks[0], text[200:800]), run._evidence(run.chunks[0], text[1400:2000])]
        candidates = [run._new_claim("summary", text[200:450], ids) for _ in range(6)]
        self.assertEqual(len(run._verify(candidates)), 6)
        batches = [payload for role, payload, _ in model.calls if role == "verify"]
        self.assertGreater(len(batches), 1)
        self.assertTrue(all(len(batch["claims"]) < 6 for batch in batches))
        self.assertTrue(all(len(json.dumps(batch, ensure_ascii=False)) <= 10050 for batch in batches))

    def test_ending_guard_restores_late_fact_discarded_by_chapter_reducer(self):
        class OpeningOnlyReducer(FakeModel):
            def generate_json(self, messages, role="map"):
                payload = json.loads(messages[-1]["content"])
                if role == "map":
                    return {"summary": [
                        {"text": "林青在故事开头找到旧地图。", "quote": "林青在故事开头找到旧地图。"},
                        {"text": "林青在最后明确拒绝替陈明隐瞒真相。", "quote": "林青在最后明确拒绝替陈明隐瞒真相。"}]}
                if role == "reduce":
                    item = payload["items"][0]
                    return {"statements": [{"text": item["text"], "evidence_ids": item["evidence_ids"]}]}
                return super().generate_json(messages, role)
        text = "第一章\n林青在故事开头找到旧地图。" + "她沿着旧路寻找线索。" * 20 + "林青在最后明确拒绝替陈明隐瞒真相。"
        result = SimpleNovelAnalyzer(model_client=OpeningOnlyReducer()).analyze_novel_text(text)
        self.assertEqual(result["analysis_metadata"]["status"], "complete")
        self.assertNotIn("拒绝", result["hierarchical_summary"]["chapter_summaries"][0]["summary"])
        self.assertIn("拒绝替陈明隐瞒真相", result["hierarchical_summary"]["overall_summary"])
        ending = result["hierarchical_summary"]["overall_ending_statements"]
        self.assertEqual(ending[-1]["text"], "林青在最后明确拒绝替陈明隐瞒真相。")
        self.assertLessEqual(len(ending), 2)
        evidence = {item["id"]: item for item in result["evidence"]}
        for statement in ending:
            for evidence_id in statement["evidence_ids"]:
                item = evidence[evidence_id]
                self.assertEqual(text[item["start"]:item["end"]], item["quote"])

    def test_invalid_domain_cache_retries_and_valid_analysis_stays_cached(self):
        # Real ModelClient/cache with deterministic fake HTTP: malformed domain
        # JSON must not poison a repeat analysis for the cache TTL.
        for bad_stage in ("map", "verify", "reduce"):
            with self.subTest(bad_stage=bad_stage), tempfile.TemporaryDirectory() as directory:
                session = Mock()
                client = ModelClient({"NOVEL_MODEL_PROVIDER": "ollama", "NOVEL_MODEL_RETRIES": 0,
                                      "NOVEL_CACHE_ENABLED": "1", "DATA_DIR": directory}, session=session)
                phase = [0]
                fake = FakeModel()

                def respond(_url, **kwargs):
                    messages = kwargs["json"]["messages"]
                    payload = json.loads(messages[-1]["content"])
                    role = "map" if "text" in payload else ("verify" if "claims" in payload else "reduce")
                    output = {"invalid_domain_structure": True} if phase[0] == 0 and role == bad_stage else fake.generate_json(messages, role)
                    response = Mock(status_code=200)
                    response.json.return_value = {"done": True, "done_reason": "stop", "message": {"content": json.dumps(output, ensure_ascii=False)}}
                    return response

                session.post.side_effect = respond
                analyzer = SimpleNovelAnalyzer(model_client=client)
                text = "林青仍在寻找答案。" * 20
                first = analyzer.analyze_novel_text(text)
                if bad_stage == "reduce":
                    self.assertEqual(first["analysis_metadata"]["status"], "partial")
                else:
                    self.assertIn("error", first)
                first_calls = session.post.call_count
                phase[0] = 1
                second = analyzer.analyze_novel_text(text)
                self.assertEqual(second["analysis_metadata"]["status"], "complete")
                self.assertGreater(session.post.call_count, first_calls)
                second_calls = session.post.call_count
                third = analyzer.analyze_novel_text(text)
                self.assertEqual(third["analysis_metadata"]["status"], "complete")
                self.assertEqual(session.post.call_count, second_calls)

    def test_all_rejected_verdict_and_reduction_responses_are_invalidated(self):
        class RejectingCacheModel(FakeModel):
            def __init__(self):
                super().__init__()
                self.responses = []
                self.invalidated = []

            def generate_json(self, messages, role="map"):
                if role == "verify":
                    payload = json.loads(messages[-1]["content"])
                    result = {"verdicts": [{"id": claim["id"], "supported": False} for claim in payload["claims"]]}
                else:
                    result = super().generate_json(messages, role)
                self.responses.append((role, result))
                return result

            def invalidate_response(self, response):
                self.invalidated.append(response)

        model = RejectingCacheModel()
        analyzer = SimpleNovelAnalyzer(model_client=model)
        text = "林青仍在寻找答案。" * 20
        run = _AnalysisRun(analyzer, text, "拒绝缓存", None, "model")
        evidence_id = run._evidence(run.chunks[0], "林青仍在寻找答案。")
        candidate = run._new_claim("summary", "林青仍在寻找答案。", [evidence_id])
        with self.assertRaises(ValueError):
            run._reduce_group([candidate], "归纳检查")
        self.assertEqual({role for role, response in model.responses if any(response is item for item in model.invalidated)}, {"reduce", "verify"})
        model.responses.clear()
        model.invalidated.clear()
        result = analyzer.analyze_novel_text(text)
        self.assertIn("error", result)
        map_response = next(response for role, response in model.responses if role == "map")
        self.assertTrue(any(map_response is response for response in model.invalidated))

    def test_over_target_reduce_candidates_are_all_audited_before_selection(self):
        class OverTarget(FakeModel):
            def generate_json(self, messages, role="map"):
                if role != "reduce":
                    return super().generate_json(messages, role)
                payload = json.loads(messages[-1]["content"])
                ids = payload["items"][0]["evidence_ids"]
                return {"statements": [{"text": "不受支持的开篇推断" if index == 0 else f"林青完成第{index}项调查。", "evidence_ids": ids}
                                       for index in range(10)]}
        model = OverTarget()
        run = _AnalysisRun(SimpleNovelAnalyzer(model_client=model), "林青一直在调查。" * 20, "超额候选", None, "model")
        evidence_id = run._evidence(run.chunks[0], "林青一直在调查。")
        node = run._new_claim("summary", "林青一直在调查。", [evidence_id])
        selected = run._reduce_group([node], "候选选择", statement_limit=8)
        audited = [claim for role, payload, _ in model.calls if role == "verify" for claim in payload["claims"]]
        self.assertEqual(len(audited), 10)
        self.assertEqual(len(selected), 8)
        self.assertEqual(selected[0]["text"], "林青完成第1项调查。")
        self.assertEqual(selected[-1]["text"], "林青完成第9项调查。")
        self.assertTrue(all("不受支持" not in node["text"] for node in selected))
        self.assertTrue(any("超过目标 8 条" in warning and "逐条审核" in warning for warning in run.warnings))

    def test_reduce_candidate_limit_32_is_enforced_before_verification(self):
        class CandidateCount(FakeModel):
            def __init__(self, count):
                super().__init__()
                self.count, self.invalidated = count, []

            def generate_json(self, messages, role="map"):
                if role != "reduce":
                    return super().generate_json(messages, role)
                payload = json.loads(messages[-1]["content"])
                item = payload["items"][0]
                return {"statements": [{"text": f"林青完成第{index}项调查。", "evidence_ids": item["evidence_ids"]} for index in range(self.count)]}

            def invalidate_response(self, response):
                self.invalidated.append(response)

        for count in (32, 33):
            with self.subTest(count=count):
                model = CandidateCount(count)
                run = _AnalysisRun(SimpleNovelAnalyzer(model_client=model), "林青一直在调查。" * 20, "候选上限", None, "model")
                evidence_id = run._evidence(run.chunks[0], "林青一直在调查。")
                node = run._new_claim("summary", "林青一直在调查。", [evidence_id])
                if count == 32:
                    selected = run._reduce_group([node], "候选选择", statement_limit=1)
                    self.assertEqual([item["text"] for item in selected], ["林青完成第31项调查。"])
                    self.assertEqual(sum(len(payload["claims"]) for role, payload, _ in model.calls if role == "verify"), 32)
                    self.assertEqual(model.invalidated, [])
                else:
                    with self.assertRaises(ValueError):
                        run._reduce_group([node], "候选选择")
                    self.assertFalse(any(role == "verify" for role, _, _ in model.calls))
                    self.assertEqual(len(model.invalidated), 1)

    def test_over_target_intermediate_groups_still_converge(self):
        class IgnoreTarget(FakeModel):
            def generate_json(self, messages, role="map"):
                if role != "reduce":
                    return super().generate_json(messages, role)
                payload = json.loads(messages[-1]["content"])
                self.calls.append((role, payload, sum(len(message["content"]) for message in messages)))
                return {"statements": [{"text": item["text"], "evidence_ids": item["evidence_ids"][:2]} for item in payload["items"]]}
        model = IgnoreTarget()
        text = "".join(f"第{i}章\n" + "林青继续寻找答案。" * 25 + f"林青完成第{i}次调查。\n" for i in range(1, 72))
        result = SimpleNovelAnalyzer(model_client=model, settings={"reduce_input_chars": 10000}).analyze_novel_text(text)
        self.assertEqual(result["analysis_metadata"]["status"], "complete")
        self.assertLessEqual(len(result["hierarchical_summary"]["overall_summary_statements"]), 10)
        self.assertIn("第71次调查", result["hierarchical_summary"]["overall_summary"])
        self.assertTrue(any("超过目标" in warning for warning in result["analysis_metadata"]["warnings"]))
        self.assertLess(len(model.calls), 1000)

    def test_english_sentence_statistics_cover_all_sentences(self):
        text = "Alice waited. Bob arrived! They left together? " * 20
        result = SimpleNovelAnalyzer(model_client=OfflineModel()).analyze_novel_text(text)
        self.assertEqual(result["text_statistics"]["basic_stats"]["total_sentences"], 60)


if __name__ == "__main__":
    unittest.main()
