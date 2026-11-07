import datetime
import hashlib
import http.client
import json
import socket
import threading
import unittest

import fixtures as f
from scanner.clamd import NoAnswer
from scanner.server import MAX_BYTES, Scanner, make_server

NOW = datetime.datetime(2026, 11, 11, tzinfo=datetime.timezone.utc).timestamp()
VERSION = "ClamAV 1.5.4/28176/Tue Nov 10 07:26:08 2026"
DATABASE = {"engine": "1.5.4", "version": "28176", "built_at": "2026-11-10T07:26:08Z"}


class FakeScan:
    def __init__(self, owner):
        self.owner = owner

    def send(self, chunk):
        self.owner.received += chunk
        if self.owner.die_on_send:
            raise NoAnswer("BrokenPipeError")

    def finish(self):
        if self.owner.reply is None:
            raise NoAnswer("empty")
        return self.owner.reply

    def close(self):
        pass


class FakeClamd:
    def __init__(self):
        self.reply = "stream: OK"
        self.received = b""
        self.die_on_send = False
        self.version_reply = VERSION
        self.scans = 0

    def ping(self):
        return True

    def version(self):
        if self.version_reply is None:
            raise NoAnswer("gone")
        return self.version_reply

    def begin(self):
        self.scans += 1
        return FakeScan(self)


class ServerCase(unittest.TestCase):
    def setUp(self):
        self.clamd = FakeClamd()
        self.now = NOW
        self.scanner = Scanner(self.clamd, clock=lambda: self.now, read_timeout=0.3, ready_wait=0.05)
        self.scanner.ready.set()
        self.server = make_server(self.scanner, port=0, host="127.0.0.1")
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def post(self, data=b"hello", expected=None, headers=None, path="/scan"):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        sent = {"content-length": str(len(data)), "x-expected-sha256": expected or hashlib.sha256(data).hexdigest()}
        sent.update(headers or {})
        connection.request("POST", path, body=data, headers={k: v for k, v in sent.items() if v is not None})
        response = connection.getresponse()
        return response.status, json.loads(response.read())

    def get(self, path):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request("GET", path)
        response = connection.getresponse()
        return response.status, json.loads(response.read())


