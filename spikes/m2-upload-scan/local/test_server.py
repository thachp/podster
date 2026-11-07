#!/usr/bin/env python3
"""The verdict rules and the archive walk, without Docker. Run it as `python3 local/test_server.py`."""
import importlib.util
import io
import os
import struct
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("server", os.path.join(HERE, "..", "scanner", "container", "server.py"))
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
failed = 0


def check(name, actual, expected):
    global failed
    ok = actual == expected
    failed += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}: {actual}")


def zipped(entries, method=zipfile.ZIP_DEFLATED):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", method) as archive:
        for name, data in entries:
            archive.writestr(name, data)
    return buffer.getvalue()


def walk(data):
    return server.archive_problem(io.BytesIO(data))


check("only a plain OK is clean", server.verdict("stream: OK"), {"verdict": "clean"})
check("a detection names itself", server.verdict("stream: Some.Virus FOUND")["reason"], "Some.Virus")
check("words it doesn't know are blocked", server.verdict("stream: odd")["verdict"], "blocked")
check("not an archive isn't walked", walk(b"plain text"), None)
check("a clean nested zip passes", walk(zipped([("a.txt", b"x"), ("b.zip", zipped([("c.txt", b"y")]))])), None)
check("a fake zip is unreadable", walk(b"PK\x03\x04" + b"\0" * 100), "unreadable_archive")

# The exceptions the walk didn't list by name. Each one has to be blocked, not a retry.
real = server.walk_zip
for problem in (MemoryError(), RecursionError(), KeyError("x"), struct.error("x"), Exception("anything")):

    def raises(*_args, problem=problem):
        raise problem

    server.walk_zip = raises
    check(f"{type(problem).__name__} is unreadable", walk(zipped([("a.txt", b"x")])), "unreadable_archive")
server.walk_zip = real

try:
    import lzma

    good = bytearray(zipped([("a.bin", os.urandom(4096))], zipfile.ZIP_LZMA))
    for offset in range(40, 120):
        good[offset] ^= 0xFF
    check("real lzma damage is unreadable", walk(bytes(good)), "unreadable_archive")
except ImportError:
    print("skip no lzma here")

raise SystemExit(1 if failed else 0)
