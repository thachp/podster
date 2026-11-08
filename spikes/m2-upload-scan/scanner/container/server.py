#!/usr/bin/env python3
"""Throwaway: takes one file at a time over HTTP, streams it to clamd and answers with a verdict.

It logs no file names or contents, and it holds no secrets. A verdict of `blocked` covers everything clamd flags or can't
read. A non-200 answer means no verdict was reached, which is never a pass.
"""
import io
import json
import os
import socket
import struct
import subprocess
import tempfile
import threading
import time
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SOCKET = "/tmp/clamd.sock"
MAX_BYTES = 105 * 1000 * 1000
READY_WAIT_SECONDS = 600
CHUNK = 64 * 1024
READ_TIMEOUT_SECONDS = int(os.environ.get("SCAN_READ_TIMEOUT", "60"))
# The same limits as scan.conf. clamd stops at these without saying so for some archives, so this walk says so.
MAX_UNPACKED = 400 * 1000 * 1000
MAX_ENTRY = 150 * 1000 * 1000
MAX_DEPTH = 10
MAX_FILES = 10000

started = time.monotonic()
ready = threading.Event()
state = {"cold_start_ms": None, "clamd_exit": None}
clamd = None


def ask(command):
    with socket.socket(socket.AF_UNIX) as sock:
        sock.settimeout(10)
        sock.connect(SOCKET)
        sock.sendall(f"z{command}\0".encode())
        return sock.makefile("rb").read().rstrip(b"\0\n").decode()


