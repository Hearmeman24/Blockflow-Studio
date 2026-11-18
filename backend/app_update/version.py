"""Semantic versions (semver 2.0 precedence) and the app's own version."""

from __future__ import annotations

import functools
import json
import re
from dataclasses import dataclass
from pathlib import Path

_NUM = r"(0|[1-9]\d*)"
_IDENT = r"(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)"
_SEMVER_RE = re.compile(
    rf"{_NUM}\.{_NUM}\.{_NUM}(?:-({_IDENT}(?:\.{_IDENT})*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
)
# Tags the updater accepts: v1.2.3 or v1.2.3-beta.1 (build metadata allowed).
MAX_TAG_LENGTH = 64


@functools.total_ordering
@dataclass(frozen=True)
class Version:
    major: int
    minor: int
    patch: int
    pre: tuple[str, ...] = ()

    @property
    def prerelease(self) -> bool:
        return bool(self.pre)

    def _key(self):
        # A release ranks above its pre-releases; numeric identifiers rank
        # below alphanumeric ones; a longer set wins when the prefix is equal.
        pre = tuple((0, int(p), "") if p.isdigit() else (1, 0, p) for p in self.pre)
        return (self.major, self.minor, self.patch, 0 if self.pre else 1, pre)

    def __lt__(self, other: "Version") -> bool:
        return self._key() < other._key()

    def __eq__(self, other: object) -> bool:
        return isinstance(other, Version) and self._key() == other._key()

    def __hash__(self) -> int:
        return hash(self._key())

    def __str__(self) -> str:
        core = f"{self.major}.{self.minor}.{self.patch}"
        return f"{core}-{'.'.join(self.pre)}" if self.pre else core


def parse(text: str) -> Version | None:
    if not isinstance(text, str):
        return None
    m = _SEMVER_RE.fullmatch(text)
    if not m:
        return None
    pre = tuple(m.group(4).split(".")) if m.group(4) else ()
    return Version(int(m.group(1)), int(m.group(2)), int(m.group(3)), pre)


def parse_tag(tag: str) -> Version | None:
    """``v1.2.3`` / ``1.2.3`` / ``v1.2.3-beta.1`` -> Version; anything else -> None."""
    if not isinstance(tag, str) or not tag or len(tag) > MAX_TAG_LENGTH:
        return None
    return parse(tag[1:] if tag.startswith("v") else tag)


def read_app_version(root: Path) -> str:
    """``version`` from ``root/package.json``; ``0.0.0`` when unreadable."""
    try:
        data = json.loads((Path(root) / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return "0.0.0"
    value = data.get("version") if isinstance(data, dict) else None
    return value if isinstance(value, str) and parse(value) else "0.0.0"
