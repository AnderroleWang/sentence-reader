"""Build a clean, auditable distribution using only the Python standard library."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = (
    "README.md", "开始使用.md", "CHANGELOG.md", "THIRD_PARTY_NOTICES.md", "UPSTREAM.md", "LICENSE", "CONTRIBUTING.md",
    "server.py", "start.cmd", "start.sh", "index.html", "styles.css", ".gitignore", ".gitattributes",
    "alignment.mjs", "app.mjs", "focus.mjs", "paired-import.mjs", "pdf-document.mjs",
    "pdf-reader.mjs", "pdf-rendering.mjs", "reading-data.mjs", "reading-tools.mjs", "translated-pdf.mjs",
)
SECRET_RULES = {
    "private-key": rb"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----",
    "github-token": rb"(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})",
    "service-token": rb"\bsk-(?:proj-|ant-|or-v1-)?[A-Za-z0-9_-]{20,}",
    "aws-access-key": rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b",
    "credential-url": rb"https?://[^\s/:\"']+:[^\s/@\"']+@",
    "developer-windows-path": rb"[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9_.-]+",
    "developer-unix-path": rb"/(?:Users|home)/[A-Za-z0-9_.-]+/",
}


def audit_bytes(name, data):
    failures = [rule for rule, pattern in SECRET_RULES.items() if re.search(pattern, data)]
    username = os.environ.get("USERNAME", "")
    if len(username) >= 5 and re.search(rb"(?<![A-Za-z0-9_])" + re.escape(username.encode()) + rb"(?![A-Za-z0-9_])", data, re.I):
        failures.append("developer-username")
    if failures:
        # Never print matched secret values.
        raise ValueError("Publish audit failed: %s [%s]" % (name, ", ".join(failures)))


def audit_json(name, value):
    if isinstance(value, dict):
        for key, child in value.items():
            if key.lower().replace("_", "") in {"apikey", "password", "accesstoken", "refreshtoken"} and child:
                raise ValueError("Publish audit failed: %s [credential-field]" % name)
            if key in {"pdfBase64", "translatedPdfBase64"} and isinstance(child, str):
                decoded = base64.b64decode(child, validate=True)
                if not decoded.startswith(b"%PDF-"):
                    raise ValueError("Invalid demo PDF: " + name)
                audit_bytes(name + " embedded PDF", decoded)
            else:
                audit_json(name, child)
    elif isinstance(value, list):
        for item in value:
            audit_json(name, item)


def source_payload(root=ROOT):
    paths = [root / name for name in ROOT_FILES]
    for folder in ("docs", "scripts", "tests"):
        paths += sorted(p for p in (root / folder).rglob("*")
                        if p.is_file() and p.suffix in {".md", ".py", ".mjs"} and "__pycache__" not in p.parts)
    paths += [root / "examples" / name for name in (
        "layout-demo.句读.json", "layout-preview.png", "reading-tools-preview.png")]
    paths += [root / "vendor" / name for name in (
        "pdf.mjs", "pdf.worker.mjs", "pdf_viewer.css", "PDFJS-LICENSE")]
    paths += sorted(p for p in (root / "vendor/standard_fonts").iterdir()
                    if p.is_file() and (p.suffix in {".pfb", ".ttf"} or p.name.startswith("LICENSE_")))
    payload = {}
    for path in paths:
        if not path.is_file() or path.is_symlink():
            raise ValueError("Missing or linked distribution file: " + str(path.relative_to(root)))
        name = path.relative_to(root).as_posix()
        data = path.read_bytes()
        audit_bytes(name, data)
        if path.suffix == ".json":
            audit_json(name, json.loads(data))
        if name == "start.cmd":
            data = data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
        payload[name] = data
    return payload


def add_runtime(payload, archive):
    runtime_hash = hashlib.sha256(archive.read_bytes()).hexdigest()
    with zipfile.ZipFile(archive) as package:
        names = {item.filename for item in package.infolist() if not item.is_dir()}
        if not {"python.exe", "python312.dll", "python312.zip", "LICENSE.txt"} <= names:
            raise ValueError("Expected the official Python 3.12 Windows embeddable package")
        for info in package.infolist():
            if info.is_dir():
                continue
            name = info.filename
            if len(PurePosixPath(name).parts) != 1 or "\\" in name or ":" in name or name.startswith("."):
                raise ValueError("Unsafe runtime archive entry")
            payload["runtime/" + name] = package.read(info)
    payload["runtime/ORIGIN.json"] = json.dumps({
        "component": "CPython 3.12.10 Windows x64 embeddable distribution",
        "source": "https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip",
        "archive_sha256": runtime_hash,
        "license": "LICENSE.txt",
    }, indent=2).encode() + b"\n"


def build(output, runtime_zip=None):
    payload = source_payload()
    version = re.search(r'^VERSION = "([0-9.]+)"', payload["server.py"].decode(), re.M).group(1)
    platform = "source"
    if runtime_zip:
        add_runtime(payload, runtime_zip)
        platform = "windows-x64"
    manifest = {
        "app": "sentence-reader", "version": version, "package": platform,
        "privacy": "Application, documentation and self-authored demo only; no user browser data or API settings.",
        "files": [{"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                  for name, data in sorted(payload.items())],
    }
    payload["DISTRIBUTION-MANIFEST.json"] = json.dumps(manifest, ensure_ascii=False, indent=2).encode() + b"\n"
    output.mkdir(parents=True, exist_ok=True)
    destination = output / ("sentence-reader-v%s-%s.zip" % (version, platform))
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as package:
        for name, data in sorted(payload.items()):
            info = zipfile.ZipInfo("sentence-reader/" + name, date_time=(2026, 10, 21, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            mode = 0o755 if name == "start.sh" else 0o644
            info.external_attr = (stat.S_IFREG | mode) << 16
            package.writestr(info, data)
    with zipfile.ZipFile(destination) as package:
        if package.testzip() is not None:
            raise ValueError("Distribution ZIP integrity check failed")
        if set(package.namelist()) != {"sentence-reader/" + name for name in payload}:
            raise ValueError("Distribution ZIP manifest mismatch")
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    destination.with_suffix(".zip.sha256").write_text(digest + "  " + destination.name + "\n", encoding="ascii")
    destination.with_suffix(".manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"package": destination.name, "bytes": destination.stat().st_size,
                      "files": len(payload), "sha256": digest, "privacy_scan": "passed"}))
    return destination


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    parser.add_argument("--runtime-zip", type=Path)
    args = parser.parse_args()
    build(args.output, args.runtime_zip)
