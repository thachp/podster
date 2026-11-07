"""Reads every zip through, because clamd answers OK for an archive it stopped reading at a limit or couldn't parse.

This is what catches a bomb, an entry past clamd's limit, a damaged zip and a password-protected OpenDocument file. Anything
that stops the walk means the file wasn't read, so it returns a reason. It only reads zips: a zip inside gzip, 7z or rar isn't
walked, and the upload type check decides whether those arrive at all.
"""
from __future__ import annotations

import re
import tempfile
import time
import zipfile
from typing import BinaryIO

# The same limits as scan.conf.
MAX_UNPACKED_BYTES = 400 * 1000 * 1000
MAX_ENTRY_BYTES = 150 * 1000 * 1000
MAX_DEPTH = 10
MAX_ENTRIES = 10_000
MAX_SECONDS = 120.0
MAX_MANIFEST_BYTES = 4 * 1024 * 1024
CHUNK = 64 * 1024

UNREADABLE = "unreadable_archive"
PASSWORD_PROTECTED = "password_protected"

_ENCRYPTION = re.compile(rb"<\s*(?:[^\s<>:/]+:)?encryption-data[\s/>]")
_ENTITY = re.compile(rb"<!ENTITY")
_MANIFEST = "meta-inf/manifest.xml"


class _Stop(Exception):
    """A limit was reached, with the reason to report."""


def _is_manifest(name: str) -> bool:
    return name.replace("\\", "/").lstrip("/").lower() == _MANIFEST


def manifest_problem(manifest: bytes) -> str | None:
    """An encrypted OpenDocument file says so here and leaves the zip's own flags at 0, so nothing else can tell.

    It looks for the element and doesn't parse the XML, so a hostile manifest has nothing to expand. An entity could spell the
    element some other way, and a comment can trigger the match, and both of those block. A real manifest has neither.
    """
    if manifest.startswith((b"\xff\xfe", b"\xfe\xff")):
        try:
            manifest = manifest.decode("utf-16").encode()
        except UnicodeError:
            return UNREADABLE
    elif b"\0" in manifest:
        # Another way to hide the words from the search below.
        return UNREADABLE
    if _ENTITY.search(manifest):
        return UNREADABLE
    return PASSWORD_PROTECTED if _ENCRYPTION.search(manifest) else None


class _Walk:
    def __init__(self, clock=time.monotonic) -> None:
        self.left = MAX_UNPACKED_BYTES
        self.clock = clock
        self.deadline = clock() + MAX_SECONDS

    def zip(self, source: BinaryIO, depth: int) -> None:
        if depth > MAX_DEPTH:
            raise _Stop("archive_too_deep")
        with zipfile.ZipFile(source) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_ENTRIES:
                raise _Stop("archive_too_many_files")
            for entry in entries:
                if entry.flag_bits & 0x1:
                    raise _Stop(PASSWORD_PROTECTED)
                self.entry(archive, entry, depth)

    def entry(self, archive: zipfile.ZipFile, entry: zipfile.ZipInfo, depth: int) -> None:
        manifest = bytearray() if _is_manifest(entry.filename) else None
        with tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024, dir="/tmp") as copy:
            seen = 0
            with archive.open(entry) as stream:
                while chunk := stream.read(CHUNK):
                    seen += len(chunk)
                    self.left -= len(chunk)
                    if seen > MAX_ENTRY_BYTES:
                        raise _Stop("archive_entry_too_large")
                    if self.left < 0:
                        raise _Stop("archive_too_large_unpacked")
                    if self.clock() > self.deadline:
                        raise _Stop("archive_took_too_long")
                    copy.write(chunk)
                    if manifest is not None:
                        if seen > MAX_MANIFEST_BYTES:
                            raise _Stop(UNREADABLE)
                        manifest.extend(chunk)
            if manifest is not None and (problem := manifest_problem(bytes(manifest))):
                raise _Stop(problem)
            copy.seek(0)
            # By its directory, not its first bytes, so a zip with something in front of it is still read.
            if zipfile.is_zipfile(copy):
                copy.seek(0)
                self.zip(copy, depth + 1)


def archive_problem(source: BinaryIO, clock=time.monotonic) -> str | None:
    """None only if the file isn't a zip, or every entry of every zip in it was read to the end within the limits."""
    try:
        source.seek(0)
        starts_as_zip = source.read(2) == b"PK"
        source.seek(0)
        if not zipfile.is_zipfile(source):
            # A file that starts like a zip and isn't one wasn't read.
            return UNREADABLE if starts_as_zip else None
        source.seek(0)
        _Walk(clock).zip(source, 0)
        return None
    except _Stop as stop:
        return str(stop)
    except Exception:  # pylint: disable=broad-except
        # Hostile input can raise anything. Whatever stopped the walk, the file wasn't read to the end.
        return UNREADABLE
