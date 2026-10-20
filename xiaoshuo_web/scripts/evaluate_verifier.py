"""Four authored evidence checks, not an accuracy benchmark.

Only --live enables configured model requests. Each case uses a fresh analysis
run and the application's actual quote-support/context-consistency verifier.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv
from model_client import ModelClient
from novel_analyzer import SimpleNovelAnalyzer, _AnalysisRun


CASES = [
    {"id": "false_context_rumor", "kind": "summary", "expected_supported": False,
     "text": "镇上一直传言，林秋的父亲卷走了修桥款。",
     "quote": "她把木盒带回家，发现盒盖夹着一张二十年前的粮店收据，但收款人的字迹已经模糊。"},
    {"id": "false_father_identity", "kind": "character", "expected_supported": False,
     "name": "林秋的父亲",
     "text": "未侵吞修桥款，而是购买救济粮救下被洪水围困的村民，因害怕承担责任而隐瞒真相",
     "quote": "账册最后一页写明：林秋的父亲没有侵吞修桥款，而是把钱用于购买救济粮，救下了被洪水围困的村民。陈明承认，他的父亲曾因害怕承担责任而隐瞒真相。"},
    {"id": "true_relief_purchases", "kind": "summary", "expected_supported": True,
     "text": "账册记载，林秋的父亲把钱用于购买救济粮。",
     "quote": "账册最后一页写明：林秋的父亲没有侵吞修桥款，而是把钱用于购买救济粮，救下了被洪水围困的村民。"},
    {"id": "true_hidden_truth", "kind": "summary", "expected_supported": True,
     "text": "陈明承认，他的父亲因害怕承担责任而隐瞒真相。",
     "quote": "陈明承认，他的父亲曾因害怕承担责任而隐瞒真相。"},
]


class RecordingClient(ModelClient):
    def __init__(self):
        super().__init__()
        self.calls = []

    def generate_json(self, messages, role="map"):
        started = time.monotonic()
        payload = json.loads(messages[-1]["content"])
        call = {"check": payload.get("check"), "cache_hit": False}
        try:
            result = super().generate_json(messages, role)
            call.update(response=dict(result), cache_hit=bool(getattr(result, "cache_hit", False)))
            return result
        except Exception as error:
            call["error"] = str(error)
            raise
        finally:
            call["seconds"] = round(time.monotonic() - started, 3)
            self.calls.append(call)


def evaluate_case(analyzer, client, source, case):
    started = time.monotonic()
    first_call = len(client.calls)
    item = {**case, "actual_supported": None, "passed": False}
    try:
        run = _AnalysisRun(analyzer, source, "河灯 · 证据审核专项", None, "model")
        chunk = next(chunk for chunk in run.chunks if case["quote"] in chunk.text)
        evidence_id = run._evidence(chunk, case["quote"])
        if evidence_id is None:
            raise ValueError("测试引文无法在源文本中定位")
        extra = {"name": case["name"]} if "name" in case else {}
        claim = run._new_claim(case["kind"], case["text"], [evidence_id], **extra)
        supported = bool(run._verify([claim]))
        item.update(actual_supported=supported, passed=supported is case["expected_supported"])
    except Exception as error:
        # An unavailable model is a test failure, not a correct rejection of a
        # negative example. Leave actual_supported null so reports distinguish it.
        item["error"] = str(error)
    item["seconds"] = round(time.monotonic() - started, 3)
    item["calls"] = client.calls[first_call:]
    item["reasons"] = []
    for call in item["calls"]:
        verdicts = call.get("response", {}).get("verdicts")
        if isinstance(verdicts, list):
            item["reasons"].extend(verdict.get("reason", "") for verdict in verdicts if isinstance(verdict, dict))
    return item


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="显式允许调用 .env / 环境变量中配置的模型")
    parser.add_argument("--output", type=Path, help="保存 JSON 结果；相对路径按当前工作目录解析")
    args = parser.parse_args(argv)
    load_dotenv(ROOT / ".env", override=False)
    report = {"started_at": datetime.now(timezone.utc).isoformat(), "status": "not_run",
              "live": args.live, "passed": 0, "total": len(CASES), "cases": [],
              "note": "仅为自写短篇的4个正负证据审核回归案例，不是小说理解准确率评测。缓存命中会缩短耗时；需要新推理时设置 NOVEL_CACHE_ENABLED=0。"}
    exit_code = 0
    if not args.live:
        report["message"] = "未调用模型；添加 --live 才会执行这4个审核案例。"
    else:
        started = time.monotonic()
        try:
            client = RecordingClient()
            report["models"] = client.describe()
            if not client.configured:
                raise ValueError("尚未完整配置模型，请先设置 .env 并运行 scripts/check_models.py。")
            source = (ROOT / "tests/fixtures/river_lantern.txt").read_text(encoding="utf-8")
            analyzer = SimpleNovelAnalyzer(model_client=client)
            for case in CASES:
                item = evaluate_case(analyzer, client, source, case)
                report["cases"].append(item)
                print(json.dumps({key: item[key] for key in
                                  ("id", "expected_supported", "actual_supported", "passed", "reasons", "seconds")},
                                 ensure_ascii=False), flush=True)
            report["passed"] = sum(case["passed"] for case in report["cases"])
            report["model_calls"] = len(client.calls)
            report["cache_hits"] = sum(call["cache_hit"] for call in client.calls)
            report["uncached_client_calls"] = sum(not call["cache_hit"] for call in client.calls)
            report["status"] = "passed" if report["passed"] == len(CASES) else "failed"
        except Exception as error:
            report.update(status="failed", error=str(error))
        report["seconds"] = round(time.monotonic() - started, 3)
        exit_code = 0 if report["status"] == "passed" else 1
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "cases"}, ensure_ascii=False, indent=2))
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
