"""Byte-preserving YAML frontmatter handling.

The guiding rule: a note on disk is ``fm_block + body`` where both halves are
raw bytes.  Body edits reuse ``fm_block`` verbatim, so byte-identity of the
frontmatter is structural rather than something we have to be careful about.

Frontmatter edits go through ``ruamel.yaml`` round-trip mode with the source's
own formatting detected and re-applied.  Before writing, a no-op round-trip is
compared against the original bytes; if the emitter would reformat anything we
refuse the write instead of silently normalising the block.
"""

from __future__ import annotations

import datetime as _dt
import io
import re
from dataclasses import dataclass

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap, CommentedSeq
from ruamel.yaml.error import YAMLError
from ruamel.yaml.representer import RoundTripRepresenter
from ruamel.yaml.scalarstring import ScalarString

# States a note's frontmatter block can be in.
ABSENT = "absent"
PRESENT = "present"
UNTERMINATED = "unterminated"
INVALID = "invalid_yaml"
NOT_MAPPING = "not_mapping"

UTF8_BOM = b"\xef\xbb\xbf"

_FM_OPEN = re.compile(rb"^---[ \t]*\r?\n")
_FM_CLOSE = re.compile(rb"^(?:---|\.\.\.)[ \t]*\r?$")
_SEQ_ITEM = re.compile(r"^(\s*)-(?:\s|$)")
_INDENT = re.compile(r"^(\s*)\S")


@dataclass(frozen=True)
class Split:
    """A note split into its byte order mark, raw frontmatter block and raw body.

    ``open_line + inner + close_line == block`` and ``bom + block + body == raw``.
    """

    raw: bytes
    bom: bytes
    block: bytes
    open_line: bytes
    inner: bytes
    close_line: bytes
    body: bytes
    state: str

    @property
    def has_block(self) -> bool:
        return self.state in (PRESENT, INVALID, NOT_MAPPING)


def split(raw: bytes) -> Split:
    """Split raw note bytes into byte order mark, frontmatter block and body.

    A UTF-8 BOM is peeled off before looking for the opening ``---``, so a
    marked file's frontmatter is still found; the BOM is kept separately so
    writers can put back exactly what the file had.

    Never raises.  A leading ``---`` with no closing delimiter is reported as
    ``UNTERMINATED`` and the whole file is treated as body, which is what
    Obsidian itself does.
    """
    bom = UTF8_BOM if raw.startswith(UTF8_BOM) else b""
    rest = raw[len(bom) :]

    m = _FM_OPEN.match(rest)
    if not m:
        return Split(raw, bom, b"", b"", b"", b"", rest, ABSENT)

    open_line = rest[: m.end()]
    pos = m.end()
    while pos <= len(rest):
        nl = rest.find(b"\n", pos)
        line = rest[pos:nl] if nl != -1 else rest[pos:]
        if _FM_CLOSE.match(line):
            end = len(rest) if nl == -1 else nl + 1
            return Split(
                raw=raw,
                bom=bom,
                block=rest[:end],
                open_line=open_line,
                inner=rest[m.end() : pos],
                close_line=rest[pos:end],
                body=rest[end:],
                state=PRESENT,
            )
        if nl == -1:
            break
        pos = nl + 1

    return Split(raw, bom, b"", b"", b"", b"", rest, UNTERMINATED)


