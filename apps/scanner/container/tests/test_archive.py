import io
import itertools
import struct
import unittest
import zipfile
import zlib
from unittest import mock

import fixtures as f
from scanner import archive
from scanner.archive import archive_problem, manifest_problem


def problem(data: bytes) -> str | None:
    return archive_problem(io.BytesIO(data))


class NotAZip(unittest.TestCase):
    def test_other_files_are_clamd_s_to_judge(self):
        for data in (b"", b"An ordinary note.\n", bytes(range(256)) * 100):
            self.assertIsNone(problem(data))

    def test_a_file_starting_like_a_zip_that_is_not_one_was_not_read(self):
        self.assertEqual(problem(b"PK\x03\x04" + bytes(4096)), archive.UNREADABLE)
        for start in (b"PK\x03\x04\xff\xff", b"PK\x05\x06 not a directory", b"PK\x01\x02\xff"):
            self.assertEqual(problem(start), archive.UNREADABLE, start)


class Zips(unittest.TestCase):
    def test_an_ordinary_archive_passes(self):
        self.assertIsNone(problem(f.zipped([("a.txt", b"note\n" * 1000), ("inner.zip", f.zipped([("b.txt", b"note\n" * 1000)]))])))

    def test_an_ordinary_office_shaped_file_passes(self):
        self.assertIsNone(problem(f.zipped([("[Content_Types].xml", b"<Types/>"), ("word/document.xml", b"<w:document/>")])))

    def test_truncated(self):
        self.assertEqual(problem(f.truncated()), archive.UNREADABLE)

    def test_damaged_inside_its_data(self):
        data = bytearray(f.zipped([("data.bin", bytes(range(256)) * 16)]))
        start = data.find(b"data.bin") + len(b"data.bin")
        for index in range(start + 4, start + 40):
            data[index] ^= 0xFF
        self.assertEqual(problem(bytes(data)), archive.UNREADABLE)

    def test_a_flipped_byte_fails_its_checksum(self):
        data = bytearray(f.zipped([("a.bin", bytes(range(256)) * 16)], zipfile.ZIP_STORED))
        data[100] ^= 0xFF
        self.assertEqual(problem(bytes(data)), archive.UNREADABLE)

    def test_password_protected(self):
        self.assertEqual(problem(f.flagged_encrypted(f.zipped([("a.txt", b"hidden")]))), archive.PASSWORD_PROTECTED)

    def test_password_protected_inside_another(self):
        self.assertEqual(problem(f.zipped([("inner.zip", f.flagged_encrypted(f.zipped([("a.txt", b"hidden")])))])), archive.PASSWORD_PROTECTED)

    def test_a_zip_with_a_line_in_front_of_it_is_still_read(self):
        self.assertEqual(problem(b"#!/bin/sh\n" + f.flagged_encrypted(f.zipped([("a.txt", b"hidden")]))), archive.PASSWORD_PROTECTED)

    def test_a_zip_inside_with_a_line_in_front_of_it_is_still_read(self):
        inner = b"#!/bin/sh\n" + f.flagged_encrypted(f.zipped([("a.txt", b"hidden")]))
        self.assertEqual(problem(f.zipped([("inner.bin", inner)])), archive.PASSWORD_PROTECTED)

    def test_anything_raised_by_hostile_input_blocks(self):
        class Bad(io.BytesIO):
            def read(self, *args):
                raise MemoryError()

        self.assertEqual(archive_problem(Bad(b"PK")), archive.UNREADABLE)


class Limits(unittest.TestCase):
    def test_entry_past_the_limit(self):
        self.assertEqual(problem(f.zeros_zip(150, f.EICAR)), "archive_entry_too_large")

    def test_too_deep(self):
        self.assertEqual(problem(f.nested(b"note\n", archive.MAX_DEPTH + 2)), "archive_too_deep")
        self.assertIsNone(problem(f.nested(b"note\n", archive.MAX_DEPTH)))

    def test_too_many_files(self):
        self.assertEqual(problem(f.many_files(archive.MAX_ENTRIES + 1)), "archive_too_many_files")
        self.assertIsNone(problem(f.many_files(1000)))

    def test_too_much_unpacked_across_entries(self):
        layer = f.zipped([("zeros.bin", b"\0" * (100 * f.MB))])
        self.assertEqual(problem(f.zipped([(f"{index}.zip", layer) for index in range(5)])), "archive_too_large_unpacked")

    def test_a_wide_bomb_stops_early(self):
        self.assertEqual(problem(f.wide_bomb()), "archive_too_large_unpacked")

    def test_out_of_time(self):
        times = itertools.chain([0.0], itertools.repeat(archive.MAX_SECONDS + 1))
        self.assertEqual(archive_problem(io.BytesIO(f.zipped([("a.txt", b"note")])), clock=lambda: next(times)), "archive_took_too_long")


