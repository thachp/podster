"""Reads every zip through, because clamd answers OK for an archive it stopped reading at a limit or couldn't parse.

This is what catches a bomb, an entry past clamd's limit, a damaged zip and a password-protected OpenDocument file. Anything
that stops the walk means the file wasn't read, so it returns a reason.

The headers are only claims, and other tools read the real stream, so this doesn't use zipfile to read entries. zipfile stops at
the declared size, which would let a small claim hide a large entry. It's used only for the directory. Each entry's own stream is
then decompressed here to its real end, and has to agree with both headers. Only stored and deflate are read: bzip2 and LZMA can
produce gigabytes from a single read, before any limit could run. A real file that uses them is blocked, which is the safe way
to be wrong.

It only reads zips. A zip inside gzip, 7z or rar isn't walked, and the upload type check decides whether those arrive at all.
"""
from __future__ import annotations

import bisect
import posixpath
import re
import struct
import tempfile
import time
import zipfile
import zlib
from typing import BinaryIO, Iterator

# The same limits as scan.conf.
MAX_UNPACKED_BYTES = 400 * 1000 * 1000
MAX_ENTRY_BYTES = 150 * 1000 * 1000
MAX_DEPTH = 10
MAX_ENTRIES = 10_000
MAX_SECONDS = 120.0
MAX_MANIFEST_BYTES = 4 * 1024 * 1024
CHUNK = 64 * 1024
SCAN_CHUNK = 1024 * 1024

UNREADABLE = "unreadable_archive"
PASSWORD_PROTECTED = "password_protected"
METHOD_NOT_SUPPORTED = "archive_method_not_supported"

_MANIFEST = "meta-inf/manifest.xml"
_ENCRYPTION = re.compile(rb"<\s*(?:[^\s<>:/]+:)?encryption-data[\s/>]")
_ENTITY = re.compile(rb"<!ENTITY")
_DECLARED = re.compile(rb"""<\?xml[^>]*?\bencoding\s*=\s*["']([^"']*)""", re.IGNORECASE)
_READABLE_ENCODINGS = (b"utf-8", b"utf8", b"utf-16", b"utf16")

_LOCAL_HEADER = struct.Struct("<4sHHHHHLLLHH")
_LOCAL_SIGNATURE = b"PK\x03\x04"
_ZIP_STARTS = (_LOCAL_SIGNATURE, b"PK\x01\x02", b"PK\x05\x06", b"PK\x07\x08", b"PK\x06\x06")
# A local header's signature, a version a zip tool would write, and a method number that exists. Just the signature turns up by
# chance in about one 100 MB compressed file in 40, and this makes that vanishingly rare.
_LOOKS_LOCAL = re.compile(rb"PK\x03\x04[\x00-\x3f].{3}[\x00-\x63]\x00", re.DOTALL)
_OVERLAP = 12
_ENCRYPTED = 0x1
_DESCRIPTOR = 0x8
_UTF8_NAME = 0x800
_ZIP64_SIZE = 0xFFFFFFFF


class _Stop(Exception):
    """A limit was reached, with the reason to report."""


def _is_manifest(name: str) -> bool:
    return posixpath.normpath(name.replace("\\", "/")).lstrip("/").lower() == _MANIFEST


def manifest_problem(manifest: bytes) -> str | None:
    """An encrypted OpenDocument file says so here and leaves the zip's own flags at 0, so nothing else can tell.

    It looks for the element and doesn't parse the XML, so a hostile manifest has nothing to expand. So it has to be sure it can
    read the text: an encoding it can't search, or an entity that could spell the element another way, blocks. A comment can
    trigger the match, which also blocks. A real manifest has none of these.
    """
    if manifest.startswith((b"\xff\xfe", b"\xfe\xff")):
        try:
            manifest = manifest.decode("utf-16").encode()
        except UnicodeError:
            return UNREADABLE
    elif manifest.startswith(b"\xef\xbb\xbf"):
        manifest = manifest[3:]
    # UTF-32 and UTF-16 with no BOM land here, as does anything else hiding the words from the search below.
    if b"\0" in manifest or not manifest.lstrip().startswith(b"<"):
        return UNREADABLE
    declared = _DECLARED.search(manifest)
    if declared and declared.group(1).strip().lower() not in _READABLE_ENCODINGS:
        return UNREADABLE
    if _ENTITY.search(manifest):
        return UNREADABLE
    return PASSWORD_PROTECTED if _ENCRYPTION.search(manifest) else None


def _local_headers(source: BinaryIO) -> Iterator[int]:
    """Where anything in this file looks like the start of a zip entry, without holding the file in memory."""
    source.seek(0)
    offset = 0
    tail = b""
    while chunk := source.read(SCAN_CHUNK):
        window = tail + chunk
        for match in _LOOKS_LOCAL.finditer(window):
            yield offset - len(tail) + match.start()
        tail = window[-_OVERLAP:]
        offset += len(chunk)


def _looks_like_a_zip(source: BinaryIO) -> bool:
    source.seek(0)
    if source.read(4).startswith(_ZIP_STARTS):
        return True
    return next(_local_headers(source), None) is not None


