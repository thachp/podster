import datetime as dt
import unittest

from scanner import verdict
from scanner.signatures import MAX_AGE_SECONDS, MAX_AHEAD_SECONDS, Database, is_fresh, parse_version


class Signatures(unittest.TestCase):
    def test_reads_clamd_version(self):
        database = parse_version("ClamAV 1.5.4/28176/Fri Nov  6 07:26:08 2026")
        self.assertEqual(database.as_json(), {"engine": "1.5.4", "version": "28176", "built_at": "2026-11-06T07:26:08Z"})

    def test_a_version_without_a_database_or_date_is_nothing(self):
        for reply in ("", "ClamAV 1.5.4", "ClamAV 1.5.4/28176", "ClamAV 1.5.4/abc/Fri Nov  6 07:26:08 2026", "ClamAV 1.5.4/28176/soon", "Other 1.5.4/28176/Fri Nov  6 07:26:08 2026"):
            self.assertIsNone(parse_version(reply), reply)

    def test_the_limit(self):
        built = dt.datetime(2026, 11, 1, tzinfo=dt.timezone.utc)
        database = Database("1.5.4", "1", built)
        at = built.timestamp()
        self.assertTrue(is_fresh(database, at + MAX_AGE_SECONDS))
        self.assertFalse(is_fresh(database, at + MAX_AGE_SECONDS + 1))
        self.assertTrue(is_fresh(database, at - MAX_AHEAD_SECONDS))
        self.assertFalse(is_fresh(database, at - MAX_AHEAD_SECONDS - 1))
        self.assertFalse(is_fresh(None, at))


class Verdicts(unittest.TestCase):
    def test_only_a_plain_ok_finds_nothing(self):
        self.assertEqual(verdict.from_clamd("stream: OK"), (verdict.NO_KNOWN_MALWARE, "none"))

    def test_words_it_does_not_know_block(self):
        for reply in ("OK", "stream: ok", "stream: OK ", "stream: something ERROR", "INSTREAM size limit exceeded. ERROR", "whatever", "stream: OK\nstream: OK"):
            self.assertEqual(verdict.from_clamd(reply)[0], verdict.UNREADABLE, reply)

    def test_a_detection(self):
        self.assertEqual(verdict.from_clamd("stream: Win.Test.EICAR_HDB-1 FOUND"), (verdict.MALWARE_FOUND, "Win.Test.EICAR_HDB-1"))

    def test_a_name_it_can_not_vouch_for_stays_out(self):
        self.assertEqual(verdict.from_clamd("stream: a b/c FOUND"), (verdict.MALWARE_FOUND, "unnamed"))

    def test_what_clamd_could_not_open_is_unreadable_and_not_malware(self):
        self.assertEqual(verdict.from_clamd("stream: Heuristics.Encrypted.Zip FOUND"), (verdict.UNREADABLE, "password_protected"))
        self.assertEqual(verdict.from_clamd("stream: Heuristics.Encrypted.PDF FOUND"), (verdict.UNREADABLE, "password_protected"))
        self.assertEqual(verdict.from_clamd("stream: Heuristics.Limits.Exceeded.MaxFileSize FOUND"), (verdict.UNREADABLE, "limits_exceeded"))


if __name__ == "__main__":
    unittest.main()
