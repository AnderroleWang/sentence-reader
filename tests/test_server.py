"""Self-contained backend and publication privacy tests. No real model credentials."""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
import uuid
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

    def do_GET(self):
        self.server.discovery_requests.append({"path": self.path, "headers": self.headers,
                                               "body": self.rfile.read(int(self.headers.get("Content-Length", "0")))})
        status = 200
        if self.path.startswith("/reject"):
            status, value = 401, {"error": self.headers.get("Authorization", "")}
        elif self.path.startswith("/missing"):
            status, value = 404, {"error": "No models endpoint"}
        elif self.path.startswith("/method"):
            status, value = 405, {"error": "Method not supported"}
        elif self.path.startswith("/empty"):
            value = {"data": []}
        elif self.path.startswith("/invalid"):
            value = {"unrecognized": []}
        elif self.path.startswith("/malformed"):
            value = {"data": [{"id": None}, {}, {"id": "bad\nname"}]}
        elif self.path == "/api/tags":
            value = {"models": [{"name": "local-b:latest"}, {"model": "local-a:7b"}]}
        else:
            value = {"data": [{"id": "model-b", "owned_by": "not-shared"}, {"id": "model-a"},
                              {"id": "model-b"}, {"id": "  "}, {"id": 3}]}
        data = b"<html>Service login</html>" if self.path.startswith("/html") else json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.last_headers = self.headers
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
        cls.model.discovery_requests = []
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
            self.assertEqual(self.model.last_headers["User-Agent"], "SentenceReader/" + server.VERSION)
            self.assertIsNone(self.model.last_headers["x-opencode-session"])

    def test_models_route_uses_authenticated_get_without_paper_or_model_call(self):
        sentinel = "example-only-credential-not-a-real-key"
        call_count = len(self.model.requests)
        payload = {"config": {"baseUrl": self.model_url + "/v1/chat/completions", "apiKey": sentinel},
                   "sourceUnits": UNITS}
        request = urllib.request.Request(self.app_url + "/api/models", data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request) as response:
            result = json.load(response)
        self.assertEqual(result, {"models": ["model-a", "model-b"]})
        sent = self.model.discovery_requests[-1]
        self.assertEqual(sent["path"], "/v1/models")
        self.assertEqual(sent["body"], b"")
        self.assertEqual(sent["headers"]["Authorization"], "Bearer " + sentinel)
        self.assertEqual(sent["headers"]["User-Agent"], "SentenceReader/" + server.VERSION)
        self.assertNotIn(sentinel, sent["path"])
        self.assertNotIn(sentinel, json.dumps(result))
        self.assertEqual(len(self.model.requests), call_count)

    def test_model_list_paths_and_protocols(self):
        for base, protocol, expected_path, expected in (
            (self.model_url, "compatible", "/v1/models", ["model-a", "model-b"]),
            (self.model_url + "/gateway/v1/", "compatible", "/gateway/v1/models", ["model-a", "model-b"]),
            (self.model_url, "ollama", "/api/tags", ["local-a:7b", "local-b:latest"]),
            (self.model_url + "/api/chat", "ollama", "/api/tags", ["local-a:7b", "local-b:latest"]),
        ):
            with self.subTest(base=base, protocol=protocol):
                result = server.list_models({"config": {"baseUrl": base, "protocol": protocol}})
                self.assertEqual(result["models"], expected)
                self.assertEqual(self.model.discovery_requests[-1]["path"], expected_path)

    def test_opencode_model_lists_use_documented_endpoint_and_session(self):
        session = str(uuid.uuid4())
        for base, endpoint, expected_session in (
            ("https://opencode.ai/zen/go/v1", "https://opencode.ai/inference/go/v1/models", session),
            ("https://opencode.ai/inference/go/openai/v1/chat/completions", "https://opencode.ai/inference/go/v1/models", session),
            ("https://opencode.ai/zen/v1", "https://opencode.ai/inference/v1/models", None),
            ("https://opencode.ai/inference/openai/v1", "https://opencode.ai/inference/v1/models", None),
        ):
            with self.subTest(base=base), patch.object(server.urllib.request, "urlopen", return_value=io.BytesIO(b'{"data":[{"id":"test"}]}')) as opened:
                self.assertEqual(server.list_models({"config": {"baseUrl": base, "sessionId": session}}), {"models": ["test"]})
                request = opened.call_args.args[0]
                self.assertEqual(request.full_url, endpoint)
                self.assertEqual(request.get_method(), "GET")
                self.assertEqual(request.get_header("X-opencode-session"), expected_session)

    def test_model_list_errors_empty_results_and_credential_redaction(self):
        self.assertEqual(server.list_models({"config": {"baseUrl": self.model_url + "/empty/v1"}}), {"models": []})
        for path, fragment in (("missing", "手动输入"), ("method", "手动输入"), ("html", "JSON"), ("invalid", "格式"), ("malformed", "没有可用")):
            with self.subTest(path=path), self.assertRaises(server.TranslationError) as captured:
                server.list_models({"config": {"baseUrl": self.model_url + "/" + path + "/v1"}})
            self.assertIn(fragment, str(captured.exception))
        sentinel = "example-only-credential-not-a-real-key"
        with self.assertRaises(server.TranslationError) as captured:
            server.list_models({"config": {"baseUrl": self.model_url + "/reject/v1", "apiKey": sentinel}})
        self.assertNotIn(sentinel, str(captured.exception))
        self.assertIn("401", str(captured.exception))
        self.assertIn("密钥已隐藏", str(captured.exception))

    def test_model_list_invalid_configs_and_oversized_response(self):
        for config in (None, [], {"baseUrl": None}, {"baseUrl": "https://example.test/v1?secret=example"}, {"baseUrl": "file:///tmp/models"}, {"protocol": "unknown"}):
            with self.subTest(config=config), self.assertRaises(server.TranslationError):
                server.list_models({"config": config})
        with patch.object(server.urllib.request, "urlopen", return_value=io.BytesIO(b"x" * (4 * 1024 * 1024 + 1))), self.assertRaises(server.TranslationError) as captured:
            server.list_models({"config": {"baseUrl": self.model_url}})
        self.assertIn("过大", str(captured.exception))

    def test_opencode_session_scope_and_stability(self):
        session = str(uuid.uuid4())
        response = json.dumps({"choices": [{"message": {"content": "test"}}]}).encode()
        endpoints = {
            "https://opencode.ai/zen/go/v1": True,
            "https://opencode.ai/inference/go/openai/v1": True,
            "https://opencode.ai/inference/openai/v1": False,
            "https://opencode.ai/zen/gopher/v1": False,
            "https://opencode.ai.example.test/zen/go/v1": False,
            self.model_url: False,
        }
        for endpoint, needs_session in endpoints.items():
            with self.subTest(endpoint=endpoint), patch.object(server.urllib.request, "urlopen", return_value=io.BytesIO(response)) as opened:
                server.call_model({"baseUrl": endpoint, "model": "test", "sessionId": session}, [])
                request = opened.call_args.args[0]
                self.assertEqual(request.get_header("User-agent"), "SentenceReader/" + server.VERSION)
                self.assertEqual(request.get_header("X-opencode-session"), session if needs_session else None)
                self.assertNotIn("sessionId", json.loads(request.data))

    def test_opencode_legacy_session_and_invalid_header_input(self):
        seen = []
        for session in (None, "", {}, "bad\r\nInjected: value"):
            response = io.BytesIO(b'{"choices":[{"message":{"content":"test"}}]}')
            with patch.object(server.urllib.request, "urlopen", return_value=response) as opened:
                server.call_model({"baseUrl": "https://opencode.ai/zen/go/v1", "model": "test", "sessionId": session}, [])
                value = opened.call_args.args[0].get_header("X-opencode-session")
                self.assertEqual(str(uuid.UUID(value)), value)
                seen.append(value)
        self.assertEqual(len(set(seen)), 1, "Legacy pages need a stable fallback across batches")

    def test_cloudflare_error_is_actionable_and_not_retried(self):
        sentinel = "example-only-credential-not-a-real-key"
        body = json.dumps({"cloudflare_error": True, "error_code": 1010, "ray_id": "example-ray-123",
                           "detail": sentinel}).encode()
        error = urllib.error.HTTPError("https://opencode.ai/zen/go/v1/chat/completions", 403, "Forbidden", {}, io.BytesIO(body))
        with patch.object(server.urllib.request, "urlopen", side_effect=error) as opened, self.assertRaises(server.TranslationError) as captured:
            server.translate({"sourceUnits": UNITS, "config": {"baseUrl": "https://opencode.ai/zen/go/v1", "model": "test", "apiKey": sentinel}})
        self.assertEqual(opened.call_count, 1)
        self.assertIn("Cloudflare", str(captured.exception))
        self.assertIn("1010", str(captured.exception))
        self.assertIn("example-ray-123", str(captured.exception))
        self.assertNotIn(sentinel, str(captured.exception))

    def test_missing_session_and_other_service_errors_remain_distinct(self):
        missing = json.dumps({"error": {"type": "MissingSessionID"}})
        self.assertIn("x-opencode-session", server.service_error(400, missing))
        for status, body in ((401, '{"error":"invalid_key"}'), (403, '{"error":"model_forbidden"}'), (502, '<html>Gateway error</html>'), (500, '["error"]')):
            with self.subTest(status=status, body=body):
                message = server.service_error(status, body)
                self.assertIn(str(status), message)
                self.assertIn(body, message)
                self.assertNotIn("Cloudflare", message)

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
        for path in ("/api/translate", "/api/models"):
            for headers in ({"Origin": "https://unrelated.example"}, {"Host": "unrelated.example"}):
                request = urllib.request.Request(self.app_url + path, data=b"{}", headers=headers)
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
