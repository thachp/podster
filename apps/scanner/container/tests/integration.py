#!/usr/bin/env python3
"""The real image, with real clamd and real signatures, and no network: `python3 tests/integration.py IMAGE`.

Not part of CI, because the image needs current signatures from the mirror, which limits how often anyone can build. It runs
each file the spike ran, and more, and it's the local half of "fail closed". What only a deployment can show stays on the plan.
"""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import fixtures as f  # noqa: E402

HERE = pathlib.Path(__file__).parent


def docker(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", *args], capture_output=True, text=True, check=check)


# Runs inside the Container, because with no network there's no port to publish. It only copies bytes to and from the server.
RELAY = """
import socket, sys, threading
sock = socket.create_connection(("127.0.0.1", 8080), timeout=600)
def send():
    while chunk := sys.stdin.buffer.read1(65536):
        try:
            sock.sendall(chunk)
        except OSError:
            return
threading.Thread(target=send, daemon=True).start()
while chunk := sock.recv(65536):
    sys.stdout.buffer.write(chunk)
    sys.stdout.buffer.flush()
"""


class Box:
    """One running Container with no network at all, not even Docker's bridge."""

    def __init__(self, image: str, *extra: str, command: tuple[str, ...] = ()) -> None:
        self.name = f"podster-scan-test-{uuid.uuid4().hex[:8]}"
        docker("run", "-d", "--rm", "--name", self.name, "--memory=4g", "--network", "none", *extra, image, *command)

    def exec(self, *command: str) -> subprocess.CompletedProcess:
        return docker("exec", self.name, *command, check=False)

    def running(self) -> bool:
        return docker("inspect", "-f", "{{.State.Running}}", self.name, check=False).stdout.strip() == "true"

    def stop(self) -> None:
        docker("rm", "-f", self.name, check=False)

    def open(self) -> subprocess.Popen:
        return subprocess.Popen(["docker", "exec", "-i", self.name, "python3", "-c", RELAY], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

    def request(self, method: str, path: str, body: bytes = b"", headers: dict | None = None) -> tuple[int, dict]:
        head = "".join(f"{name}: {value}\r\n" for name, value in (headers or {}).items())
        relay = self.open()
        out, _ = relay.communicate(f"{method} {path} HTTP/1.1\r\nhost: x\r\n{head}\r\n".encode() + body)
        if not out:
            raise OSError("no answer")
        top, _, rest = out.partition(b"\r\n\r\n")
        return int(top.split()[1]), json.loads(rest or b"{}")

    def wait_ready(self, seconds: float = 180) -> tuple[int, dict]:
        deadline = time.time() + seconds
        while time.time() < deadline:
            try:
                return self.request("GET", "/ready")
            except (OSError, ValueError, IndexError):
                time.sleep(0.5)
        raise TimeoutError("never answered /ready")

    def scan(self, data: bytes) -> tuple[int, dict]:
        return self.request("POST", "/scan", body=data, headers={"content-length": len(data), "x-expected-sha256": hashlib.sha256(data).hexdigest()})


def real_password_zip() -> bytes:
    with tempfile.TemporaryDirectory() as folder:
        path = pathlib.Path(folder)
        (path / "plain.txt").write_bytes(b"Inside a locked archive.\n")
        subprocess.run(["zip", "-q", "-P", "pass", "locked.zip", "plain.txt"], cwd=path, check=True)
        return (path / "locked.zip").read_bytes()


def verdict_cases():
    yield "small text", b"An ordinary note.\n" * 100, "no_known_malware", "none"
    yield "empty", b"", "no_known_malware", "none"
    yield "100 MB of random bytes", os.urandom(100 * 1000 * 1000), "no_known_malware", "none"
    yield "ordinary archive", f.zipped([("a.txt", b"note\n" * 1000), ("inner.zip", f.zipped([("b.txt", b"note\n" * 1000)]))]), "no_known_malware", "none"
    yield "ordinary OpenDocument", f.odf(), "no_known_malware", "none"
    yield "EICAR", f.EICAR, "malware_found", None
    yield "EICAR in a zip", f.zipped([("note.txt", f.EICAR)]), "malware_found", None
    yield "EICAR in a nested zip", f.nested(f.EICAR, 3), "malware_found", None
    yield "password-protected zip", real_password_zip(), "unreadable", "password_protected"
    yield "password-protected zip, flags only", f.flagged_encrypted(f.zipped([("a.txt", b"hidden")])), "unreadable", None
    yield "password-protected OpenDocument", f.odf(f.ENCRYPTED_MANIFEST), "unreadable", "password_protected"
    yield "password-protected OpenDocument in a zip", f.zipped([("report.odt", f.odf(f.ENCRYPTED_MANIFEST))]), "unreadable", "password_protected"
    yield "zip expanding to 2 GB", f.zeros_zip(2048), "unreadable", None
    yield "zip 15 levels deep", f.nested(b"note\n", 15), "unreadable", None
    yield "zip of 20,000 files", f.many_files(20_000), "unreadable", None
    yield "nested zip expanding to 655 GB", f.wide_bomb(), "unreadable", None
    yield "EICAR past the limit in an entry", f.zeros_zip(160, f.EICAR), "unreadable", None
    yield "the same with a line in front of it", b"#!/bin/sh\n" + f.zeros_zip(160, f.EICAR), "unreadable", None
    yield "truncated zip", f.truncated(), "unreadable", None
    yield "fake zip", b"PK\x03\x04" + os.urandom(4096), "unreadable", None
    yield "zip damaged inside its LZMA data", f.corrupt_lzma(), "unreadable", None


def main(image: str) -> int:
    failures = []

    def expect(name: str, good: bool, detail: object = "") -> None:
        print(f"{'ok  ' if good else 'FAIL'} {name}{f' ({detail})' if detail != '' else ''}", flush=True)
        if not good:
            failures.append(name)

    boxes: list[Box] = []
    try:
        box = Box(image)
        boxes.append(box)
        began = time.time()
        status, ready = box.wait_ready()
        expect("ready, with fresh signatures", status == 200, f"{time.time() - began:.1f} s, database {ready.get('database')}")
        for name, data, report, reason in verdict_cases():
            began = time.time()
            status, body = box.scan(data)
            good = status == 200 and body.get("report") == report and (reason is None or body.get("reason") == reason) and body.get("database", {}).get("version") == ready["database"]["version"]
            expect(name, good, f"{status}, {body.get('report')}, {body.get('reason', body.get('error'))}, {time.time() - began:.1f} s")

        status, body = box.request("POST", "/scan", body=b"hello", headers={"content-length": 5, "x-expected-sha256": "0" * 64})
        expect("bytes that aren't the expected ones block", (status, body.get("reason")) == (200, "hash_mismatch"), body.get("reason"))

        reach = box.exec("python3", "-c", "import socket; socket.create_connection(('1.1.1.1', 443), timeout=5)")
        expect("nothing outside can be reached", reach.returncode != 0, "with --network none, which says nothing about Cloudflare's")
        expect("the updater isn't in the image", box.exec("sh", "-c", "command -v freshclam").returncode != 0)
        expect("not running as root", box.exec("id", "-u").stdout.strip() != "0", box.exec("id", "-un").stdout.strip())
        env = box.exec("env").stdout
        expect("no secret in its environment", not any(word in env.upper() for word in ("SECRET", "TOKEN", "API_KEY", "PASSWORD")))
        logs = docker("logs", box.name).stdout + docker("logs", box.name).stderr
        expect("logs nothing about files", "EICAR" not in logs and "note" not in logs and "POST" not in logs, f"{len(logs)} characters")

        # A stalled upload ends with no verdict, after the server's 60 s read timeout. Stdin stays open, so the file just stops.
        relay = box.open()
        relay.stdin.write(b"POST /scan HTTP/1.1\r\nhost: x\r\ncontent-length: 1000\r\nx-expected-sha256: " + b"0" * 64 + b"\r\n\r\npartial")
        relay.stdin.flush()
        began = time.time()
        answer = relay.stdout.read()
        relay.kill()
        expect("a stalled upload gets no verdict", b" 503 " in answer[:20] and b"report" not in answer and time.time() - began > 50, f"{time.time() - began:.0f} s, {answer[:15]!r}")

        # clamd dying partway through. The connection stops or answers 503, never 200, and the Container goes.
        data = os.urandom(50 * 1000 * 1000)
        relay = box.open()
        relay.stdin.write(b"POST /scan HTTP/1.1\r\nhost: x\r\ncontent-length: %d\r\nx-expected-sha256: %s\r\n\r\n" % (len(data), hashlib.sha256(data).hexdigest().encode()))
        relay.stdin.write(data[:1000 * 1000])
        relay.stdin.flush()
        time.sleep(1)
        kill = box.exec("python3", "-c", "import os\nfor p in os.listdir('/proc'):\n  if p.isdigit():\n    try:\n      if open(f'/proc/{p}/comm').read().strip() == 'clamd': os.kill(int(p), 9)\n    except OSError: pass")
        answer = b""
        try:
            relay.stdin.write(data[1000 * 1000:])
            relay.stdin.close()
        except OSError:
            pass
        answer = relay.stdout.read()
        relay.kill()
        expect("clamd dying gives no verdict", kill.returncode == 0 and b" 200 " not in answer[:20] and b"report" not in answer, answer[:15])
        time.sleep(3)
        expect("the Container exits with clamd", not box.running())

        # Real clamd and real signatures, on a clock 8 days past them.
        aged = Box(image, "-v", f"{HERE / 'aged_main.py'}:/opt/podster/aged_main.py:ro", "--entrypoint", "python3", command=("/opt/podster/aged_main.py",))
        boxes.append(aged)
        status, body = aged.wait_ready()
        expect("past 7 days it isn't ready", (status, body.get("error")) == (503, "signatures_stale"), body)
        for name, data in (("clean", b"An ordinary note.\n"), ("EICAR", f.EICAR)):
            status, body = aged.scan(data)
            expect(f"past 7 days, no verdict on {name}", (status, body.get("error")) == (503, "signatures_stale") and "report" not in body, body)
    finally:
        for box in boxes:
            box.stop()
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
