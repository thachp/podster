"""Runs the real server, with real clamd and real signatures, on a clock 8 days past them. Only the integration run uses it."""
import subprocess

from scanner.server import main
from scanner.signatures import parse_version

built = parse_version(subprocess.run(["clamscan", "--version"], capture_output=True, text=True, check=True).stdout)
main(clock=lambda: built.built_at.timestamp() + 8 * 24 * 60 * 60)
