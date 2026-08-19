#!/usr/bin/env python3
"""Static server for the quiz-municipios replica.

Mirrors GitHub Pages Content-Type headers (with charset=utf-8) so the
browser decodes every resource as UTF-8. Without an explicit charset,
browsers on systems with a non-UTF-8 locale fall back to Windows-1252
for <script src> resources and accents/superscripts render as mojibake.
"""
import http.server

CHARSET_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    # Without these the manifest is served as application/octet-stream, which
    # is not what GitHub Pages does and makes the PWA look uninstallable when
    # testing locally.
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".json": "application/json; charset=utf-8",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def guess_type(self, path):
        name = str(path).lower()
        for ext, ctype in CHARSET_TYPES.items():
            if name.endswith(ext):
                return ctype
        return super().guess_type(path)


if __name__ == "__main__":
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