class Verdicts(ServerCase):
    def test_nothing_found_carries_its_database(self):
        status, body = self.post(b"hello")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"report": "no_known_malware", "reason": "none", "sha256": hashlib.sha256(b"hello").hexdigest(), "bytes": 5, "database": DATABASE})
        self.assertEqual(self.clamd.received, b"hello")

    def test_a_detection(self):
        self.clamd.reply = "stream: Win.Test.EICAR_HDB-1 FOUND"
        status, body = self.post(f.EICAR)
        self.assertEqual((status, body["report"], body["reason"]), (200, "malware_found", "Win.Test.EICAR_HDB-1"))

    def test_clamd_saying_ok_about_a_bomb_still_blocks(self):
        status, body = self.post(f.wide_bomb())
        self.assertEqual((status, body["report"], body["reason"]), (200, "unreadable", "archive_too_large_unpacked"))

    def test_clamd_saying_ok_about_a_locked_opendocument_still_blocks(self):
        status, body = self.post(f.odf(f.ENCRYPTED_MANIFEST))
        self.assertEqual((status, body["report"], body["reason"]), (200, "unreadable", "password_protected"))

    def test_an_ordinary_opendocument_passes(self):
        status, body = self.post(f.odf())
        self.assertEqual((status, body["report"]), (200, "no_known_malware"))

    def test_clamd_saying_something_else_blocks(self):
        self.clamd.reply = "stream: lstat() failed. ERROR"
        status, body = self.post(b"hello")
        self.assertEqual((status, body["report"], body["reason"]), (200, "unreadable", "clamd_could_not_read"))

    def test_bytes_other_than_the_expected_ones_block(self):
        status, body = self.post(b"hello", expected="0" * 64)
        self.assertEqual((status, body["report"], body["reason"]), (200, "unreadable", "hash_mismatch"))
        self.assertEqual(body["sha256"], hashlib.sha256(b"hello").hexdigest())

    def test_too_large_blocks_without_reading(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.putrequest("POST", "/scan")
        connection.putheader("content-length", str(MAX_BYTES + 1))
        connection.putheader("x-expected-sha256", "0" * 64)
        connection.endheaders()
        response = connection.getresponse()
        body = json.loads(response.read())
        self.assertEqual((response.status, body["report"], body["reason"]), (200, "unreadable", "too_large_to_scan"))
        self.assertEqual(self.clamd.scans, 0)


class NoVerdict(ServerCase):
    def assert_no_verdict(self, status, body, error):
        self.assertEqual(status, 503)
        self.assertEqual(body["error"], error)
        self.assertNotIn("report", body)

    def test_clamd_dying_while_it_is_being_fed(self):
        self.clamd.die_on_send = True
        status, body = self.post(b"hello")
        self.assert_no_verdict(status, body, "scan_interrupted")

    def test_clamd_going_silent(self):
        self.clamd.reply = None
        status, body = self.post(b"hello")
        self.assert_no_verdict(status, body, "scan_interrupted")

    def test_a_stalled_upload(self):
        raw = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        raw.sendall(b"POST /scan HTTP/1.1\r\nhost: x\r\ncontent-length: 1000\r\nx-expected-sha256: " + b"0" * 64 + b"\r\n\r\npartial")
        answer = b""
        while chunk := raw.recv(4096):
            answer += chunk
        raw.close()
        self.assertTrue(answer.startswith(b"HTTP/1.0 503"), answer[:40])
        self.assertIn(b"scan_interrupted", answer)

    def test_an_upload_cut_off(self):
        raw = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        raw.sendall(b"POST /scan HTTP/1.1\r\nhost: x\r\ncontent-length: 1000\r\nx-expected-sha256: " + b"0" * 64 + b"\r\n\r\npartial")
        raw.shutdown(socket.SHUT_WR)
        answer = raw.recv(4096)
        raw.close()
        self.assertTrue(answer.startswith(b"HTTP/1.0 503"), answer[:40])

    def test_clamd_not_ready(self):
        self.scanner.ready.clear()
        self.assert_no_verdict(*self.post(b"hello"), "not_ready")
        self.assert_no_verdict(*self.get("/ready"), "not_ready")

    def test_a_second_file_at_once(self):
        self.scanner.one_at_a_time.acquire()
        self.addCleanup(self.scanner.one_at_a_time.release)
        self.assert_no_verdict(*self.post(b"hello"), "busy")

    def test_no_length_or_hash(self):
        self.assertEqual(self.post(b"hello", expected="XYZ")[0], 400)
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.putrequest("POST", "/scan")
        connection.endheaders()
        self.assertEqual(connection.getresponse().status, 411)


class OldSignatures(ServerCase):
    def test_past_7_days_nothing_is_scanned_and_no_verdict_is_given(self):
        self.now = NOW + 8 * 24 * 60 * 60
        self.assertEqual(self.get("/ready")[0], 503)
        status, body = self.post(b"hello")
        self.assertEqual((status, body["error"]), (503, "signatures_stale"))
        self.assertEqual(self.clamd.scans, 0)

    def test_going_stale_during_a_scan_gives_no_verdict(self):
        scanner_clock = iter([NOW, NOW + 8 * 24 * 60 * 60])
        self.scanner.clock = lambda: next(scanner_clock)
        status, body = self.post(b"hello")
        self.assertEqual((status, body["error"]), (503, "signatures_stale"))

    def test_a_detection_past_the_limit_is_no_verdict_either(self):
        self.clamd.reply = "stream: Win.Test.EICAR_HDB-1 FOUND"
        self.now = NOW + 8 * 24 * 60 * 60
        self.assertEqual(self.post(f.EICAR)[0], 503)

    def test_a_version_it_can_not_read_is_as_good_as_stale(self):
        for reply in ("ClamAV 1.5.4", None):
            self.clamd.version_reply = reply
            self.assertEqual(self.post(b"hello")[0], 503)

    def test_fresh_signatures_are_ready_with_their_version(self):
        self.assertEqual(self.get("/ready"), (200, {"ready": True, "database": DATABASE}))

    def test_live_says_nothing_about_files(self):
        self.assertEqual(self.get("/live"), (200, {"live": True}))
        self.assertEqual(self.get("/nope")[0], 404)
        self.assertEqual(self.post(b"x", path="/nope")[0], 404)


if __name__ == "__main__":
    unittest.main()