class OpenDocument(unittest.TestCase):
    def test_an_ordinary_one_is_not_refused(self):
        self.assertIsNone(problem(f.odf()))

    def test_one_with_an_old_doctype_is_not_refused(self):
        manifest = f.PLAIN_MANIFEST.replace("<manifest:manifest", '<!DOCTYPE manifest:manifest PUBLIC "-//OpenOffice.org//DTD Manifest 1.0//EN" "Manifest.dtd">\n<manifest:manifest', 1)
        self.assertIsNone(problem(f.odf(manifest)))

    def test_password_protected_is_refused_though_its_zip_flags_are_zero(self):
        data = f.odf(f.ENCRYPTED_MANIFEST)
        with zipfile.ZipFile(io.BytesIO(data)) as check:
            self.assertTrue(all(entry.flag_bits & 1 == 0 for entry in check.infolist()))
        self.assertEqual(problem(data), archive.PASSWORD_PROTECTED)

    def test_inside_another_zip(self):
        self.assertEqual(problem(f.zipped([("report.odt", f.odf(f.ENCRYPTED_MANIFEST))])), archive.PASSWORD_PROTECTED)

    def test_another_prefix_or_a_self_closed_element(self):
        self.assertEqual(problem(f.odf(f.ENCRYPTED_MANIFEST.replace("manifest:", "m:").replace("xmlns:manifest", "xmlns:m"))), archive.PASSWORD_PROTECTED)
        self.assertEqual(manifest_problem(b"<encryption-data/>"), archive.PASSWORD_PROTECTED)

    def test_a_name_spelled_differently(self):
        for name in ("meta-inf/MANIFEST.XML", "/META-INF/manifest.xml", "META-INF\\manifest.xml"):
            self.assertEqual(problem(f.odf(f.ENCRYPTED_MANIFEST, name)), archive.PASSWORD_PROTECTED, name)

    def test_a_second_manifest_entry_of_the_same_name(self):
        with self.assertWarns(UserWarning):
            data = f.zipped([("META-INF/manifest.xml", f.PLAIN_MANIFEST.encode()), ("META-INF/manifest.xml", f.ENCRYPTED_MANIFEST.encode())])
        self.assertEqual(problem(data), archive.PASSWORD_PROTECTED)

    def test_ways_to_hide_the_words(self):
        self.assertEqual(manifest_problem(f.ENCRYPTED_MANIFEST.encode("utf-16")), archive.PASSWORD_PROTECTED)
        self.assertEqual(manifest_problem(f.ENCRYPTED_MANIFEST.encode("utf-16-le")), archive.UNREADABLE)
        self.assertEqual(manifest_problem(b'<!DOCTYPE m [<!ENTITY e "x">]><m>&e;</m>'), archive.UNREADABLE)
        self.assertEqual(manifest_problem(b"\xff\xfe\x00"), archive.UNREADABLE)

    def test_a_manifest_too_large_to_be_real(self):
        self.assertEqual(problem(f.odf(b" " * (archive.MAX_MANIFEST_BYTES + 1))), archive.UNREADABLE)

    def test_words_that_only_look_like_the_element_pass(self):
        self.assertIsNone(manifest_problem(b'<x note="encryption-data"/><no-encryption-data/>'))


