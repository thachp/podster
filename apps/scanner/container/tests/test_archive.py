import io
import unittest
import zipfile

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


class Zips(unittest.TestCase):
    def test_an_ordinary_archive_passes(self):
        self.assertIsNone(problem(f.zipped([("a.txt", b"note\n" * 1000), ("inner.zip", f.zipped([("b.txt", b"note\n" * 1000)]))])))

    def test_an_ordinary_office_shaped_file_passes(self):
        self.assertIsNone(problem(f.zipped([("[Content_Types].xml", b"<Types/>"), ("word/document.xml", b"<w:document/>")])))

    def test_truncated(self):
        self.assertEqual(problem(f.truncated()), archive.UNREADABLE)

    def test_damaged_inside_its_data(self):
        self.assertEqual(problem(f.corrupt_lzma()), archive.UNREADABLE)

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
        times = iter([0.0, archive.MAX_SECONDS + 1])
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


if __name__ == "__main__":
    unittest.main()
