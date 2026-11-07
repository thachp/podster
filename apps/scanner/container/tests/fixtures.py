"""Test files, built here so nothing hostile sits in the repository. EICAR is the industry's harmless test string."""
from __future__ import annotations

import io
import struct
import zipfile

# Split so this file itself doesn't trip a scanner.
EICAR = b"X5O!P%@AP[4\\PZX54(P^)7CC)7}$" + b"EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
MB = 1024 * 1024


def zipped(entries: list[tuple[str, bytes]], compression: int = zipfile.ZIP_DEFLATED) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression, allowZip64=True) as archive:
        for name, data in entries:
            archive.writestr(name, data)
    return out.getvalue()


def nested(data: bytes, levels: int) -> bytes:
    for level in range(levels):
        data = zipped([(f"layer{level}.zip", data)])
    return data


def zeros_zip(megabytes: int, tail: bytes = b"") -> bytes:
    """Streams, so building it doesn't hold the whole thing in memory."""
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
        with archive.open("zeros.bin", "w", force_zip64=True) as entry:
            for _ in range(megabytes):
                entry.write(b"\0" * MB)
            entry.write(tail)
    return out.getvalue()


def wide_bomb() -> bytes:
    """16 of 16 of 16 of 16 of 10 MB is 655 GB unpacked, from a small file."""
    layer = zipped([("zeros.bin", b"\0" * (10 * MB))])
    for level in range(4):
        layer = zipped([(f"l{level}-{index}.zip", layer) for index in range(16)])
    return layer


def many_files(count: int) -> bytes:
    return zipped([(f"f{index}.txt", b"x") for index in range(count)])


def flagged_encrypted(data: bytes) -> bytes:
    """Sets the zip's encrypted bit in its local and central headers."""
    out = bytearray(data)
    for signature, offset in ((b"PK\x03\x04", 6), (b"PK\x01\x02", 8)):
        at = out.find(signature)
        while at != -1:
            flags = struct.unpack_from("<H", out, at + offset)[0]
            struct.pack_into("<H", out, at + offset, flags | 1)
            at = out.find(signature, at + 4)
    return bytes(out)


def corrupt_lzma() -> bytes:
    """Damaged inside its compressed data, with the directory intact."""
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_LZMA) as archive:
        archive.writestr("data.bin", bytes(range(256)) * 16)
    damaged = bytearray(out.getvalue())
    start = damaged.find(b"data.bin") + len(b"data.bin")
    for index in range(start + 10, start + 60):
        damaged[index] ^= 0xFF
    return bytes(damaged)


def truncated() -> bytes:
    whole = zipped([("data.bin", bytes(range(256)) * 4096)], zipfile.ZIP_STORED)
    return whole[: len(whole) // 2]


MANIFEST_NS = 'xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"'
PLAIN_MANIFEST = f"""<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest {MANIFEST_NS} manifest:version="1.2">
 <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
 <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
</manifest:manifest>"""
ENCRYPTED_MANIFEST = f"""<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest {MANIFEST_NS} manifest:version="1.2">
 <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
 <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml" manifest:size="1024">
  <manifest:encryption-data manifest:checksum-type="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0#sha256-1k" manifest:checksum="AAAA">
   <manifest:algorithm manifest:algorithm-name="http://www.w3.org/2001/04/xmlenc#aes256-cbc" manifest:initialisation-vector="AAAA"/>
   <manifest:key-derivation manifest:key-derivation-name="PBKDF2" manifest:key-size="32" manifest:iteration-count="100000" manifest:salt="AAAA"/>
  </manifest:encryption-data>
 </manifest:file-entry>
</manifest:manifest>"""


def odf(manifest: bytes | str = PLAIN_MANIFEST, manifest_name: str = "META-INF/manifest.xml") -> bytes:
    """The shape of an OpenDocument file: its zip flags stay 0 even when its content is encrypted."""
    data = manifest.encode() if isinstance(manifest, str) else manifest
    return zipped([("mimetype", b"application/vnd.oasis.opendocument.text"), ("content.xml", b"<office:document-content/>"), (manifest_name, data)])
