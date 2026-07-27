"""Entry point for the ChatGPT Code npm-backed MCP service."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys

VERSION = "0.1.0"


def main() -> None:
    npx = shutil.which("npx")
    if not npx:
        raise SystemExit("chatgpt-code requires Node.js 20+ and npx on PATH")
    package = os.environ.get("CHATGPT_CODE_NPM_SPEC", f"chatgpt-code@{VERSION}")
    completed = subprocess.run([npx, "--yes", package, *sys.argv[1:]], check=False)
    raise SystemExit(completed.returncode)
