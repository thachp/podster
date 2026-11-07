"""Turns what was read into a report, in the words `ScanOutcome::from_report` reads in crates/core/src/files.rs.

There are only two endings: nothing was found, or the file is blocked. Having no answer at all is a different thing, and it
never reaches here.
"""
from __future__ import annotations

import re

NO_KNOWN_MALWARE = "no_known_malware"
MALWARE_FOUND = "malware_found"
UNREADABLE = "unreadable"

_SIGNATURE = re.compile(r"[A-Za-z0-9._:-]{1,120}")
_CANT_READ = (("Heuristics.Encrypted", "password_protected"), ("Heuristics.Limits", "limits_exceeded"), ("Heuristics.Exceeds", "limits_exceeded"))


def from_clamd(reply: str) -> tuple[str, str]:
    """Only clamd's plain OK finds nothing. Everything else blocks, including words this code doesn't know."""
    if reply == "stream: OK":
        return NO_KNOWN_MALWARE, "none"
    if reply.startswith("stream: ") and reply.endswith(" FOUND"):
        name = reply.removeprefix("stream: ").removesuffix(" FOUND")
        for prefix, reason in _CANT_READ:
            if name.startswith(prefix):
                return UNREADABLE, reason
        return MALWARE_FOUND, name if _SIGNATURE.fullmatch(name) else "unnamed"
    return UNREADABLE, "clamd_could_not_read"
