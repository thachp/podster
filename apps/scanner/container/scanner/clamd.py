"""Talks to clamd over its socket. A failure here raises `NoAnswer`, which is never a verdict."""
from __future__ import annotations

import socket
import struct
from typing import Protocol

SCAN_TIMEOUT_SECONDS = 180.0


class NoAnswer(Exception):
    """clamd fell over or said nothing."""


class Clamd(Protocol):
    def version(self) -> str: ...
    def ping(self) -> bool: ...
    def begin(self) -> "StreamScan": ...


class StreamScan:
    """One INSTREAM scan, fed a chunk at a time, so the file is never held in memory."""

    def __init__(self, path: str) -> None:
        self.sock = socket.socket(socket.AF_UNIX)
        try:
            self.sock.settimeout(SCAN_TIMEOUT_SECONDS)
            self.sock.connect(path)
            self.sock.sendall(b"zINSTREAM\0")
        except OSError as problem:
            self.sock.close()
            raise NoAnswer(type(problem).__name__) from problem

    def send(self, chunk: bytes) -> None:
        try:
            self.sock.sendall(struct.pack("!L", len(chunk)) + chunk)
        except OSError as problem:
            raise NoAnswer(type(problem).__name__) from problem

    def finish(self) -> str:
        try:
            self.sock.sendall(struct.pack("!L", 0))
            reply = self.sock.makefile("rb").read()
        except OSError as problem:
            raise NoAnswer(type(problem).__name__) from problem
        text = reply.rstrip(b"\0\n").decode(errors="replace")
        # Silence means clamd fell over, and it mustn't read as a detection or a pass.
        if not text:
            raise NoAnswer("empty")
        return text

    def close(self) -> None:
        self.sock.close()


class SocketClamd:
    def __init__(self, path: str = "/tmp/clamd.sock") -> None:
        self.path = path

    def _ask(self, command: str) -> str:
        with socket.socket(socket.AF_UNIX) as sock:
            sock.settimeout(10)
            sock.connect(self.path)
            sock.sendall(f"z{command}\0".encode())
            return sock.makefile("rb").read().rstrip(b"\0\n").decode(errors="replace")

    def ping(self) -> bool:
        try:
            return self._ask("PING") == "PONG"
        except OSError:
            return False

    def version(self) -> str:
        try:
            return self._ask("VERSION")
        except OSError as problem:
            raise NoAnswer(type(problem).__name__) from problem

    def begin(self) -> StreamScan:
        return StreamScan(self.path)
