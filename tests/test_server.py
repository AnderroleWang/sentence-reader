"""Self-contained backend and publication privacy tests. No real model credentials."""
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("reader_server", ROOT / "server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
UNITS = [{"source_id": "s1", "text": "Although the model is accurate, it requires substantial computation."},
         {"source_id": "s2", "text": "We evaluate the method on two datasets."}]


def explanation():
    item = {"source_id": "s1", "quote": "Although the model is accurate", "explanation": "让步从句。"}
    return {"structure": [item], "terms": [], "intent": item, "limits": "仅依据上下文。"}


class ModelHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path.startswith("/reject"):
            self.send_response(401)
            self.end_headers()
            self.wfile.write(self.headers.get("Authorization", "").encode())
            return
        self.server.requests.append(payload)
        if self.path.startswith("/broken") or (self.path.startswith("/repair") and len(payload["messages"]) < 3):
            content = json.dumps({"groups": [{"source_ids": ["s1"], "translation": "漏译。"}]})
        else:
            content = json.dumps({"groups": [{"source_ids": [u["source_id"]], "translation": "测试中文译文。"} for u in UNITS]})
        result = {"message": {"content": content}} if self.path == "/api/chat" else {"choices": [{"message": {"content": content}}]}
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(result).encode())


class BackendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model = ThreadingHTTPServer(("127.0.0.1", 0), ModelHandler)
        cls.model.requests = []
        cls.app = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        for instance in (cls.model, cls.app):
            threading.Thread(target=instance.serve_forever, daemon=True).start()
        cls.model_url = "http://127.0.0.1:%d" % cls.model.server_port
        cls.app_url = "http://127.0.0.1:%d" % cls.app.server_port

    @classmethod
    def tearDownClass(cls):
        for instance in (cls.model, cls.app):
            instance.shutdown()
            instance.server_close()

    def test_chinese_multiple_sentences_stay_one_group(self):
        groups = server.validate_groups({"groups": [{"source_ids": ["s1"], "translation": "模型很准确。但是计算量大。"},
                                                    {"source_ids": ["s2"], "translation": "用两个数据集评估。"}]}, UNITS)
        self.assertEqual(groups[0]["source_ids"], ["s1"])

    def test_merged_group_needs_review(self):
        value = server.validate_groups({"groups": [{"source_ids": ["s1", "s2"], "translation": "合并翻译。"}]}, UNITS)
        self.assertTrue(value[0]["needs_review"])

    def test_omitted_duplicate_unknown_reordered_ids(self):
        for ids in (["s1"], ["s1", "s1", "s2"], ["s1", "unknown"], ["s2", "s1"]):
            with self.subTest(ids=ids), self.assertRaises(server.TranslationError):
                server.validate_groups({"groups": [{"source_ids": ids, "translation": "测试。"}]}, UNITS)

    def test_parse_fences_and_reasoning(self):
        self.assertEqual(server.parse_json_output('<think>reasoning</think>```json\n{"groups": []}\n```'), {"groups": []})

    def test_endpoint_rejects_credentials_and_queries(self):
        credential_url = "https://" + "name:password@" + "example.test/v1"
        for endpoint in ("https://example.test/v1?key=example", credential_url, "file:///tmp/model"):
            with self.assertRaises(server.TranslationError):
                server.endpoint_for(endpoint, "compatible")
        self.assertEqual(server.endpoint_for(self.model_url, "ollama"), self.model_url + "/api/chat")

    def test_both_model_protocols(self):
        for protocol in ("compatible", "ollama"):
            result = server.translate({"sourceUnits": UNITS, "config": {"baseUrl": self.model_url, "model": "test", "protocol": protocol}})
            self.assertEqual(len(result["groups"]), 2)

    def test_invalid_response_repaired_once(self):
        result = server.translate({"sourceUnits": UNITS, "config": {"baseUrl": self.model_url + "/repair/v1", "model": "test"}})
        self.assertTrue(result["repaired"])

    def test_invalid_response_never_saved(self):
        with self.assertRaises(server.TranslationError):
            server.translate({"sourceUnits": UNITS, "config": {"baseUrl": self.model_url + "/broken/v1", "model": "test"}})

    def test_service_error_redacts_current_credential(self):
        sentinel = "example-only-credential-not-a-real-key"
        with self.assertRaises(server.TranslationError) as captured:
            server.call_model({"baseUrl": self.model_url + "/reject/v1", "model": "test", "apiKey": sentinel}, [])
        self.assertNotIn(sentinel, str(captured.exception))
        self.assertIn("密钥已隐藏", str(captured.exception))

    def test_explanation_exact_quotes_and_context(self):
        value = explanation()
        value["terms"] = [{"source_id": "s2", "quote": "two datasets", "explanation": "两个数据集。"}]
        self.assertEqual(server.validate_explanation(value, UNITS[:1], UNITS[1:])["terms"][0]["source_id"], "s2")

    def test_explanation_rejects_invented_or_wrong_evidence(self):
        for source_id, quote in (("s1", "invented"), ("unknown", "Although"), ("s2", "two datasets")):
            data = explanation()
            data["intent"] = {"source_id": source_id, "quote": quote, "explanation": "测试。"}
            with self.subTest(source_id=source_id), self.assertRaises(server.TranslationError):
                server.validate_explanation(data, UNITS[:1], UNITS[1:])

    def test_explanation_repair_and_repeated_failure(self):
        invalid = explanation()
        invalid["structure"][0]["quote"] = "invented"
        payload = {"sourceUnits": UNITS[:1], "config": {}}
        with patch.object(server, "call_model", side_effect=[json.dumps(invalid), json.dumps(explanation())]) as mocked:
            self.assertTrue(server.explain(payload)["structure"])
            self.assertEqual(mocked.call_count, 2)
        with patch.object(server, "call_model", return_value=json.dumps(invalid)) as mocked:
            with self.assertRaises(server.TranslationError):
                server.explain(payload)
            self.assertEqual(mocked.call_count, 2)

    def test_explanation_input_limits(self):
        for payload in ({"sourceUnits": []}, {"sourceUnits": UNITS * 2}, {"sourceUnits": UNITS, "contextUnits": [{}]}):
            with self.assertRaises(server.TranslationError):
                server.explain(payload)

    def test_cross_origin_and_host_rejected(self):
        for headers in ({"Origin": "https://unrelated.example"}, {"Host": "unrelated.example"}):
            request = urllib.request.Request(self.app_url + "/api/translate", data=b"{}", headers=headers)
            with self.assertRaises(urllib.error.HTTPError) as captured:
                urllib.request.urlopen(request)
            self.assertEqual(captured.exception.code, 403)

    def test_public_assets_and_demo_remain_accessible(self):
        for path in ("/", "/app.mjs", "/vendor/pdf.mjs", "/examples/layout-demo.%E5%8F%A5%E8%AF%BB.json", "/api/health"):
            with self.subTest(path=path), urllib.request.urlopen(self.app_url + path) as response:
                self.assertEqual(response.status, 200)

    def test_get_and_head_block_private_files_even_if_present(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(server, "ROOT", Path(folder)):
            root = Path(folder)
            (root / ".git").mkdir()
            (root / ".git/config").write_text("example private metadata")
            (root / ".env").write_text("example private setting")
            (root / "server.py").write_text("example backend source")
            for method in ("GET", "HEAD"):
                for path in ("/.git/config", "/%2egit/config", "/.env", "/server.py", "/runtime/python.exe", "/vendor/", "/%2e%2e/.git/config"):
                    with self.subTest(path=path, method=method), self.assertRaises(urllib.error.HTTPError) as captured:
                        urllib.request.urlopen(urllib.request.Request(self.app_url + path, method=method))
                    self.assertEqual(captured.exception.code, 404)


if __name__ == "__main__":
    unittest.main(verbosity=2)
