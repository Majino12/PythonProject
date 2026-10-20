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
        return {"models": {"map": "fake-map", "reduce": "fake-reduce", "quote": "fake-quote", "verify": "fake-verify"}}

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
        if role in {"quote", "verify"}:
            return {"verdicts": [{"id": claim["id"], "supported": "不受支持" not in claim["text"]} for claim in payload["claims"]]}
        return {"selected_indices": [payload["items"][-1]["selection_index"]]}


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
        first_verify = next(index for index, (role, _, _) in enumerate(model.calls) if role in {"quote", "verify"})
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

    def test_character_only_facts_keep_coverage_but_excerpts_cannot_become_semantic_summaries(self):
        class CharactersOnly(FakeModel):
            def generate_json(self, messages, role="map"):
                if role == "map":
                    return {"characters": [{"name": "林青", "description": "林青沿河寻找答案。",
                                            "quote": "林青沿河寻找答案。"}]}
                return super().generate_json(messages, role)

        model = CharactersOnly()
        text = "".join(f"第{index}章\n" + "林青沿河寻找答案。" * 20 + "\n" for index in (1, 2))
        result = SimpleNovelAnalyzer(model_client=model).analyze_novel_text(text)
        metadata = result["analysis_metadata"]
        self.assertEqual(metadata["status"], "partial")
        self.assertEqual(metadata["coverage_ratio"], 1)
        self.assertEqual(metadata["processed_chunks"], 2)
        self.assertEqual(metadata["failed_chunks"], [])
        self.assertEqual(result["character_analysis"]["main_characters"][0]["name"], "林青")
        self.assertTrue(all(chunk["status"] == "extractive" and chunk["summary_method"] == "extractive"
                            and chunk["summary"] and chunk["evidence_ids"]
                            for chunk in result["chunk_analyses"]))
        for chapter in result["hierarchical_summary"]["chapter_summaries"]:
            self.assertEqual(chapter["status"], "partial")
            self.assertEqual(chapter["summary_statements"], [])
            self.assertEqual(chapter["evidence_ids"], [])
            self.assertIn("缺少可核验摘要", chapter["summary"])
        self.assertEqual(result["hierarchical_summary"]["overall_summary_statements"], [])
        self.assertFalse(any(role == "reduce" for role, _, _ in model.calls))
        self.assertEqual({payload["check"] for role, payload, _ in model.calls if role in {"quote", "verify"}},
                         {"quote_support", "context_consistency"})
        for evidence in result["evidence"]:
            self.assertEqual(text[evidence["start"]:evidence["end"]], evidence["quote"])

    def test_failed_chunk_excerpts_stay_visible_but_never_enter_model_reduction(self):
        class MiddleFailure(FakeModel):
            def generate_json(self, messages, role="map"):
                payload = json.loads(messages[-1]["content"])
                if role == "map" and payload["chapter"] == 2:
                    return {"summary": "invalid array"}
                return super().generate_json(messages, role)

        facts = ["林青找到旧地图。", "陈明独自登上山顶。", "林青打开最后的信封。"]
        text = "".join(f"第{index}章\n" + fact * 20 + "\n" for index, fact in enumerate(facts, 1))
        model = MiddleFailure()
        result = SimpleNovelAnalyzer(model_client=model).analyze_novel_text(text)
        failed_chunk = result["chunk_analyses"][1]
        self.assertEqual(failed_chunk["status"], "failed")
        self.assertEqual(failed_chunk["summary_method"], "extractive")
        self.assertIn(facts[1], failed_chunk["summary"])
        failed_evidence = set(failed_chunk["evidence_ids"])
        self.assertTrue(failed_evidence)
        chapters = result["hierarchical_summary"]["chapter_summaries"]
        self.assertEqual(chapters[1]["status"], "partial")
        self.assertEqual(chapters[1]["summary_statements"], [])
        self.assertEqual(chapters[1]["evidence_ids"], [])
        self.assertTrue(all(chapters[index]["status"] == "verified" for index in (0, 2)))
        reductions = [payload for role, payload, _ in model.calls if role == "reduce"]
        self.assertTrue(reductions)
        for payload in reductions:
            self.assertTrue(all(item["kind"] != "excerpt" for item in payload["items"]))
            self.assertTrue(all(failed_evidence.isdisjoint(item["evidence_ids"]) for item in payload["items"]))
        self.assertNotIn(facts[1], result["hierarchical_summary"]["overall_summary"])
        self.assertTrue(failed_evidence.isdisjoint(result["hierarchical_summary"]["overall_evidence_ids"]))
        self.assertEqual(result["analysis_metadata"]["status"], "partial")
        self.assertEqual(result["analysis_metadata"]["processed_chunks"], 2)
        successful_chars = sum(chunk["end"] - chunk["start"] for chunk in result["chunk_analyses"]
                               if chunk["status"] != "failed")
        self.assertEqual(result["analysis_metadata"]["coverage_ratio"], successful_chars / len(text))

    def test_all_malformed_results_are_error_not_fake_success(self):
        class Malformed(FakeModel):
            def generate_json(self, messages, role="map"):
                return {"nonsense": "yes"}
        result = SimpleNovelAnalyzer(model_client=Malformed()).analyze_novel_text("事实依据不足。" * 50)
        self.assertIn("error", result)
        self.assertEqual(result["analysis_metadata"]["coverage_ratio"], 0)

    def test_missing_verifier_verdict_is_not_complete_coverage(self):
        class IncompleteVerifier(FakeModel):
            def __init__(self, failing_role):
                super().__init__()
                self.failing_role = failing_role

            def generate_json(self, messages, role="map"):
                if role == self.failing_role:
                    payload = json.loads(messages[-1]["content"])
                    return {"verdicts": [{"id": claim["id"], "supported": True} for claim in payload["claims"][:-1]]}
                return super().generate_json(messages, role)
        for role in ("quote", "verify"):
            with self.subTest(role=role):
                result = SimpleNovelAnalyzer(model_client=IncompleteVerifier(role)).analyze_novel_text("林青沿路寻找答案。" * 20)
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
            def __init__(self, failing_role):
                super().__init__()
                self.failing_role = failing_role
                self.verifier_calls = 0

            def generate_json(self, messages, role="map"):
                if role == self.failing_role:
                    self.verifier_calls += 1
                    raise ModelError(f"{role} 模型连接失败或超时；请检查服务是否启动")
                return super().generate_json(messages, role)
        for role in ("quote", "verify"):
            with self.subTest(role=role):
                model = VerifierUnavailable(role)
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
                return {"selected_indices": [payload["items"][-1]["selection_index"],
                                              -1, len(payload["items"])]}
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
                return {"selected_indices": [item["selection_index"]
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
        self.assertLess(len(model.calls), 1500)

    def test_adjacent_negation_context_reaches_verifier(self):
        class ContextVerifier(FakeModel):
            def generate_json(self, messages, role="map"):
                payload = json.loads(messages[-1]["content"])
                if role == "map":
                    quote = "林青与陈明在桥上放下一盏河灯。"
                    return {"summary": [{"text": quote, "quote": quote}],
                            "events": [{"event": "林青与陈明达成共识。", "quote": quote}]}
                if role in {"quote", "verify"}:
                    return {"verdicts": [{"id": claim["id"], "supported": not (
                        "达成共识" in claim["text"] and any("尚未原谅" in evidence.get("context_after", "") for evidence in claim["evidence"]))}
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
        self.assertEqual(run.model_calls, len(model.calls))
        self.assertEqual(run.cache_hits, 0)
        phases = [payload["check"] for _, payload, _ in model.calls]
        self.assertEqual(phases, sorted(phases, key=lambda check: check == "context_consistency"))
        for role, payload, _ in model.calls:
            self.assertEqual(role, "quote" if payload["check"] == "quote_support" and payload["kind"] == "character" else "verify")
        batches = [payload for role, payload, _ in model.calls if role in {"quote", "verify"}]
        self.assertEqual([len(batch["claims"]) for batch in batches if batch["kind"] == "summary" and batch["check"] == "quote_support"], [6, 1])
        kinds = {claim["id"]: claim["kind"] for claim in candidates}
        for batch in batches:
            self.assertLessEqual(len(batch["claims"]), 6)
            self.assertTrue(all(kinds[claim["id"]] == batch["kind"] for claim in batch["claims"]))
            for claim in batch["claims"]:
                self.assertTrue({"chapter", "chunk_id", "evidence_ids", "kind"}.isdisjoint(claim))
                if batch["check"] == "quote_support":
                    self.assertEqual(set(claim["evidence"][0]), {"quote"})
                else:
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
        batches = [payload for role, payload, _ in model.calls if role in {"quote", "verify"}]
        self.assertGreater(len(batches), 1)
        self.assertTrue(all(len(batch["claims"]) <= 6 for batch in batches))
        self.assertTrue(all(len(batch["claims"]) < 6 for batch in batches if batch["check"] == "context_consistency"))
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
                    return {"selected_indices": [payload["items"][0]["selection_index"]]}
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
        for bad_stage in ("map", "quote", "verify", "reduce"):
            with self.subTest(bad_stage=bad_stage), tempfile.TemporaryDirectory() as directory:
                session = Mock()
                client = ModelClient({"NOVEL_MODEL_PROVIDER": "ollama", "NOVEL_MODEL_RETRIES": 0,
                                      "NOVEL_CACHE_ENABLED": "1", "DATA_DIR": directory}, session=session)
                phase = [0]
                fake = FakeModel()

                def respond(_url, **kwargs):
                    messages = kwargs["json"]["messages"]
                    payload = json.loads(messages[-1]["content"])
                    role = "map" if "text" in payload else (("quote" if payload["check"] == "quote_support" and payload["kind"] == "character" else "verify") if "claims" in payload else "reduce")
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
                self.assertGreater(third["analysis_metadata"]["model_calls"], 0)
                self.assertEqual(third["analysis_metadata"]["cache_hits"], third["analysis_metadata"]["model_calls"])

    def test_all_rejected_verdict_responses_are_invalidated(self):
        class RejectingCacheModel(FakeModel):
            def __init__(self, rejected_role):
                super().__init__()
                self.rejected_role = rejected_role
                self.responses = []
                self.invalidated = []

            def generate_json(self, messages, role="map"):
                if role == self.rejected_role:
                    payload = json.loads(messages[-1]["content"])
                    result = {"verdicts": [{"id": claim["id"], "supported": False} for claim in payload["claims"]]}
                else:
                    result = super().generate_json(messages, role)
                    if role == "map":
                        result = {"characters": result["characters"]}
                self.responses.append((role, result))
                return result

            def invalidate_response(self, response):
                self.invalidated.append(response)

        for rejected_role in ("quote", "verify"):
            with self.subTest(rejected_role=rejected_role):
                model = RejectingCacheModel(rejected_role)
                analyzer = SimpleNovelAnalyzer(model_client=model)
                text = "林青仍在寻找答案。" * 20
                run = _AnalysisRun(analyzer, text, "拒绝缓存", None, "model")
                evidence_id = run._evidence(run.chunks[0], "林青仍在寻找答案。")
                candidate = run._new_claim("character", "林青仍在寻找答案。", [evidence_id], name="林青")
                self.assertEqual(run._verify([candidate]), [])
                expected_invalidated = {rejected_role}
                self.assertEqual({role for role, response in model.responses if any(response is item for item in model.invalidated)}, expected_invalidated)
                model.responses.clear()
                model.invalidated.clear()
                result = analyzer.analyze_novel_text(text)
                self.assertIn("error", result)
                map_response = next(response for role, response in model.responses if role == "map")
                self.assertTrue(any(map_response is response for response in model.invalidated))

    def test_reducer_receives_only_evidence_ids_while_verifiers_keep_claim_ids(self):
        model = FakeModel()
        text = "陈明先离开了。林青仍在寻找答案。钟楼的灯亮了。" * 20
        run = _AnalysisRun(SimpleNovelAnalyzer(model_client=model), text, "引用编号", None, "model")
        evidence_id = run._evidence(run.chunks[0], "林青仍在寻找答案。")
        node = run._new_claim("character", "林青仍在寻找答案。", [evidence_id],
                              name="林青", chapter=1, chunk_id=run.chunks[0].id)
        original_node = dict(node)

        self.assertEqual(run._verify([node]), [node])
        original_verifications = [payload for role, payload, _ in model.calls
                                  if role in {"quote", "verify"}]
        self.assertEqual({payload["check"] for payload in original_verifications},
                         {"quote_support", "context_consistency"})
        for payload in original_verifications:
            self.assertEqual(payload["claims"][0]["id"], node["id"])

        selected = run._reduce_group([node], "归纳引用检查")
        reduced_input = next(payload["items"][0] for role, payload, _ in model.calls
                             if role == "reduce")
        self.assertNotIn("id", reduced_input)
        self.assertEqual(reduced_input["selection_index"], 0)
        for key, value in original_node.items():
            if key != "id":
                self.assertEqual(reduced_input[key], value)
        self.assertEqual(reduced_input["evidence"], [run.evidence[evidence_id]])
        self.assertEqual(reduced_input["evidence"][0]["id"], evidence_id)
        self.assertEqual(selected[0]["evidence_ids"], [evidence_id])
        self.assertEqual(node, original_node)
        self.assertEqual(selected[0]["kind"], "summary")
        self.assertNotEqual(selected[0]["id"], node["id"])
        self.assertEqual(len([role for role, _, _ in model.calls if role in {"quote", "verify"}]),
                         len(original_verifications))

    def test_reduce_rejects_legacy_rewritten_statements_before_model_verification(self):
        class RewritingReducer(FakeModel):
            def generate_json(self, messages, role="map"):
                if role != "reduce":
                    return super().generate_json(messages, role)
                payload = json.loads(messages[-1]["content"])
                self.calls.append((role, payload, 0))
                first, second = payload["items"]
                return {"statements": [
                    {"text": "陈明在修船时找到木盒。", "evidence_ids": first["evidence_ids"]},
                    {"text": first["text"] + second["text"],
                     "evidence_ids": first["evidence_ids"] + second["evidence_ids"]}]}

        model = RewritingReducer()
        facts = ["林秋在修船时找到木盒。", "陈明承认父亲隐瞒过真相。"]
        run = _AnalysisRun(SimpleNovelAnalyzer(model_client=model), "".join(facts), "拒绝改写", None, "model")
        nodes = [run._new_claim("summary", fact, [run._evidence(run.chunks[0], fact)]) for fact in facts]
        original = json.loads(json.dumps(nodes, ensure_ascii=False))
        self.assertEqual(run._summarize(nodes, "章节摘要"), original)
        self.assertEqual(nodes, original)
        self.assertTrue(run.synthesis_failed)
        self.assertIn("章节摘要", run.failed_synthesis_scopes)
        self.assertEqual([role for role, _, _ in model.calls], ["reduce"])
        self.assertTrue(any("缺少合规的 selected_indices 数组" in warning for warning in run.warnings))

    def test_reduce_selects_and_orders_existing_facts_without_changing_their_evidence(self):
        class SelectingReducer(FakeModel):
            def generate_json(self, messages, role="map"):
                if role != "reduce":
                    return super().generate_json(messages, role)
                payload = json.loads(messages[-1]["content"])
                return {"selected_indices": [item["selection_index"] for item in reversed(payload["items"])],
                        "statements": [{"text": "陈明在修船时找到木盒。", "evidence_ids": ["invented"]}]}

        model = SelectingReducer()
        first, second, corroboration = "林秋在修船时找到木盒。", "林秋把账册送入档案馆。", "档案馆登记收存账册。"
        run = _AnalysisRun(SimpleNovelAnalyzer(model_client=model),
                           first + second + corroboration, "选择事实", None, "model")
        ids = [run._evidence(run.chunks[0], quote) for quote in (first, second, corroboration)]
        nodes = [run._new_claim("summary", first, ids[:1]), run._new_claim("summary", second, ids[1:])]
        selected = run._reduce_group(nodes, "选择与排序")
        self.assertEqual([node["text"] for node in selected], [second, first])
        self.assertEqual([set(node["evidence_ids"]) for node in selected],
                         [set(ids[1:]), set(ids[:1])])
        self.assertEqual(selected[0]["evidence_ids"], nodes[1]["evidence_ids"])
        self.assertIsNot(selected[0]["evidence_ids"], nodes[1]["evidence_ids"])
        self.assertFalse(any(role in {"quote", "verify"} for role, _, _ in model.calls))
        self.assertEqual(run.warnings, [])

    def test_reduce_filters_invalid_indices_booleans_and_duplicates_without_new_facts(self):
        class MixedSelection(FakeModel):
            def generate_json(self, messages, role="map"):
                if role != "reduce":
                    return super().generate_json(messages, role)
                return {"selected_indices": [0, True, False, "1", 1.0, -1, 2, 0,
                                              {"text": "陈明在修船时找到木盒。"}, 1]}

        model = MixedSelection()
        facts = ["林秋在修船时找到木盒。", "陈明承认父亲隐瞒过真相。"]
        run = _AnalysisRun(SimpleNovelAnalyzer(model_client=model), "".join(facts), "混合候选", None, "model")
        nodes = [run._new_claim("summary", fact, [run._evidence(run.chunks[0], fact)]) for fact in facts]
        selected = run._reduce_group(nodes, "混合候选")
        self.assertEqual([node["text"] for node in selected], facts)
        self.assertEqual([node["evidence_ids"] for node in selected],
                         [node["evidence_ids"] for node in nodes])
        self.assertFalse(any(role in {"quote", "verify"} for role, _, _ in model.calls))
        self.assertTrue(any("8 个" in warning and "越界或重复" in warning for warning in run.warnings))

    def test_reduce_invalid_selection_responses_are_invalidated_and_preserve_original_facts(self):
        class InvalidSelection(FakeModel):
            def __init__(self, response):
                super().__init__()
                self.response, self.invalidated = response, []

            def generate_json(self, messages, role="map"):
                if role != "reduce":
                    raise AssertionError("selection must not invoke evidence verification")
                return self.response

            def invalidate_response(self, response):
                self.invalidated.append(response)

        for response in ({}, {"selected_indices": None}, {"selected_indices": []},
                         {"selected_indices": "0"}, {"selected_indices": {"0": True}},
                         {"selected_indices": [False, True, -1, 2, "0", 0.0]}):
            with self.subTest(response=response):
                model = InvalidSelection(response)
                facts = ["林秋在修船时找到木盒。", "陈明承认父亲隐瞒过真相。"]
                run = _AnalysisRun(SimpleNovelAnalyzer(model_client=model), "".join(facts), "非法选择", None, "model")
                nodes = [run._new_claim("summary", fact, [run._evidence(run.chunks[0], fact)]) for fact in facts]
                self.assertEqual(run._summarize(nodes, "章节摘要"), nodes)
                self.assertTrue(run.synthesis_failed)
                self.assertEqual(model.invalidated, [response])

    def test_over_target_reduce_indices_are_limited_without_reauditing_unchanged_facts(self):
        class OverTarget(FakeModel):
            def generate_json(self, messages, role="map"):
                if role != "reduce":
                    return super().generate_json(messages, role)
                payload = json.loads(messages[-1]["content"])
                return {"selected_indices": [item["selection_index"] for item in payload["items"]]}
        model = OverTarget()
        facts = [f"林青完成第{index}项调查。" for index in range(10)]
        run = _AnalysisRun(SimpleNovelAnalyzer(model_client=model), "".join(facts), "超额候选", None, "model")
        nodes = [run._new_claim("summary", fact, [run._evidence(run.chunks[0], fact)]) for fact in facts]
        selected = run._reduce_group(nodes, "候选选择", statement_limit=8)
        self.assertFalse(any(role in {"quote", "verify"} for role, _, _ in model.calls))
        self.assertEqual(len(selected), 8)
        self.assertEqual(selected[0]["text"], "林青完成第0项调查。")
        self.assertEqual(selected[-1]["text"], "林青完成第9项调查。")
        self.assertTrue(all(node["text"] in facts for node in selected))
        self.assertTrue(any("超过目标 8 条" in warning and "校验索引" in warning for warning in run.warnings))

    def test_reduce_candidate_limit_32_is_enforced_before_verification(self):
        class CandidateCount(FakeModel):
            def __init__(self, count):
                super().__init__()
                self.count, self.invalidated = count, []

            def generate_json(self, messages, role="map"):
                if role != "reduce":
                    return super().generate_json(messages, role)
                payload = json.loads(messages[-1]["content"])
                return {"selected_indices": [item["selection_index"] for item in payload["items"][:self.count]]}

            def invalidate_response(self, response):
                self.invalidated.append(response)

        for count in (32, 33):
            with self.subTest(count=count):
                model = CandidateCount(count)
                facts = [f"林青完成第{index}项调查。" for index in range(33)]
                run = _AnalysisRun(SimpleNovelAnalyzer(model_client=model), "".join(facts), "候选上限", None, "model")
                nodes = [run._new_claim("summary", fact, [run._evidence(run.chunks[0], fact)]) for fact in facts]
                if count == 32:
                    selected = run._reduce_group(nodes, "候选选择", statement_limit=1)
                    self.assertEqual([item["text"] for item in selected], ["林青完成第31项调查。"])
                    self.assertFalse(any(role in {"quote", "verify"} for role, _, _ in model.calls))
                    self.assertEqual(model.invalidated, [])
                else:
                    with self.assertRaises(ValueError):
                        run._reduce_group(nodes, "候选选择")
                    self.assertFalse(any(role in {"quote", "verify"} for role, _, _ in model.calls))
                    self.assertEqual(len(model.invalidated), 1)

    def test_over_target_intermediate_groups_still_converge(self):
        class IgnoreTarget(FakeModel):
            def generate_json(self, messages, role="map"):
                if role != "reduce":
                    return super().generate_json(messages, role)
                payload = json.loads(messages[-1]["content"])
                self.calls.append((role, payload, sum(len(message["content"]) for message in messages)))
                return {"selected_indices": [item["selection_index"] for item in payload["items"]]}
        model = IgnoreTarget()
        text = "".join(f"第{i}章\n" + "林青继续寻找答案。" * 25 + f"林青完成第{i}次调查。\n" for i in range(1, 72))
        result = SimpleNovelAnalyzer(model_client=model, settings={"reduce_input_chars": 10000}).analyze_novel_text(text)
        self.assertEqual(result["analysis_metadata"]["status"], "complete")
        self.assertLessEqual(len(result["hierarchical_summary"]["overall_summary_statements"]), 10)
        self.assertIn("第71次调查", result["hierarchical_summary"]["overall_summary"])
        self.assertTrue(any("超过目标" in warning for warning in result["analysis_metadata"]["warnings"]))
        self.assertLess(len(model.calls), 1000)

    def test_model_evidence_expands_to_complete_sentence_with_negation(self):
        text = "第一章\n林青说：“我没有原谅你。”陈明默默离开。" + "仍有旧事没有解决。" * 20
        run = _AnalysisRun(SimpleNovelAnalyzer(model_client=FakeModel()), text, "完整句", None, "model")
        evidence_id = run._evidence(run.chunks[0], "我没有原谅你", expand_sentence=True)
        evidence = run.evidence[evidence_id]
        self.assertEqual(evidence["quote"], "林青说：“我没有原谅你。”")
        self.assertEqual(text[evidence["start"]:evidence["end"]], evidence["quote"])
        self.assertTrue(evidence["context_after"].startswith("陈明默默离开。"))
        # A model cannot quote a positive fragment while dropping sentence negation.
        same_id = run._evidence(run.chunks[0], "原谅你。”", expand_sentence=True)
        self.assertEqual(same_id, evidence_id)

    def test_overlong_model_sentence_is_rejected_without_changing_excerpts(self):
        text = "林青并没有" + "做" * 1300 + "这件事。"
        run = _AnalysisRun(SimpleNovelAnalyzer(model_client=FakeModel()), text, "长句", None, "model")
        quote = text[-100:]
        self.assertIsNone(run._evidence(run.chunks[0], quote, expand_sentence=True))
        excerpt_id = run._evidence(run.chunks[0], quote)
        self.assertEqual(run.evidence[excerpt_id]["quote"], quote)

    def test_forced_chunk_boundary_cannot_hide_sentence_negation(self):
        text = "林青并没有" + "同意" * 349 + "隐瞒这件事。"
        run = _AnalysisRun(SimpleNovelAnalyzer(model_client=FakeModel(), settings={"chunk_chars": 500}), text, "跨块长句", None, "model")
        self.assertEqual(len(run.chunks), 2)
        self.assertLess(len(run.chunks[-1].text), 1200)
        self.assertIsNone(run._evidence(run.chunks[-1], "隐瞒这件事", expand_sentence=True))
        self.assertIsNone(run._evidence(run.chunks[0], run.chunks[0].text[:20], expand_sentence=True))
        self.assertIsNotNone(run._evidence(run.chunks[-1], "隐瞒这件事"))

    def test_context_cannot_rescue_wrong_quote_or_wrong_subject(self):
        class ControlledVerifier(FakeModel):
            def generate_json(self, messages, role="map"):
                if role not in {"quote", "verify"}:
                    return super().generate_json(messages, role)
                payload = json.loads(messages[-1]["content"])
                self.calls.append((role, payload, sum(len(message["content"]) for message in messages)))
                verdicts = []
                for claim in payload["claims"]:
                    if payload["check"] == "quote_support":
                        self.assert_quote_only(claim)
                        quotes = "".join(evidence["quote"] for evidence in claim["evidence"])
                        wrong_quote = "传言" in claim["text"] and "传言" not in quotes
                        wrong_subject = claim.get("name") == "林秋的父亲" and "隐瞒" in claim["text"]
                        supported = not (wrong_quote or wrong_subject)
                    else:
                        # Even an overpermissive context judge may not reinstate
                        # claims rejected by the independent quote-only gate.
                        supported = True
                    verdicts.append({"id": claim["id"], "supported": supported})
                return {"verdicts": verdicts}

            @staticmethod
            def assert_quote_only(claim):
                if any(set(evidence) != {"quote"} for evidence in claim["evidence"]):
                    raise AssertionError("support gate must not see neighboring facts")

        text = ("第一章\n镇上一直传言，林秋的父亲卷走了修桥款。"
                "她把木盒带回家，发现盒盖夹着一张二十年前的粮店收据，但收款人的字迹已经模糊。"
                "账册最后一页写明：林秋的父亲没有侵吞修桥款，而是把钱用于购买救济粮，救下了被洪水围困的村民。"
                "陈明承认，他的父亲曾因害怕承担责任而隐瞒真相。")
        model = ControlledVerifier()
        run = _AnalysisRun(SimpleNovelAnalyzer(model_client=model), text, "独立支持审核", None, "model")
        receipt = run._evidence(run.chunks[0], "发现盒盖夹着一张二十年前的粮店收据", expand_sentence=True)
        fathers_quote = "账册最后一页写明：林秋的父亲没有侵吞修桥款，而是把钱用于购买救济粮，救下了被洪水围困的村民。陈明承认，他的父亲曾因害怕承担责任而隐瞒真相"
        fathers = run._evidence(run.chunks[0], fathers_quote, expand_sentence=True)
        bad_quote = run._new_claim("summary", "镇上传言林秋的父亲卷走了修桥款。", [receipt])
        bad_subject = run._new_claim("character", "没有侵吞修桥款，却因害怕承担责任而隐瞒真相。", [fathers], name="林秋的父亲")
        good_subject = run._new_claim("character", "没有侵吞修桥款，而是购买救济粮救助村民。", [fathers], name="林秋的父亲")
        self.assertIn("传言", run.evidence[receipt]["context_before"])
        accepted = run._verify([bad_quote, bad_subject, good_subject])
        self.assertEqual([claim["id"] for claim in accepted], [good_subject["id"]])
        context_ids = {claim["id"] for role, payload, _ in model.calls if role == "verify" and payload["check"] == "context_consistency" for claim in payload["claims"]}
        self.assertEqual(context_ids, {good_subject["id"]})

    def test_run_local_model_counters_include_failures_and_exclude_baseline(self):
        class FailingModel(FakeModel):
            def generate_json(self, messages, role="map"):
                raise ModelError("map 模型连接失败")
        failed = SimpleNovelAnalyzer(model_client=FailingModel()).analyze_novel_text("林青正在寻找旧事的答案。" * 10)
        self.assertEqual(failed["analysis_metadata"]["model_calls"], 1)
        self.assertEqual(failed["analysis_metadata"]["cache_hits"], 0)
        baseline = SimpleNovelAnalyzer(model_client=OfflineModel()).analyze_novel_text("林青正在寻找旧事的答案。" * 10)
        self.assertEqual(baseline["analysis_metadata"]["model_calls"], 0)
        self.assertEqual(baseline["analysis_metadata"]["cache_hits"], 0)

    def test_failure_warnings_keep_controlled_schema_diagnostics(self):
        class BadSchema(FakeModel):
            def __init__(self, failing_role):
                super().__init__()
                self.failing_role = failing_role

            def generate_json(self, messages, role="map"):
                if role == self.failing_role:
                    return {"unexpected": "invalid structure"}
                return super().generate_json(messages, role)

        for role, expected in (("map", "缺少结构化事实数组"), ("verify", "没有返回 verdicts 数组"),
                               ("reduce", "缺少合规的 selected_indices 数组")):
            with self.subTest(role=role):
                result = SimpleNovelAnalyzer(model_client=BadSchema(role)).analyze_novel_text("林青正在寻找旧事的答案。" * 20)
                self.assertTrue(any(expected in warning for warning in result["analysis_metadata"]["warnings"]))

    def test_failure_warnings_do_not_echo_untrusted_exception_text(self):
        secret = "Bearer sk-private-request-key and raw model response"

        class LeakyException(FakeModel):
            def __init__(self, failing_role, error):
                super().__init__()
                self.failing_role, self.error = failing_role, error

            def generate_json(self, messages, role="map"):
                if role == self.failing_role:
                    raise self.error
                return super().generate_json(messages, role)

        for role in ("map", "reduce"):
            for error in (ValueError(secret), RuntimeError(secret), ModelError("模型请求失败：" + secret)):
                with self.subTest(role=role, error_type=type(error).__name__):
                    result = SimpleNovelAnalyzer(model_client=LeakyException(role, error)).analyze_novel_text("林青正在寻找旧事的答案。" * 20)
                    encoded = json.dumps(result, ensure_ascii=False)
                    self.assertNotIn(secret, encoded)
                    expected = "模型请求失败" if isinstance(error, ModelError) else "未展示原始异常信息"
                    self.assertTrue(any(expected in warning for warning in result["analysis_metadata"]["warnings"]))

    def test_english_sentence_statistics_cover_all_sentences(self):
        text = "Alice waited. Bob arrived! They left together? " * 20
        result = SimpleNovelAnalyzer(model_client=OfflineModel()).analyze_novel_text(text)
        self.assertEqual(result["text_statistics"]["basic_stats"]["total_sentences"], 60)


if __name__ == "__main__":
    unittest.main()
