"""Entry point for the OmniX Go npm-backed MCP service."""

from __future__ import annotations

import os
import subprocess
import sys
import hashlib
import io
import platform
import re
import tarfile
import urllib.request
import zipfile
from pathlib import Path

VERSION = "0.3.4"


def _node_command() -> str:
    import shutil

    existing = shutil.which("node")
    if existing:
        major = int(subprocess.check_output([existing, "-p", "process.versions.node.split('.')[0]"], text=True))
        if major >= 20:
            return existing

    system = platform.system().lower()
    machine = platform.machine().lower()
    os_name = "win" if system == "windows" else "darwin" if system == "darwin" else "linux"
    architecture = "arm64" if machine in {"arm64", "aarch64"} else "x64"
    suffix = f"-{os_name}-{architecture}.zip" if os_name == "win" else f"-{os_name}-{architecture}.tar.gz"
    base = "https://nodejs.org/dist/latest-v24.x"
    checksums = urllib.request.urlopen(f"{base}/SHASUMS256.txt", timeout=30).read().decode()
    match = re.search(rf"^([a-f0-9]{{64}})\s+(node-v\S+{re.escape(suffix)})$", checksums, re.MULTILINE)
    if not match:
        raise SystemExit(f"No official Node.js runtime is available for {system}/{machine}")
    expected, archive_name = match.groups()
    archive = urllib.request.urlopen(f"{base}/{archive_name}", timeout=120).read()
    if hashlib.sha256(archive).hexdigest() != expected:
        raise SystemExit("Node.js runtime checksum verification failed")
    runtime_root = Path.home() / ".local" / "share" / "omnix-go" / "runtime"
    runtime_root.mkdir(parents=True, exist_ok=True)
    if archive_name.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            for member in bundle.infolist():
                destination = (runtime_root / member.filename).resolve()
                if runtime_root.resolve() not in destination.parents and destination != runtime_root.resolve():
                    raise SystemExit("Unsafe path in Node.js runtime archive")
            bundle.extractall(runtime_root)
    else:
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as bundle:
            for member in bundle.getmembers():
                destination = (runtime_root / member.name).resolve()
                if runtime_root.resolve() not in destination.parents and destination != runtime_root.resolve():
                    raise SystemExit("Unsafe path in Node.js runtime archive")
            bundle.extractall(runtime_root)
    extracted = next(path for path in runtime_root.iterdir() if path.is_dir() and path.name.startswith("node-v"))
    return str(extracted / ("node.exe" if os_name == "win" else "bin/node"))


def main() -> None:
    node = _node_command()
    node_directory = Path(node).parent
    npx = node_directory / ("npx.cmd" if platform.system() == "Windows" else "npx")
    package = os.environ.get("OMNIX_GO_NPM_SPEC", f"omnix-go@{VERSION}")
    completed = subprocess.run([str(npx), "--yes", package, *sys.argv[1:]], check=False)
    raise SystemExit(completed.returncode)
