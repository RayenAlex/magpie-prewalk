"""离线校验真实客户端夹具；不启动 CLI、不联网。"""

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import client_capture as capture

FIXTURES = Path(__file__).parent / "fixtures" / "claude-code-2.1.323"
EXPECTED_CASES = {
    "successful-edit", "failed-edit", "parallel-tools", "no-hints",
    "stopped", "cancelled",
}


def load_case(name):
    return json.loads((FIXTURES / (name + ".json")).read_text())


class ClientFixtureTests(unittest.TestCase):
    def test_all_declared_cases_are_present_and_offline(self):
        manifest = json.loads((FIXTURES / "manifest.json").read_text())
        self.assertEqual(manifest["version"], "2.1.323")
        self.assertEqual(set(manifest["captures"]), {name + ".json" for name in EXPECTED_CASES})
        self.assertEqual(len(manifest["captures"]), len(EXPECTED_CASES))
        with patch("subprocess.Popen", side_effect=AssertionError("CLI forbidden")), patch(
            "socket.socket.connect", side_effect=AssertionError("network forbidden")
        ):
            for name in sorted(EXPECTED_CASES):
                with self.subTest(name=name):
                    capture.validate_case(load_case(name))
        self.assertIn("subagent", manifest["unsupported"])
        self.assertIn("compaction", manifest["unsupported"])
        self.assertIn("image", manifest["unsupported"])
        self.assertIn("long-context", manifest["unsupported"])

    def test_successful_edit_has_exact_inputs_and_file_effect(self):
        case = load_case("successful-edit")
        self.assertEqual(len(case["requests"]), 3)
        self.assertEqual(case["file_content"], "PREWALK_OFFLINE_OK\n")
        self.assertEqual(case["other_content"], "SECOND_BEFORE\n")
        edit = case["requests"][1]["response"]["body"]["content"][-1]
        self.assertEqual(edit["name"], "Edit")
        self.assertEqual(edit["input"], {
            "file_path": "/fixture/root/workspace/probe.txt",
            "old_string": "PREWALK_BEFORE", "new_string": "PREWALK_OFFLINE_OK",
        })
        results = capture.tool_results(case["requests"][-1]["body"])
        self.assertEqual([part["tool_use_id"] for part in results], [
            "toolu_prewalk_read", "toolu_prewalk_edit",
        ])
        self.assertEqual([part.get("is_error", False) for part in results], [False, False])
        self.assertEqual(case["cli_result"]["result"], "PREWALK_OFFLINE_DONE")

    def test_failed_edit_keeps_file_and_identifies_missing_string(self):
        case = load_case("failed-edit")
        self.assertEqual(case["file_content"], "PREWALK_BEFORE\n")
        result, = capture.tool_results(case["requests"][-1]["body"])
        self.assertEqual(result["tool_use_id"], "toolu_prewalk_bad_edit")
        self.assertIs(result["is_error"], True)
        self.assertIn("String to replace not found in file.", result["content"])
        self.assertIn("NOT_PRESENT", result["content"])

    def test_parallel_results_match_ids_and_contents_without_order_assumption(self):
        case = load_case("parallel-tools")
        results = capture.tool_results(case["requests"][-1]["body"])
        self.assertEqual(len(results), 2)
        self.assertCountEqual([part["tool_use_id"] for part in results], [
            "toolu_prewalk_read_a", "toolu_prewalk_read_b",
        ])
        by_id = {part["tool_use_id"]: part for part in results}
        self.assertIn("PREWALK_BEFORE", str(by_id["toolu_prewalk_read_a"]["content"]))
        self.assertIn("SECOND_BEFORE", str(by_id["toolu_prewalk_read_b"]["content"]))
        self.assertTrue(all(not part.get("is_error", False) for part in results))

    def test_main_hints_are_observed_not_fabricated(self):
        case = load_case("successful-edit")
        headers = [request["headers"] for request in case["requests"]]
        self.assertEqual(len(headers), 3)
        for header in headers:
            self.assertEqual(header["x-claude-code-request-class"], "main")
            self.assertEqual(header["x-claude-code-session-id"], case["source"]["session_id"])
            self.assertTrue(header["x-claude-code-prompt-id"])
            self.assertNotIn("x-claude-code-agent-id", header)
        self.assertEqual(len({header["x-claude-code-prompt-id"] for header in headers}), 1)
        no_hints = load_case("no-hints")
        self.assertFalse(no_hints["source"]["hint_headers"])
        self.assertNotIn("x-claude-code-request-class", no_hints["requests"][0]["headers"])

    def test_end_turn_stops_without_file_changes(self):
        case = load_case("stopped")
        self.assertEqual(len(case["requests"]), 1)
        self.assertEqual(case["requests"][0]["response"]["body"]["stop_reason"], "end_turn")
        self.assertEqual(case["file_content"], "PREWALK_BEFORE\n")
        self.assertEqual(case["cli_result"]["result"], "PLANNING_ONLY")
        self.assertEqual(case["exit_code"], 0)

    def test_cancelled_stream_releases_client_and_server(self):
        case = load_case("cancelled")
        self.assertTrue(case["cleanup"]["client_exited"])
        self.assertTrue(case["cleanup"]["server_closed"])
        self.assertTrue(case["cleanup"]["stream_disconnected"])
        self.assertIs(case["cli_result"]["is_error"], True)
        self.assertEqual(case["cli_result"]["terminal_reason"], "aborted_streaming")
        self.assertEqual(len(case["requests"]), 1)
        self.assertEqual(case["file_content"], "PREWALK_BEFORE\n")
        self.assertIsNone(case["requests"][0]["response"]["body"]["stop_reason"])

    def test_derived_wrong_error_flag_is_rejected(self):
        case = load_case("failed-edit")
        capture.tool_results(case["requests"][-1]["body"])[0]["is_error"] = False
        with self.assertRaisesRegex(ValueError, "failed_edit_reason"):
            capture.validate_case(case)

    def test_derived_swapped_parallel_ids_are_rejected(self):
        case = load_case("parallel-tools")
        results = capture.tool_results(case["requests"][-1]["body"])
        self.assertEqual(len(results), 2)
        results[0]["tool_use_id"], results[1]["tool_use_id"] = (
            results[1]["tool_use_id"], results[0]["tool_use_id"],
        )
        with self.assertRaisesRegex(ValueError, "parallel_result_content"):
            capture.validate_case(case)

    def test_parallel_results_can_be_reordered_without_changing_pairing(self):
        case = load_case("parallel-tools")
        for message in case["requests"][-1]["body"]["messages"]:
            if any(part.get("type") == "tool_result" for part in capture.content_blocks(message)):
                message["content"] = list(reversed(message["content"]))
        capture.validate_case(case)

    def test_derived_missing_parallel_result_is_rejected(self):
        case = load_case("parallel-tools")
        messages = case["requests"][-1]["body"]["messages"]
        for message in messages:
            parts = message.get("content", [])
            if isinstance(parts, list):
                message["content"] = [part for part in parts if not (
                    isinstance(part, dict) and part.get("tool_use_id") == "toolu_prewalk_read_b"
                )]
        with self.assertRaisesRegex(ValueError, "tool_pairing"):
            capture.validate_case(case)

    def test_derived_duplicate_result_is_rejected(self):
        case = load_case("parallel-tools")
        messages = case["requests"][-1]["body"]["messages"]
        message = next(message for message in messages if isinstance(message.get("content"), list) and any(
            isinstance(part, dict) and part.get("type") == "tool_result" for part in message["content"]
        ))
        result = next(part for part in message["content"] if part.get("type") == "tool_result")
        message["content"].append(copy.deepcopy(result))
        with self.assertRaisesRegex(ValueError, "tool_pairing"):
            capture.validate_case(case)

    def test_derived_unknown_tool_is_rejected(self):
        case = load_case("successful-edit")
        response = case["requests"][0]["response"]
        response["body"]["content"][-1]["name"] = "UnknownWrite"
        for event in response["events"]:
            block = event["data"].get("content_block", {})
            if block.get("type") == "tool_use":
                block["name"] = "UnknownWrite"
        with self.assertRaisesRegex(ValueError, "unknown_tool"):
            capture.validate_case(case)

    def test_derived_missing_identity_is_rejected(self):
        case = load_case("successful-edit")
        del case["requests"][0]["headers"]["x-claude-code-session-id"]
        with self.assertRaisesRegex(ValueError, "session_identity"):
            capture.validate_case(case)

    def test_derived_wrong_file_effect_is_rejected(self):
        case = load_case("successful-edit")
        case["file_content"] = "PREWALK_BEFORE\n"
        with self.assertRaisesRegex(ValueError, "file_effect"):
            capture.validate_case(case)

    def test_sanitization_replaces_paths_and_identifiers_consistently(self):
        raw = {
            "source": {"session_id": "123e4567-e89b-42d3-a456-426614174000",
                       "temporary_root": "/private/tmp/capture-test", "client": "/example/bin/claude"},
            "request": {"file_path": "/private/tmp/capture-test/workspace/probe.txt",
                        "metadata": {"user_id": '{"device_id":"device-test","session_id":"123e4567-e89b-42d3-a456-426614174000"}'}},
        }
        original = copy.deepcopy(raw)
        sanitized = capture.sanitize(raw)
        self.assertEqual(raw, original)
        self.assertEqual(sanitized["request"]["file_path"], "/fixture/root/workspace/probe.txt")
        self.assertEqual(sanitized["source"]["client"], "/fixture/bin/claude")
        metadata = json.loads(sanitized["request"]["metadata"]["user_id"])
        self.assertEqual(metadata["session_id"], sanitized["source"]["session_id"])
        self.assertNotIn("device-test", json.dumps(sanitized))
        self.assertNotIn("/private/tmp/capture-test", json.dumps(sanitized))

    def test_capture_environment_does_not_inherit_credentials(self):
        with patch.dict(capture.os.environ, {
            "PATH": "/example/bin", "ANTHROPIC_API_KEY": "do-not-inherit",
            "ANTHROPIC_AUTH_TOKEN": "do-not-inherit-token", "HTTP_PROXY": "http://invalid",
        }, clear=True):
            env = capture.client_environment(Path("/fixture/root"), 12345, False)
        self.assertEqual(env["ANTHROPIC_API_KEY"], "offline-placeholder-key")
        self.assertNotIn("ANTHROPIC_AUTH_TOKEN", env)
        self.assertNotIn("HTTP_PROXY", env)
        self.assertNotIn("CLAUDE_CODE_GATEWAY_HINT_HEADERS", env)
        self.assertEqual(env["ANTHROPIC_BASE_URL"], "http://127.0.0.1:12345")

    def test_client_cannot_read_capture_script_from_inherited_stdin(self):
        process = unittest.mock.Mock(returncode=0, pid=12345)
        process.communicate.return_value = ('{"result":"PLANNING_ONLY"}', "")
        with patch.object(capture.os, "killpg"), patch.object(
            capture.subprocess, "Popen", return_value=process
        ) as launch:
            capture.execute_client("stopped", ["claude"], Path("/fixture/root"), {}, None)
        self.assertEqual(launch.call_args.kwargs.get("stdin"), subprocess.DEVNULL)

    def test_no_client_is_reported_before_version_query(self):
        with patch.object(capture, "CLIENT", None), patch.object(capture.subprocess, "run") as run:
            with self.assertRaisesRegex(SystemExit, "executable not found"):
                capture.require_version()
        run.assert_not_called()

    def test_timed_out_client_group_escalates_and_is_reaped(self):
        process = unittest.mock.Mock(pid=12345)
        process.poll.return_value = None
        process.communicate.side_effect = [subprocess.TimeoutExpired("claude", 5), ("", "")]
        with patch.object(capture.os, "killpg") as kill:
            capture.terminate_group(process)
        self.assertEqual(kill.call_args_list, [
            unittest.mock.call(12345, capture.signal.SIGTERM),
            unittest.mock.call(12345, capture.signal.SIGKILL),
        ])
        self.assertEqual(process.communicate.call_count, 2)

    def test_exited_group_leader_does_not_skip_remaining_processes(self):
        process = unittest.mock.Mock(pid=12345)
        process.poll.return_value = 0
        process.communicate.return_value = ("", "")
        with patch.object(capture.os, "killpg") as kill:
            capture.terminate_group(process)
        kill.assert_called_once_with(12345, capture.signal.SIGTERM)
        process.communicate.assert_called_once_with(timeout=capture.CLEANUP_TIMEOUT_SECONDS)

    def test_already_gone_process_group_is_not_a_cleanup_error(self):
        process = unittest.mock.Mock(pid=12345)
        process.poll.return_value = 0
        process.communicate.return_value = ("", "")
        with patch.object(capture.os, "killpg", side_effect=ProcessLookupError):
            capture.terminate_group(process)
        process.communicate.assert_called_once_with(timeout=capture.CLEANUP_TIMEOUT_SECONDS)

    def test_invalid_capture_is_not_written(self):
        invalid = load_case("failed-edit")
        invalid["file_content"] = "SHOULD_NOT_WRITE\n"
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "not-created"
            with patch.object(sys, "argv", [
                "client_capture.py", "--case", "failed-edit", "--output", str(target),
            ]), patch.object(capture, "require_version", return_value="2.1.323"), patch.object(
                capture, "run_case", return_value=invalid
            ):
                with self.assertRaisesRegex(ValueError, "file_effect"):
                    capture.main()
            self.assertFalse(target.exists())

    def test_version_mismatch_refuses_capture_before_any_cli_task(self):
        result = subprocess.CompletedProcess(["claude", "--version"], 0, "2.1.999 (Claude Code)\n", "")
        with patch.object(capture.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(SystemExit, "version"):
                capture.require_version()


if __name__ == "__main__":
    unittest.main()