class _Entry:
    """What one entry has produced so far, against the limits."""

    def __init__(self, walk: "_Walk", copy, keep_manifest: bool) -> None:
        self.walk = walk
        self.copy = copy
        self.seen = 0
        self.crc = 0
        self.manifest = bytearray() if keep_manifest else None

    def take(self, data: bytes) -> None:
        self.seen += len(data)
        self.walk.left -= len(data)
        if self.seen > MAX_ENTRY_BYTES:
            raise _Stop("archive_entry_too_large")
        if self.walk.left < 0:
            raise _Stop("archive_too_large_unpacked")
        if self.walk.clock() > self.walk.deadline:
            raise _Stop("archive_took_too_long")
        self.crc = zlib.crc32(data, self.crc)
        self.copy.write(data)
        if self.manifest is not None:
            if self.seen > MAX_MANIFEST_BYTES:
                raise _Stop(UNREADABLE)
            self.manifest.extend(data)


class _Walk:
    def __init__(self, clock=time.monotonic) -> None:
        self.left = MAX_UNPACKED_BYTES
        self.clock = clock
        self.deadline = clock() + MAX_SECONDS

    def contents(self, source: BinaryIO, depth: int) -> None:
        """A zip gets read. Something that looks like one but can't be opened wasn't read, and that blocks."""
        source.seek(0)
        if zipfile.is_zipfile(source):
            source.seek(0)
            self.zip(source, depth)
        elif _looks_like_a_zip(source):
            raise _Stop(UNREADABLE)

    def zip(self, source: BinaryIO, depth: int) -> None:
        if depth > MAX_DEPTH:
            raise _Stop("archive_too_deep")
        with zipfile.ZipFile(source) as archive:
            entries = archive.infolist()
        if len(entries) > MAX_ENTRIES:
            raise _Stop("archive_too_many_files")
        spans = sorted(self.entry(source, entry, depth) for entry in entries)
        # An entry the directory doesn't list, such as a whole zip in front of a small one, wouldn't be read by the above.
        starts = [start for start, _ in spans]
        for position in _local_headers(source):
            at = bisect.bisect_right(starts, position) - 1
            if at < 0 or position >= spans[at][1]:
                raise _Stop(UNREADABLE)

    def entry(self, source: BinaryIO, entry: zipfile.ZipInfo, depth: int) -> tuple[int, int]:
        if entry.flag_bits & _ENCRYPTED:
            raise _Stop(PASSWORD_PROTECTED)
        if entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            raise _Stop(METHOD_NOT_SUPPORTED)
        data_start = self.check_local_header(source, entry)
        with tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024, dir="/tmp") as copy:
            out = _Entry(self, copy, _is_manifest(entry.filename))
            source.seek(data_start)
            self.read_stream(source, entry, out)
            # What's there has to be what both headers said, or another tool could read something else from it.
            if out.seen != entry.file_size or out.crc != entry.CRC:
                raise _Stop(UNREADABLE)
            if out.manifest is not None and (problem := manifest_problem(bytes(out.manifest))):
                raise _Stop(problem)
            self.contents(copy, depth + 1)
        return entry.header_offset, data_start + entry.compress_size

    def check_local_header(self, source: BinaryIO, entry: zipfile.ZipInfo) -> int:
        source.seek(entry.header_offset)
        head = source.read(_LOCAL_HEADER.size)
        if len(head) != _LOCAL_HEADER.size:
            raise _Stop(UNREADABLE)
        signature, _, flags, method, _, _, crc, compressed, size, name_length, extra_length = _LOCAL_HEADER.unpack(head)
        if signature != _LOCAL_SIGNATURE:
            raise _Stop(UNREADABLE)
        if flags & _ENCRYPTED:
            raise _Stop(PASSWORD_PROTECTED)
        if method != entry.compress_type:
            raise _Stop(UNREADABLE)
        name = source.read(name_length)
        central_name = entry.orig_filename.encode("utf-8" if entry.flag_bits & _UTF8_NAME else "cp437")
        if name != central_name:
            raise _Stop(UNREADABLE)
        if not flags & _DESCRIPTOR:
            claims = (crc == entry.CRC, compressed in (entry.compress_size, _ZIP64_SIZE), size in (entry.file_size, _ZIP64_SIZE))
            if not all(claims):
                raise _Stop(UNREADABLE)
        return entry.header_offset + _LOCAL_HEADER.size + name_length + extra_length

    def read_stream(self, source: BinaryIO, entry: zipfile.ZipInfo, out: _Entry) -> None:
        """Exactly the compressed bytes the directory claims, and a deflate stream has to end exactly at their end."""
        inflate = zlib.decompressobj(-15) if entry.compress_type == zipfile.ZIP_DEFLATED else None
        left = entry.compress_size
        while left > 0:
            chunk = source.read(min(CHUNK, left))
            if not chunk:
                raise _Stop(UNREADABLE)
            left -= len(chunk)
            if inflate is None:
                out.take(chunk)
                continue
            pending = chunk
            while True:
                data = inflate.decompress(pending, CHUNK)
                pending = inflate.unconsumed_tail
                out.take(data)
                # A full read can leave output waiting even with no input left.
                if inflate.eof or (not pending and len(data) < CHUNK):
                    break
            if inflate.eof and (left or pending or inflate.unused_data):
                raise _Stop(UNREADABLE)
        if inflate is not None and not inflate.eof:
            raise _Stop(UNREADABLE)


def archive_problem(source: BinaryIO, clock=time.monotonic) -> str | None:
    """None only if the file isn't a zip, or every entry of every zip in it was read to the end within the limits."""
    try:
        _Walk(clock).contents(source, 0)
        return None
    except _Stop as stop:
        return str(stop)
    except Exception:  # pylint: disable=broad-except
        # Hostile input can raise anything. Whatever stopped the walk, the file wasn't read to the end.
        return UNREADABLE
