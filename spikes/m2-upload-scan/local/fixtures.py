#!/usr/bin/env python3
"""Makes the test files in fixtures/. None are committed, and none hold real data. EICAR is the harmless industry test string."""
import io
import os
import shutil
import subprocess
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "fixtures")
os.makedirs(OUT, exist_ok=True)
# Split so this file doesn't itself read as the test file.
EICAR = ("X5O!P%@AP[4\\PZX54(P^)7CC)7}" + "$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*").encode()
MB = 1000 * 1000


def path(name):
    return os.path.join(OUT, name)


def write(name, data):
    with open(path(name), "wb") as handle:
        handle.write(data)


def zipped(entries):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries:
            archive.writestr(name, data)
    return buffer.getvalue()


def nested(data, levels):
    for level in range(levels):
        data = zipped([(f"layer{level}.zip", data)])
    return data


def main():
    with open(path("clean-100mb.bin"), "wb") as handle:
        for _ in range(100):
            handle.write(os.urandom(MB))
    # One byte over, which the gateway refuses.
    with open(path("over-100mb.bin"), "wb") as handle:
        for _ in range(100):
            handle.write(os.urandom(MB))
        handle.write(b"x")
    write("clean-small.txt", b"An ordinary note.\n" * 100)
    write("clean-empty.txt", b"")
    write("eicar.txt", EICAR)
    write("eicar-in-zip.zip", zipped([("note.txt", EICAR)]))
    write("eicar-in-nested-zip.zip", nested(EICAR, 3))

    # One file that expands to 2 GB, far past the 150 MB per-file limit.
    with zipfile.ZipFile(path("bomb-flat-2gb.zip"), "w", zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
        with archive.open("zeros.bin", "w", force_zip64=True) as entry:
            for _ in range(2000):
                entry.write(b"\0" * MB)
    # Deeper than the recursion limit of 10.
    write("bomb-deep-15.zip", nested(b"An ordinary note.\n", 15))
    # More files than the limit of 10,000.
    write("bomb-many-20000.zip", zipped([(f"f{i}.txt", b"x") for i in range(20000)]))
    # 16 of 16 of 16 of 16 of 10 MB is 655 GB unpacked, from a small file, in the style of the well-known 42.zip.
    layer = zipped([("zeros.bin", b"\0" * (10 * MB))])
    for level in range(4):
        layer = zipped([(f"l{level}-{i}.zip", layer) for i in range(16)])
    write("bomb-wide-655gb.zip", layer)

    # What a limit can hide: the test string past 150 MB in one entry, which nothing would see if the limit passed silently.
    with zipfile.ZipFile(path("eicar-past-limit.zip"), "w", zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
        with archive.open("big.bin", "w", force_zip64=True) as entry:
            for _ in range(200):
                entry.write(b"\0" * MB)
            entry.write(EICAR)
    # An ordinary archive the walk has to let through, within every limit, and one with a file of its own inside.
    write("clean-archive.zip", zipped([("a.txt", b"note\n" * 1000), ("inner.zip", zipped([("b.txt", b"note\n" * 1000)]))]))

    # The walk's known gap: a zip that doesn't start with PK, as a self-extracting one doesn't, isn't walked. This shows what happens.
    with open(path("eicar-past-limit.zip"), "rb") as source:
        write("gap-prefixed-eicar-past-limit.bin", b"#!/bin/sh\n" + source.read())

    # Things it can't read. Policy says these are blocked.
    write("plain.txt", b"Inside a locked archive.\n")
    if shutil.which("zip"):
        target = path("encrypted.zip")
        if os.path.exists(target):
            os.remove(target)
        subprocess.run(["zip", "-j", "-q", "-P", "fixture", target, path("plain.txt")], check=True)
    whole = zipped([("data.bin", os.urandom(MB))])
    write("truncated.zip", whole[: len(whole) // 2])
    # Damage only a real decompressor finds, of a kind the walk didn't list by name before.
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_LZMA) as archive:
        archive.writestr("data.bin", os.urandom(4096))
    damaged = bytearray(buffer.getvalue())
    for offset in range(40, 120):
        damaged[offset] ^= 0xFF
    write("corrupt-lzma.zip", bytes(damaged))
    write("not-really.zip", b"PK\x03\x04" + os.urandom(4096))
    for name in sorted(os.listdir(OUT)):
        print(f"{os.path.getsize(path(name)):>12}  {name}")


main()
