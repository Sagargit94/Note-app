#!/bin/sh
cd "$(dirname "$0")"
(sleep 1; (open http://localhost:8080 || xdg-open http://localhost:8080) >/dev/null 2>&1) &
if command -v node >/dev/null; then node serve.mjs 8080; else python3 -m http.server 8080 --bind 127.0.0.1; fi
