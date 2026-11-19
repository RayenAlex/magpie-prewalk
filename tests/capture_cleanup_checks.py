"""显式本地生命周期检查：仅连接自身 loopback fake，不启动 CLI。"""

import socket
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import client_capture as capture


class ServerCleanupTests(unittest.TestCase):
    def check_incomplete_request_is_interrupted(self, request, body_started):
        accepted, reading, closed = threading.Event(), threading.Event(), threading.Event()

        class ObservedHandler(capture.CaptureHandler):
            def setup(self):
                super().setup()
                accepted.set()

            def do_POST(self):
                reading.set()
                super().do_POST()

        with tempfile.TemporaryDirectory() as temporary, patch.object(capture, "CLEANUP_TIMEOUT_SECONDS", 60):
            server = capture.CaptureServer("stopped", Path(temporary))
            server.RequestHandlerClass = ObservedHandler
            serving = threading.Thread(target=server.serve_forever)
            serving.start()
            client = socket.create_connection(server.server_address, timeout=5)
            closer = None
            errors = []

            def close_server():
                try:
                    server.server_close()
                except Exception as error:
                    errors.append(error)
                finally:
                    closed.set()

            try:
                client.sendall(request)
                self.assertTrue((reading if body_started else accepted).wait(5), "request not accepted")
                server.release.set()
                server.shutdown()
                closer = threading.Thread(target=close_server)
                closer.start()
                self.assertTrue(closed.wait(5), "server_close did not interrupt the incomplete request")
                self.assertFalse(errors)
            finally:
                client.close()
                server.release.set()
                server.shutdown()
                if closer is None:
                    server.server_close()
                else:
                    closer.join(timeout=5)
                serving.join(timeout=5)
            self.assertFalse(serving.is_alive())
            self.assertFalse(closer and closer.is_alive())

    def test_close_interrupts_incomplete_body(self):
        self.check_incomplete_request_is_interrupted(
            b"POST /v1/messages HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1000\r\n\r\n{", True,
        )

    def test_close_interrupts_incomplete_headers(self):
        self.check_incomplete_request_is_interrupted(b"POST /v1/messages HTTP/1.1\r\nHost:", False)


if __name__ == "__main__":
    unittest.main()