class LyingHeaders(unittest.TestCase):
    """What a header says is only a claim. Other tools read the real stream."""

    def test_a_small_declared_size_over_a_large_stream(self):
        big = b"\0" * (160 * f.MB) + f.EICAR
        self.assertEqual(problem(f.lying_size(big)), "archive_entry_too_large")

    def test_a_small_declared_size_within_the_limits(self):
        self.assertEqual(problem(f.lying_size(b"note\n" * 20_000)), archive.UNREADABLE)

    def test_a_declared_size_larger_than_the_stream(self):
        data = f.zipped([("a.bin", b"note\n" * 1000)])
        self.assertEqual(problem(f._patch_entry(data, zlib.crc32(b"note\n" * 1000), None, 6000)), archive.UNREADABLE)

    def test_a_declared_compressed_size_that_stops_early_or_runs_over(self):
        data = f.zipped([("a.bin", bytes(range(256)) * 64)])
        real = zipfile.ZipFile(io.BytesIO(data)).infolist()[0]
        for wrong in (real.compress_size - 5, real.compress_size + 5):
            self.assertEqual(problem(f._patch_entry(data, real.CRC, wrong, real.file_size)), archive.UNREADABLE, wrong)

    def test_a_wrong_checksum(self):
        data = f.zipped([("a.bin", b"note\n" * 1000)])
        self.assertEqual(problem(f._patch_entry(data, 1, None, 5000)), archive.UNREADABLE)

    def test_a_deflate_stream_that_never_ends_though_its_output_is_all_there(self):
        content = b"note\n" * 1000
        squeeze = zlib.compressobj(wbits=-15)
        raw = squeeze.compress(content) + squeeze.flush(zlib.Z_SYNC_FLUSH)
        data = bytearray(f._patch_entry(f.zipped([("a.bin", raw)], zipfile.ZIP_STORED), zlib.crc32(content), None, len(content)))
        struct.pack_into("<H", data, data.find(b"PK\x03\x04") + 8, zipfile.ZIP_DEFLATED)
        struct.pack_into("<H", data, data.find(b"PK\x01\x02") + 10, zipfile.ZIP_DEFLATED)
        self.assertEqual(problem(bytes(data)), archive.UNREADABLE)

    def test_a_local_header_claiming_something_else_than_the_directory(self):
        for offset, label in ((14, "checksum"), (18, "compressed size"), (22, "size")):
            data = bytearray(f.zipped([("a.bin", b"note\n" * 1000)]))
            at = data.find(b"PK\x03\x04") + offset
            struct.pack_into("<L", data, at, struct.unpack_from("<L", data, at)[0] + 1)
            self.assertEqual(problem(bytes(data)), archive.UNREADABLE, label)

    def test_inflating_is_bounded_on_every_read(self):
        real = zlib.decompressobj
        largest = [0]

        class Watched:
            def __init__(self, *args):
                self.inner = real(*args)

            def decompress(self, *args):
                data = self.inner.decompress(*args)
                largest[0] = max(largest[0], len(data))
                return data

            def __getattr__(self, name):
                return getattr(self.inner, name)

        with mock.patch.object(archive.zlib, "decompressobj", Watched):
            self.assertIsNone(problem(f.zipped([("zeros.bin", b"\0" * (20 * f.MB))])))
        self.assertEqual(largest[0], archive.CHUNK)

    def test_a_local_header_that_disagrees_with_the_directory(self):
        data = bytearray(f.zipped([("a.bin", b"note\n" * 1000)]))
        at = data.find(b"PK\x03\x04")
        data[at + 30] ^= 0x01  # The local name.
        self.assertEqual(problem(bytes(data)), archive.UNREADABLE)


class Methods(unittest.TestCase):
    """bzip2 and LZMA ignore a read's size, so a tiny entry could fill memory before any limit runs."""

    def test_bzip2_and_lzma_are_refused_before_anything_is_decompressed(self):
        for method in (zipfile.ZIP_BZIP2, zipfile.ZIP_LZMA):
            self.assertEqual(problem(f.zipped([("zeros.bin", b"\0" * (20 * f.MB))], method)), "archive_method_not_supported", method)

    def test_inside_another_zip(self):
        self.assertEqual(problem(f.zipped([("inner.zip", f.zipped([("a.bin", b"note")], zipfile.ZIP_BZIP2))])), "archive_method_not_supported")

    def test_a_local_method_that_differs_from_the_directory(self):
        data = bytearray(f.zipped([("a.bin", b"note\n" * 1000)]))
        at = data.find(b"PK\x03\x04")
        struct.pack_into("<H", data, at + 8, zipfile.ZIP_BZIP2)
        self.assertEqual(problem(bytes(data)), archive.UNREADABLE)

    def test_what_real_zips_use_still_passes(self):
        self.assertIsNone(problem(f.zipped([("a.txt", b"note\n" * 1000)], zipfile.ZIP_STORED)))
        self.assertIsNone(problem(f.zipped([("a.txt", b"note\n" * 1000)], zipfile.ZIP_DEFLATED)))
        self.assertIsNone(problem(f.with_descriptors([("a.txt", b"note\n" * 1000), ("b.txt", b"")])))
        self.assertIsNone(problem(f.zeros_zip(1)))
        self.assertIsNone(problem(f.zipped([("inner.zip", f.zipped([("b.txt", b"note")]))], zipfile.ZIP_STORED)))
        self.assertIsNone(problem(b"#!/bin/sh\n" + f.zipped([("a.txt", b"note")])))