def _detect_sequence_indent(text: str) -> tuple[int, int] | None:
    """Recover ruamel's (sequence, offset) settings from existing block seqs."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        m = _SEQ_ITEM.match(line)
        if not m:
            continue
        dash = len(m.group(1))
        parent = dash
        for j in range(i - 1, -1, -1):
            prev = lines[j]
            if not prev.strip() or prev.lstrip().startswith("#"):
                continue
            if prev.rstrip().endswith(":"):
                pm = _INDENT.match(prev)
                parent = len(pm.group(1)) if pm else 0
            break
        offset = max(dash - parent, 0)
        return offset + 2, offset
    return None


def _detect_null_style(text: str) -> str:
    """Recover how this document spells null so untouched keys keep their form."""
    for pattern, style in (
        (r":[ \t]+null(?:\s|$)", "null"),
        (r":[ \t]+~(?:\s|$)", "~"),
        (r":[ \t]+Null(?:\s|$)", "Null"),
        (r":[ \t]+NULL(?:\s|$)", "NULL"),
        (r":[ \t]*$", ""),
    ):
        if re.search(pattern, text, re.MULTILINE):
            return style
    return "null"


def _yaml_for(text: str) -> YAML:
    yaml = YAML()
    yaml.preserve_quotes = True
    yaml.width = 1 << 20  # never re-wrap long scalars
    seq = _detect_sequence_indent(text)
    if seq is not None:
        yaml.indent(mapping=2, sequence=seq[0], offset=seq[1])
    null_style = _detect_null_style(text)

    class _Representer(RoundTripRepresenter):
        pass

    _Representer.add_representer(
        type(None),
        lambda self, data: self.represent_scalar("tag:yaml.org,2002:null", null_style),
    )
    yaml.Representer = _Representer
    return yaml


def _dump(yaml: YAML, data) -> str:
    buf = io.StringIO()
    yaml.dump(data, buf)
    return buf.getvalue()


def parse(sp: Split) -> tuple[dict | None, str, str | None]:
    """Parse a split note's frontmatter.

    Returns ``(plain_mapping_or_None, state, error_message_or_None)``.  Never
    raises: malformed YAML is reported, not repaired.
    """
    if sp.state == ABSENT:
        return None, ABSENT, None
    if sp.state == UNTERMINATED:
        return None, UNTERMINATED, "frontmatter opened with '---' but never closed"

    text = sp.inner.decode("utf-8", errors="replace")
    if not text.strip():
        return {}, PRESENT, None
    try:
        data = _yaml_for(text).load(text)
    except YAMLError as exc:
        return None, INVALID, f"invalid YAML in frontmatter: {_one_line(exc)}"
    except Exception as exc:  # ruamel can raise non-YAMLError on odd input
        return None, INVALID, f"could not parse frontmatter: {_one_line(exc)}"

    if data is None:
        return {}, PRESENT, None
    if not isinstance(data, dict):
        return None, NOT_MAPPING, f"frontmatter is a {type(data).__name__}, not a mapping"
    return to_plain(data), PRESENT, None


def _one_line(exc: Exception) -> str:
    return " ".join(str(exc).split())[:300]


def to_plain(value):
    """Convert ruamel/YAML objects into JSON-serialisable Python values."""
    if isinstance(value, (CommentedMap, dict)):
        return {str(k): to_plain(v) for k, v in value.items()}
    if isinstance(value, (CommentedSeq, list, tuple)):
        return [to_plain(v) for v in value]
    if isinstance(value, ScalarString):
        return str(value)
    if isinstance(value, (_dt.datetime, _dt.date, _dt.time)):
        return value.isoformat()
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return int(value)
    if isinstance(value, float):
        return float(value)
    return value


class RoundTripUnstable(Exception):
    """Raised when ruamel would reformat parts of the block we did not touch."""

    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


def edit_block(sp: Split, updates: dict, delete_keys: list[str]) -> bytes:
    """Return a new frontmatter block with ``updates`` applied.

    Raises ``RoundTripUnstable`` if a no-op round-trip of the existing block is
    not byte-identical, i.e. if writing would reformat untouched keys.
    """
    text = sp.inner.decode("utf-8")
    yaml = _yaml_for(text)

    if text.strip():
        data = yaml.load(text)
        if data is None:
            data = CommentedMap()
        if not isinstance(data, dict):
            raise RoundTripUnstable("frontmatter is not a mapping")
        baseline = _dump(yaml, data)
        if baseline != text:
            raise RoundTripUnstable(
                "the YAML emitter would reformat this frontmatter block; "
                "refusing to rewrite it. First difference: "
                + _first_difference(text, baseline)
            )
    else:
        data = CommentedMap()

    for key in delete_keys:
        if key not in data:
            raise KeyError(key)
        del data[key]
    for key, value in updates.items():
        data[key] = value

    if not data:
        return sp.open_line + b"" + sp.close_line
    return sp.open_line + _dump(yaml, data).encode("utf-8") + sp.close_line


def new_block(values: dict) -> bytes:
    """Serialise a fresh frontmatter block for a note being created."""
    if not values:
        return b""
    yaml = YAML()
    yaml.preserve_quotes = True
    yaml.width = 1 << 20
    yaml.indent(mapping=2, sequence=4, offset=2)
    data = CommentedMap()
    for key, value in values.items():
        data[key] = value
    return b"---\n" + _dump(yaml, data).encode("utf-8") + b"---\n"


def _first_difference(original: str, produced: str) -> str:
    a = original.splitlines()
    b = produced.splitlines()
    for i in range(max(len(a), len(b))):
        left = a[i] if i < len(a) else "<end of block>"
        right = b[i] if i < len(b) else "<end of block>"
        if left != right:
            return f"line {i + 1}: on disk {left!r}, emitter would write {right!r}"
    return "trailing whitespace differs"
