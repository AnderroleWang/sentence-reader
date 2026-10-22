#!/bin/sh
set -eu
cd -- "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3.9+ is required. Install Python, then run: sh start.sh" >&2
  exit 1
fi
exec python3 -X utf8 server.py "$@"