class ZipsThatDoNotSayTheyAreZips(unittest.TestCase):
    locked = f.flagged_encrypted(f.zipped([("a.txt", b"hidden")]))

    def test_a_damaged_zip_inside_another(self):
        self.assertEqual(problem(f.zipped([("inner.zip", f.without_directory(self.locked))])), archive.UNREADABLE)

    def test_a_damaged_zip_inside_another_with_something_in_front(self):
        self.assertEqual(problem(f.zipped([("inner.bin", b"#!/bin/sh\n" + f.without_directory(self.locked))])), archive.UNREADABLE)

    def test_a_directory_out_of_reach_behind_a_long_trailer(self):
        self.assertEqual(problem(b"#!/bin/sh\n" + f.wide_bomb() + bytes(70_000)), archive.UNREADABLE)

    def test_a_zip_hidden_in_front_of_a_small_one(self):
        self.assertEqual(problem(f.zeros_zip(160, f.EICAR) + f.zipped([("a.txt", b"note")])), archive.UNREADABLE)

    def test_ordinary_files_that_mention_pk_pass(self):
        self.assertIsNone(problem(b"PK is on page 3.\n" * 100))
        self.assertIsNone(problem(b"PK"))
        self.assertIsNone(problem(b"some text PK\x03\x04 and more text that isn't a zip header\n"))
        self.assertIsNone(problem(f.zipped([("note.txt", b"PK is on page 3.\n")])))

    def test_a_marker_split_across_two_reads_is_still_found(self):
        data = bytes(archive.SCAN_CHUNK - 2) + f.without_directory(self.locked)
        self.assertEqual(problem(data), archive.UNREADABLE)


class LocalFlags(unittest.TestCase):
    def test_only_the_local_header_says_encrypted(self):
        self.assertEqual(problem(f.local_flag_only(f.zipped([("a.txt", b"hidden")]))), archive.PASSWORD_PROTECTED)

    def test_inside_another_zip(self):
        self.assertEqual(problem(f.zipped([("inner.zip", f.local_flag_only(f.zipped([("a.txt", b"hidden")])))])), archive.PASSWORD_PROTECTED)


class ManifestEncodings(unittest.TestCase):
    def test_encodings_the_search_can_not_read_block(self):
        text = f.ENCRYPTED_MANIFEST
        for label, data in (
            ("UTF-32 with a BOM", text.encode("utf-32")),
            ("UTF-32 big-endian with a BOM", b"\x00\x00\xfe\xff" + text.encode("utf-32-be")),
            ("UTF-7, declared", text.replace('encoding="UTF-8"', 'encoding="UTF-7"').encode("utf-7")),
            ("UTF-7, with its markup hidden", text.encode("utf-7")),
            ("EBCDIC", text.replace('encoding="UTF-8"', 'encoding="IBM500"').encode("cp500")),
            ("Latin-1, declared", text.replace('encoding="UTF-8"', 'encoding="ISO-8859-1"').encode()),
        ):
            self.assertIn(manifest_problem(data), (archive.UNREADABLE, archive.PASSWORD_PROTECTED), label)
            if label != "UTF-7, with its markup hidden":
                self.assertEqual(manifest_problem(data), archive.UNREADABLE, label)
            self.assertEqual(problem(f.odf(data)), manifest_problem(data), label)

    def test_a_plain_manifest_in_a_strange_encoding_also_blocks(self):
        self.assertEqual(manifest_problem(f.PLAIN_MANIFEST.encode("cp500")), archive.UNREADABLE)
        self.assertEqual(manifest_problem(f.PLAIN_MANIFEST.encode("utf-32")), archive.UNREADABLE)

    def test_the_encodings_real_manifests_use_pass(self):
        self.assertIsNone(manifest_problem(f.PLAIN_MANIFEST.encode()))
        self.assertIsNone(manifest_problem(b"\xef\xbb\xbf" + f.PLAIN_MANIFEST.encode()))
        self.assertIsNone(manifest_problem(f.PLAIN_MANIFEST.encode("utf-16")))
        self.assertIsNone(manifest_problem(f.PLAIN_MANIFEST.replace("UTF-8", "utf-8").encode()))
        self.assertIsNone(manifest_problem(b"\n  " + b"<manifest/>"))

    def test_more_spellings_of_its_path(self):
        for name in ("./META-INF/manifest.xml", "META-INF//manifest.xml", "META-INF/./manifest.xml", "x/../META-INF/manifest.xml", ".\\META-INF\\manifest.xml"):
            self.assertEqual(problem(f.odf(f.ENCRYPTED_MANIFEST, name)), archive.PASSWORD_PROTECTED, name)


if __name__ == "__main__":
    unittest.main()
