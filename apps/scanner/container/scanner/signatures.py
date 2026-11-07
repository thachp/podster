"""How old clamd's signatures are, and whether a verdict may be given with them (decision 84)."""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

MAX_AGE_SECONDS = 7 * 24 * 60 * 60
# A database dated well ahead of the clock means one of them is wrong, so its age means nothing.
MAX_AHEAD_SECONDS = 24 * 60 * 60


@dataclass(frozen=True)
class Database:
    engine: str
    version: str
    built_at: dt.datetime

    def as_json(self) -> dict[str, str]:
        return {"engine": self.engine, "version": self.version, "built_at": self.built_at.strftime("%Y-%m-%dT%H:%M:%SZ")}


def parse_version(reply: str) -> Database | None:
    """Reads clamd's `ClamAV 1.5.4/28176/Fri Nov  6 07:26:08 2026`. Without a database or a date, there's nothing to trust."""
    parts = reply.strip().split("/", 2)
    if len(parts) != 3 or not parts[0].startswith("ClamAV ") or not parts[1].isdigit():
        return None
    try:
        built_at = dt.datetime.strptime(" ".join(parts[2].split()), "%a %b %d %H:%M:%S %Y").replace(tzinfo=dt.timezone.utc)
    except ValueError:
        return None
    return Database(parts[0].removeprefix("ClamAV ").strip(), parts[1], built_at)


def is_fresh(database: Database | None, now: float) -> bool:
    if database is None:
        return False
    age = now - database.built_at.timestamp()
    return -MAX_AHEAD_SECONDS <= age <= MAX_AGE_SECONDS