def run_clamd():
    global clamd
    clamd = subprocess.Popen(["clamd", "-c", "/etc/clamav/scan.conf"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    while clamd.poll() is None:
        try:
            if ask("PING") == "PONG":
                state["cold_start_ms"] = round((time.monotonic() - started) * 1000)
                ready.set()
                break
        except OSError:
            pass
        time.sleep(0.1)
    state["clamd_exit"] = clamd.wait()
    ready.clear()
    # A scanner with no clamd can't recover. Exiting drops any scan in progress without a verdict, and the next request starts fresh.
    os._exit(1)


CLOUDFLARE_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt"
SYSTEM_CA = "/etc/ssl/certs/ca-certificates.crt"


def trust_env():
    """An allowed HTTPS host is reached through Cloudflare's interception, so its CA has to be trusted. Only a deployment has one to test."""
    env = dict(os.environ)
    if os.path.exists(CLOUDFLARE_CA):
        bundle = "/tmp/ca-bundle.pem"
        with open(bundle, "wb") as out:
            for source in (SYSTEM_CA, CLOUDFLARE_CA):
                if os.path.exists(source):
                    with open(source, "rb") as handle:
                        out.write(handle.read() + b"\n")
        env.update({"SSL_CERT_FILE": bundle, "CURL_CA_BUNDLE": bundle})
    return env


def update_signatures():
    """Only on request, and it reaches only the mirror the Worker allows. Disk is lost when the Container sleeps, so this measures the cost, not a way to stay current."""
    ready.wait(READY_WAIT_SECONDS)
    begun = time.monotonic()
    done = subprocess.run(["freshclam", "--stdout", "--no-warnings"], capture_output=True, timeout=600, check=False, env=trust_env())
    result = {"exit": done.returncode, "ms": round((time.monotonic() - begun) * 1000), "before_reload": memory()}
    if done.returncode == 0:
        reload_begun = time.monotonic()
        ask("RELOAD")
        time.sleep(0.2)
        while True:
            try:
                if ask("PING") == "PONG":
                    break
            except OSError:
                pass
            time.sleep(0.2)
        result["reload_ms"] = round((time.monotonic() - reload_begun) * 1000)
    return {**result, "version": ask("VERSION"), "after": memory()}


def memory():
    def read(path):
        try:
            with open(path, encoding="ascii") as handle:
                return int(handle.read().strip())
        except (OSError, ValueError):
            return None

    rss = None
    if clamd and clamd.poll() is None:
        try:
            with open(f"/proc/{clamd.pid}/status", encoding="ascii") as handle:
                for line in handle:
                    if line.startswith("VmRSS:"):
                        rss = int(line.split()[1]) * 1024
        except OSError:
            pass
    return {"clamd_rss": rss, "cgroup_now": read("/sys/fs/cgroup/memory.current"), "cgroup_peak": read("/sys/fs/cgroup/memory.peak"), "cgroup_limit": read("/sys/fs/cgroup/memory.max")}


class Handler(BaseHTTPRequestHandler):
    # A stalled upload shouldn't keep the Container awake and billing. It ends as no verdict, which the queue retries.
    timeout = READ_TIMEOUT_SECONDS

    def log_message(self, *_):
        pass

    def answer(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.send_header("connection", "close")
        self.close_connection = True
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/live":
            return self.answer(200, {"live": True})
        if self.path == "/health":
            version = None
            if ready.is_set():
                try:
                    version = ask("VERSION")
                except OSError:
                    pass
            return self.answer(200, {"ready": ready.is_set(), **state, "memory": memory(), "version": version})
        if self.path == "/egress-check":
            # Shows the allowlist working: the mirror may answer, and anything else mustn't.
            return self.answer(200, {host: reach(host) for host in ("database.clamav.net", "example.com")})
        return self.answer(404, {"error": "not_found"})

    def do_POST(self):
        if self.path == "/update-signatures":
            return self.answer(200, update_signatures())
        if self.path != "/scan":
            return self.answer(404, {"error": "not_found"})
        try:
            length = int(self.headers.get("content-length", ""))
        except ValueError:
            return self.answer(411, {"error": "length_required"})
        if length > MAX_BYTES:
            return self.answer(200, {"verdict": "blocked", "reason": "too_large_to_scan"})
        waited = time.monotonic()
        if not ready.wait(READY_WAIT_SECONDS):
            return self.answer(503, {"error": "scanner_not_ready"})
        waited_ms = round((time.monotonic() - waited) * 1000)
        begun = time.monotonic()
        with tempfile.TemporaryFile(dir="/tmp") as copy:
            try:
                reply = self.stream_to_clamd(length, copy)
            except (OSError, ValueError) as problem:
                # The scanner fell over or the file stopped arriving. That's no verdict, and it isn't a pass.
                return self.answer(503, {"error": "scan_interrupted", "kind": type(problem).__name__})
            scan_ms = round((time.monotonic() - begun) * 1000)
            result = verdict(reply)
            walked = time.monotonic()
            problem = archive_problem(copy) if result["verdict"] == "clean" else None
            walk_ms = round((time.monotonic() - walked) * 1000)
        if problem:
            result = {"verdict": "blocked", "reason": problem, "clamd_said": "OK"}
        return self.answer(200, {**result, "scan_ms": scan_ms, "archive_walk_ms": walk_ms, "waited_for_ready_ms": waited_ms, "cold_start_ms": state["cold_start_ms"], "memory": memory()})

    def stream_to_clamd(self, length, copy):
        with socket.socket(socket.AF_UNIX) as sock:
            sock.settimeout(180)
            sock.connect(SOCKET)
            sock.sendall(b"zINSTREAM\0")
            left = length
            while left > 0:
                chunk = self.rfile.read(min(CHUNK, left))
                if not chunk:
                    raise ValueError("body ended early")
                left -= len(chunk)
                copy.write(chunk)
                sock.sendall(struct.pack("!L", len(chunk)) + chunk)
            sock.sendall(struct.pack("!L", 0))
            reply = sock.makefile("rb").read().rstrip(b"\0\n").decode(errors="replace")
            # No answer means clamd fell over. That's no verdict, and it mustn't read as a detection.
            if not reply:
                raise ValueError("clamd gave no answer")
            return reply


def verdict(reply):
    """Only clamd's plain OK is clean. Everything else it says is blocked, including words this code doesn't know."""
    if reply == "stream: OK":
        return {"verdict": "clean"}
    if reply.endswith(" FOUND"):
        return {"verdict": "blocked", "reason": reply.removeprefix("stream: ").removesuffix(" FOUND")[:120]}
    return {"verdict": "blocked", "reason": "unreadable", "detail": reply[:120]}


def archive_problem(handle):
    """clamd answers OK for an archive it stopped reading at a limit, or couldn't parse. That isn't a file it has read."""
    handle.seek(0)
    if handle.read(2) != b"PK":
        return None
    handle.seek(0)
    budget = [MAX_UNPACKED]
    try:
        return walk_zip(handle, 0, budget)
    except Exception:  # pylint: disable=broad-except
        # Whatever stopped the walk, it didn't finish reading the file, and that's what blocked means.
        return "unreadable_archive"


def walk_zip(source, depth, budget):
    """Decompresses to count, keeping only what might be another archive. It stops at the first limit, so a bomb costs little."""
    if depth > MAX_DEPTH:
        return "archive_too_deep"
    with zipfile.ZipFile(source) as archive:
        entries = archive.infolist()
        if len(entries) > MAX_FILES:
            return "archive_too_many_files"
        for entry in entries:
            kept = bytearray()
            seen = 0
            is_zip = None
            with archive.open(entry) as stream:
                while chunk := stream.read(CHUNK):
                    if is_zip is None:
                        is_zip = chunk[:2] == b"PK"
                    seen += len(chunk)
                    budget[0] -= len(chunk)
                    if seen > MAX_ENTRY:
                        return "archive_entry_too_large"
                    if budget[0] < 0:
                        return "archive_too_large_unpacked"
                    if is_zip:
                        kept.extend(chunk)
            if is_zip:
                problem = walk_zip(io.BytesIO(kept), depth + 1, budget)
                if problem:
                    return problem
    return None


def reach(host):
    os.environ.update({key: value for key, value in trust_env().items() if key in ("SSL_CERT_FILE", "CURL_CA_BUNDLE")})
    # A status doesn't prove the host answered: Cloudflare's proxy can answer for a host it denies.
    try:
        with urllib.request.urlopen(f"https://{host}/", timeout=8) as response:
            return {"status": response.status}
    except urllib.error.HTTPError as problem:
        return {"status": problem.code, "server": problem.headers.get("server")}
    except OSError as problem:
        return {"error": type(problem).__name__}


if __name__ == "__main__":
    threading.Thread(target=run_clamd, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
