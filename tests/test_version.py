"""The version is written in two places, so it is asserted to be one version.

`pyproject.toml` is what the registry and pip install; `web/build.js` is what the node
shows on screen and what a bug report quotes. A release that bumps one and forgets the
other reports a version nobody can install.
"""

import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_web_version_matches_pyproject():
    packaged = tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]["version"]
    shown = re.search(r'VERSION = "([^"]+)"', (ROOT / "web" / "build.js").read_text())
    assert shown and shown.group(1) == packaged
