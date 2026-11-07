"""Takes one file at a time over HTTP and answers with a report. It holds no secrets and reaches nothing.

A 200 from POST /scan is a verdict. Anything else, including a connection that drops, is no verdict, which is never a pass.
It logs no file names, contents or hashes, and nothing about what it scanned beyond sizes and timing.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import archive, verdict
from .clamd import Clamd, NoAnswer, SocketClamd
from .signatures import Database, is_fresh, parse_version

MAX_BYTES = 100 * 1000 * 1000
READY_WAIT_SECONDS = 120.0
READ_TIMEOUT_SECONDS = 60.0
CHUNK = 64 * 1024
_SHA256 = re.compile(r"[0-9a-f]{64}")


class Scanner:
    """What the server knows. A test gives it a fake clamd and a clock."""

    def __init__(self, clamd: Clamd, clock=time.time, read_timeout: float = READ_TIMEOUT_SECONDS, ready_wait: float = READY_WAIT_SECONDS) -> None:
        self.clamd = clamd
        self.clock = clock
        self.read_timeout = read_timeout
        self.ready_wait = ready_wait
        self.ready = threading.Event()
        # One at a time: the Worker sends one, and a second would only compete for the same memory.
        self.one_at_a_time = threading.Lock()

    def database(self) -> Database | None:
        try:
            return parse_version(self.clamd.version())
        except NoAnswer:
            return None

    def fresh_database(self) -> Database | None:
        database = self.database()
        return database if is_fresh(database, self.clock()) else None


def _handler_for(scanner: Scanner) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        timeout = scanner.read_timeout

        def log_message(self, *_):  # The default would log request lines.
            pass

        def answer(self, status: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.close_connection = True
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.send_header("connection", "close")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):  # pylint: disable=invalid-name
            if self.path == "/live":
                return self.answer(200, {"live": True})
            if self.path == "/ready":
                return self.readiness()
            return self.answer(404, {"error": "not_found"})

        def readiness(self) -> None:
            if not scanner.ready.wait(scanner.ready_wait):
                return self.answer(503, {"error": "not_ready"})
            database = scanner.fresh_database()
            if database is None:
                return self.answer(503, {"error": "signatures_stale"})
            return self.answer(200, {"ready": True, "database": database.as_json()})

        def do_POST(self):  # pylint: disable=invalid-name
            if self.path != "/scan":
                return self.answer(404, {"error": "not_found"})
            try:
                length = int(self.headers.get("content-length", ""))
            except ValueError:
                return self.answer(411, {"error": "length_required"})
            expected = self.headers.get("x-expected-sha256", "")
            if length < 0 or not _SHA256.fullmatch(expected):
                return self.answer(400, {"error": "bad_request"})
            if not scanner.ready.wait(scanner.ready_wait):
                return self.answer(503, {"error": "not_ready"})
            if not scanner.one_at_a_time.acquire(blocking=False):
                return self.answer(503, {"error": "busy"})
            try:
                return self.scan(length, expected)
            finally:
                scanner.one_at_a_time.release()

        def scan(self, length: int, expected: str) -> None:
            if scanner.fresh_database() is None:
                return self.answer(503, {"error": "signatures_stale"})
            if length > MAX_BYTES:
                return self.finish_scan("", length, verdict.UNREADABLE, "too_large_to_scan")
            hasher = hashlib.sha256()
            with tempfile.TemporaryFile(dir="/tmp") as copy:
                try:
                    reply = self.stream(length, copy, hasher)
                except (OSError, ValueError, NoAnswer) as problem:
                    # The file stopped arriving or clamd fell over. A timeout lands here too, so a stall can't keep this awake.
                    return self.answer(503, {"error": "scan_interrupted", "kind": type(problem).__name__})
                sha256 = hasher.hexdigest()
                if sha256 != expected:
                    return self.finish_scan(sha256, length, verdict.UNREADABLE, "hash_mismatch")
                report, reason = verdict.from_clamd(reply)
                if report == verdict.NO_KNOWN_MALWARE and (problem := archive.archive_problem(copy)):
                    report, reason = verdict.UNREADABLE, problem
            return self.finish_scan(sha256, length, report, reason)

        def stream(self, length: int, copy, hasher) -> str:
            scan = scanner.clamd.begin()
            try:
                left = length
                while left > 0:
                    chunk = self.rfile.read(min(CHUNK, left))
                    if not chunk:
                        raise ValueError("body ended early")
                    left -= len(chunk)
                    hasher.update(chunk)
                    copy.write(chunk)
                    scan.send(chunk)
                return scan.finish()
            finally:
                scan.close()

        def finish_scan(self, sha256: str, length: int, report: str, reason: str) -> None:
            # Asked again, because a verdict mustn't come from signatures that went stale during the scan.
            database = scanner.fresh_database()
            if database is None:
                return self.answer(503, {"error": "signatures_stale"})
            return self.answer(200, {"report": report, "reason": reason, "sha256": sha256, "bytes": length, "database": database.as_json()})

    return Handler


def make_server(scanner: Scanner, port: int = 8080, host: str = "0.0.0.0") -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), _handler_for(scanner))


def watch_clamd(scanner: Scanner, config: str = "/etc/clamav/scan.conf") -> None:
    """Starts clamd, and exits if it stops. A scanner without it can't recover, so the next request starts a fresh Container."""
    process = subprocess.Popen(["clamd", "-c", config], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    while process.poll() is None:
        if scanner.clamd.ping():
            scanner.ready.set()
            break
        time.sleep(0.1)
    process.wait()
    scanner.ready.clear()
    os._exit(1)


def main(clock=time.time) -> None:
    scanner = Scanner(SocketClamd(), clock=clock)
    threading.Thread(target=watch_clamd, args=(scanner,), daemon=True).start()
    make_server(scanner).serve_forever()


if __name__ == "__main__":
    main()
