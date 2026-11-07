"""Run while building the image, so one without current signatures never gets built."""
from __future__ import annotations

import re
import subprocess
import sys
import time

from .signatures import is_fresh, parse_version

# A rebuild should carry signatures from about today, well inside the 7 days a scan allows.
MAX_BUILD_AGE_SECONDS = 3 * 24 * 60 * 60


def main() -> int:
    engine = subprocess.run(["clamscan", "--version"], capture_output=True, text=True, check=False).stdout.strip()
    database = parse_version(engine)
    if database is None or not is_fresh(database, time.time()) or time.time() - database.built_at.timestamp() > MAX_BUILD_AGE_SECONDS:
        print(f"signatures aren't current: {re.sub(r'[^ -~]', '?', engine)[:120]}", file=sys.stderr)
        return 1
    print(f"signatures: {database.version}, built {database.as_json()['built_at']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
