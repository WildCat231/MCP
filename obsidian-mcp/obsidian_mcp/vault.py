"""Filesystem-level Obsidian vault access.

Pure logic, no MCP.  The Markdown files are the source of truth; the BM25 index
in this module is a disposable in-memory cache that is refreshed from file
stat() results before every query.

Design rules enforced here:

* Writes are atomic (temp file in the same directory, fsync, ``os.replace``).
* Every read reports a ``version`` hash; every mutation of an existing note
  requires the caller's ``expected_version`` and raises on mismatch.
* Body edits reuse the frontmatter block's bytes verbatim.
* Resolved paths that escape the vault root raise.
"""

from __future__ import annotations

import hashlib
import math
import os
import re
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator

from . import frontmatter as fm

EXCLUDED_DIRS = frozenset({".obsidian", ".trash", ".git", "node_modules"})
TRASH_DIRNAME = ".trash"

BM25_K1 = 1.5
BM25_B = 0.75

_TOKEN_RE = re.compile(r"\w+", re.UNICODE)
_WIKILINK_RE = re.compile(r"(!?)\[\[([^\[\]\n]*)\]\]")
_FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$")
_INLINE_TAG_RE = re.compile(r"(?<![\w#/])#([A-Za-z0-9_/\-]*[A-Za-z_/\-][A-Za-z0-9_/\-]*)")


# --------------------------------------------------------------------------
# Errors
# --------------------------------------------------------------------------


class VaultError(Exception):
    """Base for every expected failure. Carries a stable machine-readable code."""

    code = "vault_error"

    def __init__(self, message: str, **details):
        super().__init__(message)
        self.message = message
        self.details = details

    def as_dict(self) -> dict:
        return {"error": self.code, "message": self.message, **self.details}


class PathTraversalError(VaultError):
    code = "path_outside_vault"


class NoteNotFoundError(VaultError):
    code = "note_not_found"


class NoteExistsError(VaultError):
    code = "note_exists"


class ConflictError(VaultError):
    code = "version_conflict"


class AmbiguousReferenceError(VaultError):
    code = "ambiguous_reference"


class FrontmatterError(VaultError):
    code = "frontmatter_error"


class SearchError(VaultError):
    code = "invalid_query"


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------


def version_of(raw: bytes) -> str:
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def tokenize(text: str) -> list[str]:
    return [t.lower() for t in _TOKEN_RE.findall(text)]


@dataclass(frozen=True)
class Link:
    raw: str
    target: str
    heading: str | None
    block: str | None
    alias: str | None
    embed: bool

    def as_dict(self) -> dict:
        return {
            "raw": self.raw,
            "target": self.target,
            "heading": self.heading,
            "block": self.block,
            "alias": self.alias,
            "embed": self.embed,
        }


def _blank(chars: list[str], start: int, end: int) -> None:
    """Overwrite a span with spaces, leaving line breaks so lines still line up."""
    for i in range(start, end):
        if chars[i] not in "\r\n":
            chars[i] = " "


def _mask_fences(text: str) -> str:
    """Blank out ``` and ~~~ fenced blocks, including an unclosed final one."""
    chars = list(text)
    fence: tuple[str, int] | None = None
    pos = 0
    for line in text.splitlines(keepends=True):
        end = pos + len(line)
        match = _FENCE_RE.match(line.rstrip("\r\n"))
        if fence is None:
            # A backtick fence's info string may not itself contain a backtick.
            if match is not None and not (
                match.group(1)[0] == "`" and "`" in match.group(2)
            ):
                fence = (match.group(1)[0], len(match.group(1)))
                _blank(chars, pos, end)
        else:
            char, length = fence
            _blank(chars, pos, end)
            closes = (
                match is not None
                and match.group(1)[0] == char
                and len(match.group(1)) >= length
                and not match.group(2).strip()
            )
            if closes:
                fence = None
        pos = end
    return "".join(chars)


def _find_backtick_run(text: str, start: int, length: int) -> int | None:
    """Index of the next run of exactly ``length`` backticks at or after start."""
    i = text.find("`", start)
    while i != -1:
        j = i + 1
        while j < len(text) and text[j] == "`":
            j += 1
        if j - i == length:
            return i
        i = text.find("`", j)
    return None


def _mask_inline_code(text: str) -> str:
    """Blank out `code spans`, which close only on a run of the same length."""
    i = text.find("`")
    if i == -1:
        return text
    chars = list(text)
    while i != -1:
        j = i + 1
        while j < len(text) and text[j] == "`":
            j += 1
        length = j - i
        close = _find_backtick_run(text, j, length)
        if close is None:
            i = text.find("`", j)  # unmatched run, treat the backticks as literal
        else:
            _blank(chars, i, close + length)
            i = text.find("`", close + length)
    return "".join(chars)


def mask_code(text: str) -> str:
    """Blank out code regions so wikilinks inside them are not counted.

    Obsidian renders neither fenced blocks nor inline code spans as links.
    Masking replaces those characters with spaces rather than removing them,
    so every match offset still indexes the original text.
    """
    if "```" in text or "~~~" in text:
        text = _mask_fences(text)
    return _mask_inline_code(text)


def parse_links(text: str) -> list[Link]:
    """Extract wikilinks, including embeds, aliases, headings and block refs.

    Links inside fenced code blocks and inline code spans are skipped.
    """
    links: list[Link] = []
    for match in _WIKILINK_RE.finditer(mask_code(text)):
        embed = match.group(1) == "!"
        inner = match.group(2)
        alias = None
        if "|" in inner:
            inner, alias = inner.split("|", 1)
            alias = alias.strip() or None
        block = None
        if "#^" in inner:
            inner, block = inner.split("#^", 1)
            block = block.strip() or None
        heading = None
        if "#" in inner:
            inner, heading = inner.split("#", 1)
            heading = heading.strip() or None
        links.append(
            Link(
                # Slice the original: masking preserves offsets, not content.
                raw=text[match.start() : match.end()],
                target=inner.strip(),
                heading=heading,
                block=block,
                alias=alias,
                embed=embed,
            )
        )
    return links


def extract_tags(frontmatter: dict | None, body: str) -> list[str]:
    """Collect frontmatter and inline tags, normalised to lowercase, no '#'."""
    tags: list[str] = []
    if frontmatter:
        for key in ("tags", "tag"):
            value = frontmatter.get(key)
            if isinstance(value, str):
                tags.extend(part for part in re.split(r"[,\s]+", value) if part)
            elif isinstance(value, list):
                tags.extend(str(v) for v in value if v is not None)
    tags.extend(_INLINE_TAG_RE.findall(body))
    seen: dict[str, None] = {}
    for tag in tags:
        norm = tag.strip().lstrip("#").lower()
        if norm:
            seen.setdefault(norm, None)
    return list(seen)


def extract_aliases(frontmatter: dict | None) -> list[str]:
    if not frontmatter:
        return []
    value = frontmatter.get("aliases", frontmatter.get("alias"))
    if isinstance(value, str):
        return [value] if value.strip() else []
    if isinstance(value, list):
        return [str(v) for v in value if isinstance(v, (str, int, float))]
    return []


# --------------------------------------------------------------------------
# Index
# --------------------------------------------------------------------------


@dataclass
class Entry:
    rel: str
    mtime_ns: int
    size: int
    version: str
    title: str
    frontmatter: dict | None
    fm_state: str
    fm_error: str | None
    aliases: list[str]
    tags: list[str]
    links: list[Link]
    tf: dict[str, int] = field(default_factory=dict)
    length: int = 0


class Vault:
    """A vault rooted at ``root``. All paths in the public API are relative."""

    def __init__(self, root: str | os.PathLike):
        self.root = Path(root).expanduser()
        if not self.root.is_dir():
            raise VaultError(f"vault path is not a directory: {self.root}")
        self.root = self.root.resolve()
        self._entries: dict[str, Entry] = {}
        self._postings: dict[str, dict[str, int]] = {}
        self._df: dict[str, int] = {}
        self._total_len = 0
        self._names: dict[str, set[str]] = {}
        self._alias_map: dict[str, set[str]] = {}

    # -- paths -------------------------------------------------------------

    def resolve_path(self, rel: str) -> Path:
        """Resolve a vault-relative path, refusing anything outside the root."""
        if not isinstance(rel, str) or not rel.strip():
            raise PathTraversalError("path must be a non-empty string")
        if "\x00" in rel:
            raise PathTraversalError("path contains a null byte")
        candidate = Path(rel)
        if candidate.is_absolute() or re.match(r"^[A-Za-z]:[\\/]", rel):
            raise PathTraversalError(f"path must be relative to the vault: {rel!r}")

        resolved = (self.root / candidate).resolve()
        if resolved != self.root and self.root not in resolved.parents:
            raise PathTraversalError(f"path resolves outside the vault: {rel!r}")

        parts = resolved.relative_to(self.root).parts
        for part in parts[:-1] if len(parts) > 1 else ():
            if part in EXCLUDED_DIRS:
                raise PathTraversalError(f"path is inside an excluded directory: {part}")
        if parts and parts[0] in EXCLUDED_DIRS:
            raise PathTraversalError(f"path is inside an excluded directory: {parts[0]}")
        return resolved

    def relpath(self, path: Path) -> str:
        return path.resolve().relative_to(self.root).as_posix()

    def note_path(self, rel: str) -> Path:
        """Resolve a note path, appending '.md' when the caller omitted it."""
        if not isinstance(rel, str) or not rel.strip():
            raise PathTraversalError("path must be a non-empty string")
        if not rel.endswith(".md"):
            rel = rel + ".md"
        return self.resolve_path(rel)

    def iter_note_paths(self) -> Iterator[Path]:
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = sorted(d for d in dirnames if d not in EXCLUDED_DIRS)
            for name in sorted(filenames):
                if name.endswith(".md"):
                    yield Path(dirpath) / name

    # -- index maintenance -------------------------------------------------

    def _add_entry(self, entry: Entry) -> None:
        self._entries[entry.rel] = entry
        self._total_len += entry.length
        for term, count in entry.tf.items():
            postings = self._postings.setdefault(term, {})
            postings[entry.rel] = count
            self._df[term] = self._df.get(term, 0) + 1
        self._names.setdefault(entry.title.lower(), set()).add(entry.rel)
        for alias in entry.aliases:
            self._alias_map.setdefault(alias.strip().lower(), set()).add(entry.rel)

    def _remove_entry(self, rel: str) -> None:
        entry = self._entries.pop(rel, None)
        if entry is None:
            return
        self._total_len -= entry.length
        for term in entry.tf:
            postings = self._postings.get(term)
            if postings is not None and postings.pop(rel, None) is not None:
                self._df[term] = self._df.get(term, 1) - 1
                if self._df[term] <= 0:
                    self._df.pop(term, None)
                if not postings:
                    self._postings.pop(term, None)
        names = self._names.get(entry.title.lower())
        if names is not None:
            names.discard(rel)
            if not names:
                self._names.pop(entry.title.lower(), None)
        for alias in entry.aliases:
            key = alias.strip().lower()
            bucket = self._alias_map.get(key)
            if bucket is not None:
                bucket.discard(rel)
                if not bucket:
                    self._alias_map.pop(key, None)

    def _build_entry(self, path: Path, rel: str, stat: os.stat_result) -> Entry | None:
        try:
            raw = path.read_bytes()
        except (FileNotFoundError, IsADirectoryError):
            return None
        except OSError as exc:
            raise VaultError(f"cannot read {rel}: {exc.strerror or exc}") from exc

        sp = fm.split(raw)
        parsed, state, error = fm.parse(sp)
        body = sp.body.decode("utf-8", errors="replace")
        title = Path(rel).stem
        aliases = extract_aliases(parsed)
        tags = extract_tags(parsed, body)

        bag = tokenize(title) + tokenize(body)
        for alias in aliases:
            bag.extend(tokenize(alias))
        for tag in tags:
            bag.extend(tokenize(tag))
        tf: dict[str, int] = {}
        for token in bag:
            tf[token] = tf.get(token, 0) + 1

        return Entry(
            rel=rel,
            mtime_ns=stat.st_mtime_ns,
            size=stat.st_size,
            version=version_of(raw),
            title=title,
            frontmatter=parsed,
            fm_state=state,
            fm_error=error,
            aliases=aliases,
            tags=tags,
            links=parse_links(body),
            tf=tf,
            length=len(bag),
        )

    def refresh(self) -> dict:
        """Bring the index up to date, reparsing only files whose stat changed."""
        seen: set[str] = set()
        added = modified = removed = unchanged = 0
        for path in self.iter_note_paths():
            try:
                stat = path.stat()
            except OSError:
                continue  # vanished or unreadable between walk and stat
            rel = path.relative_to(self.root).as_posix()
            seen.add(rel)
            existing = self._entries.get(rel)
            if (
                existing is not None
                and existing.mtime_ns == stat.st_mtime_ns
                and existing.size == stat.st_size
            ):
                unchanged += 1
                continue
            try:
                entry = self._build_entry(path, rel, stat)
            except VaultError:
                # An unreadable file must not break every other query.
                self._remove_entry(rel)
                seen.discard(rel)
                continue
            if entry is None:
                seen.discard(rel)
                continue
            if existing is None:
                added += 1
            else:
                modified += 1
                self._remove_entry(rel)
            self._add_entry(entry)

        for rel in list(self._entries.keys() - seen):
            self._remove_entry(rel)
            removed += 1

        return {
            "notes": len(self._entries),
            "added": added,
            "modified": modified,
            "removed": removed,
            "unchanged": unchanged,
            "terms": len(self._postings),
        }

    def reindex(self) -> dict:
        """Drop the cache and rebuild it from scratch."""
        self._entries.clear()
        self._postings.clear()
        self._df.clear()
        self._total_len = 0
        self._names.clear()
        self._alias_map.clear()
        stats = self.refresh()
        stats["rebuilt"] = True
        return stats

    def index_snapshot(self) -> dict:
        """Deterministic view of the index, for comparing incremental vs full."""
        return {
            rel: {
                "version": entry.version,
                "title": entry.title,
                "tags": sorted(entry.tags),
                "aliases": sorted(entry.aliases),
                "links": sorted(link.raw for link in entry.links),
                "length": entry.length,
                "tf": dict(sorted(entry.tf.items())),
                "fm_state": entry.fm_state,
            }
            for rel, entry in sorted(self._entries.items())
        }

    # -- reference resolution ---------------------------------------------

    def _entry(self, rel: str) -> Entry:
        entry = self._entries.get(rel)
        if entry is None:
            raise NoteNotFoundError(f"note not in index: {rel}")
        return entry

    def resolve_reference(self, ref: str, *, strict: bool = True) -> str:
        """Resolve a path or a bare note name to exactly one vault-relative path.

        Ambiguous bare names raise rather than guessing.
        """
        self.refresh()
        candidates = self._candidates(ref)
        if len(candidates) == 1:
            return candidates[0]
        if not candidates:
            raise NoteNotFoundError(f"no note matches {ref!r}")
        if strict:
            raise AmbiguousReferenceError(
                f"{ref!r} matches {len(candidates)} notes; "
                f"pass a full vault-relative path. Candidates: {', '.join(candidates)}",
                candidates=candidates,
            )
        return candidates[0]

    def _candidates(self, ref: str) -> list[str]:
        """Obsidian-style resolution: exact path first, then name, then alias."""
        ref = ref.strip()
        if not ref:
            return []
        as_path = ref if ref.endswith(".md") else ref + ".md"
        try:
            resolved = self.resolve_path(as_path)
        except PathTraversalError:
            resolved = None
        if resolved is not None:
            rel = resolved.relative_to(self.root).as_posix()
            if rel in self._entries:
                return [rel]
            lowered = rel.lower()
            hits = [r for r in self._entries if r.lower() == lowered]
            if hits:
                return sorted(hits)
        if "/" in ref:
            return []
        name = Path(ref).stem.lower()
        matches = set(self._names.get(name, ()))
        if not matches:
            matches = set(self._alias_map.get(name, ()))
        return sorted(matches)

    # -- reading -----------------------------------------------------------

    def _read_raw(self, rel: str) -> tuple[Path, bytes]:
        path = self.note_path(rel)
        try:
            return path, path.read_bytes()
        except FileNotFoundError as exc:
            raise NoteNotFoundError(f"note does not exist: {self.relpath_of(path)}") from exc
        except IsADirectoryError as exc:
            raise NoteNotFoundError(f"not a file: {self.relpath_of(path)}") from exc
        except PermissionError as exc:
            raise VaultError(f"permission denied reading {self.relpath_of(path)}") from exc
        except OSError as exc:
            raise VaultError(
                f"cannot read {self.relpath_of(path)}: {exc.strerror or exc}"
            ) from exc

    def relpath_of(self, path: Path) -> str:
        try:
            return path.resolve().relative_to(self.root).as_posix()
        except ValueError:
            return str(path)

    def read_note(self, path: str) -> dict:
        note_path, raw = self._read_raw(path)
        rel = self.relpath_of(note_path)
        sp = fm.split(raw)
        parsed, state, error = fm.parse(sp)
        body = sp.body.decode("utf-8", errors="replace")
        links = parse_links(body)
        return {
            "path": rel,
            "title": Path(rel).stem,
            "version": version_of(raw),
            "frontmatter": parsed,
            "frontmatter_state": state,
            "frontmatter_error": error,
            "frontmatter_raw": sp.block.decode("utf-8", errors="replace"),
            "body": body,
            # The BOM is stripped from the text handed out; `has_bom` records
            # that the file had one, and writers put it back unchanged.
            "raw": raw[len(sp.bom) :].decode("utf-8", errors="replace"),
            "has_bom": bool(sp.bom),
            "links": [link.as_dict() for link in links],
            "tags": extract_tags(parsed, body),
            "aliases": extract_aliases(parsed),
            "size": len(raw),
        }

    # -- filtering ---------------------------------------------------------

    @staticmethod
    def _tag_matches(entry_tags: list[str], wanted: str) -> bool:
        wanted = wanted.strip().lstrip("#").lower()
        return any(tag == wanted or tag.startswith(wanted + "/") for tag in entry_tags)

    @staticmethod
    def _value_matches(actual, wanted) -> bool:
        if isinstance(actual, list):
            return any(Vault._value_matches(item, wanted) for item in actual)
        if isinstance(actual, str) and isinstance(wanted, str):
            return actual.strip().lower() == wanted.strip().lower()
        if isinstance(actual, bool) or isinstance(wanted, bool):
            return actual is wanted
        if isinstance(actual, (int, float)) and isinstance(wanted, (int, float)):
            return float(actual) == float(wanted)
        if actual is None or wanted is None:
            return actual is None and wanted is None
        return str(actual) == str(wanted)

    def _passes(
        self,
        entry: Entry,
        folder: str | None,
        tags: list[str] | None,
        frontmatter_filter: dict | None,
    ) -> bool:
        if folder:
            prefix = folder.strip().strip("/")
            if prefix and not (
                entry.rel == prefix or entry.rel.startswith(prefix + "/")
            ):
                return False
        if tags:
            if not all(self._tag_matches(entry.tags, tag) for tag in tags):
                return False
        if frontmatter_filter:
            data = entry.frontmatter or {}
            for key, wanted in frontmatter_filter.items():
                if key not in data:
                    return False
                if not self._value_matches(data[key], wanted):
                    return False
        return True

    # -- search ------------------------------------------------------------

    def search(
        self,
        query: str,
        *,
        folder: str | None = None,
        tags: list[str] | None = None,
        frontmatter_filter: dict | None = None,
        limit: int = 20,
    ) -> dict:
        if not isinstance(query, str) or not query.strip():
            raise SearchError("query must be a non-empty string")
        terms = tokenize(query)
        if not terms:
            raise SearchError(f"query {query!r} contains no searchable terms")
        if limit is not None and limit <= 0:
            raise SearchError("limit must be a positive integer")

        self.refresh()
        allowed = {
            rel
            for rel, entry in self._entries.items()
            if self._passes(entry, folder, tags, frontmatter_filter)
        }
        total = len(self._entries)
        if total == 0 or not allowed:
            return {"query": query, "total_matches": 0, "results": []}

        avgdl = (self._total_len / total) if total else 0.0
        scores: dict[str, float] = {}
        matched: dict[str, set[str]] = {}
        unique_terms = list(dict.fromkeys(terms))
        for term in unique_terms:
            postings = self._postings.get(term)
            if not postings:
                continue
            df = self._df.get(term, 0)
            idf = math.log(1 + (total - df + 0.5) / (df + 0.5))
            for rel, tf in postings.items():
                if rel not in allowed:
                    continue
                dl = self._entries[rel].length or 1
                denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * dl / (avgdl or 1))
                scores[rel] = scores.get(rel, 0.0) + idf * (tf * (BM25_K1 + 1)) / denom
                matched.setdefault(rel, set()).add(term)

        ranked = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))
        results = []
        for rel, score in ranked[: limit or len(ranked)]:
            entry = self._entries[rel]
            terms_here = sorted(matched.get(rel, ()))
            results.append(
                {
                    "path": rel,
                    "score": round(score, 6),
                    "title": entry.title,
                    "snippet": self._snippet(rel, terms_here),
                    "matched_terms": terms_here,
                    "tags": entry.tags,
                }
            )
        return {"query": query, "total_matches": len(ranked), "results": results}

    def _snippet(self, rel: str, terms: list[str], width: int = 240) -> str:
        try:
            raw = (self.root / rel).read_bytes()
        except OSError:
            return ""  # deleted or unreadable since the index was refreshed
        body = fm.split(raw).body.decode("utf-8", errors="replace")
        position = -1
        for term in terms:
            match = re.search(r"\b" + re.escape(term), body, re.IGNORECASE)
            if match and (position == -1 or match.start() < position):
                position = match.start()
        if position == -1:
            position = 0
        start = max(0, position - width // 3)
        chunk = body[start : start + width]
        chunk = " ".join(chunk.split())
        prefix = "…" if start > 0 else ""
        suffix = "…" if start + width < len(body) else ""
        return f"{prefix}{chunk}{suffix}"

    def list_notes(
        self,
        *,
        folder: str | None = None,
        tags: list[str] | None = None,
        frontmatter_filter: dict | None = None,
        limit: int = 200,
        offset: int = 0,
    ) -> dict:
        if limit is not None and limit <= 0:
            raise SearchError("limit must be a positive integer")
        if offset < 0:
            raise SearchError("offset must be zero or greater")
        self.refresh()
        matches = [
            entry
            for _, entry in sorted(self._entries.items())
            if self._passes(entry, folder, tags, frontmatter_filter)
        ]
        window = matches[offset : offset + limit] if limit else matches[offset:]
        return {
            "total": len(matches),
            "offset": offset,
            "notes": [
                {
                    "path": entry.rel,
                    "title": entry.title,
                    "version": entry.version,
                    "size": entry.size,
                    "tags": entry.tags,
                    "aliases": entry.aliases,
                    "frontmatter_state": entry.fm_state,
                }
                for entry in window
            ],
        }

    # -- link graph --------------------------------------------------------

    def get_links(self, path: str) -> dict:
        rel = self.resolve_reference(path)
        entry = self._entry(rel)
        out = []
        for link in entry.links:
            record = link.as_dict()
            if not link.target:
                record["status"] = "self"
                out.append(record)
                continue
            candidates = self._candidates(link.target)
            if len(candidates) == 1:
                record["status"] = "resolved"
                record["resolved_path"] = candidates[0]
            elif not candidates:
                record["status"] = "broken"
            else:
                record["status"] = "ambiguous"
                record["candidates"] = candidates
            out.append(record)
        return {
            "path": rel,
            "version": entry.version,
            "links": out,
            "counts": {
                "total": len(out),
                "resolved": sum(1 for r in out if r["status"] == "resolved"),
                "broken": sum(1 for r in out if r["status"] == "broken"),
                "ambiguous": sum(1 for r in out if r["status"] == "ambiguous"),
            },
        }

    def get_backlinks(self, path: str) -> dict:
        rel = self.resolve_reference(path)
        entry = self._entry(rel)
        names = {entry.title.lower()}
        aliases = {a.strip().lower() for a in entry.aliases if a.strip()}
        rel_no_ext = rel[:-3].lower()

        backlinks = []
        for source_rel, source in sorted(self._entries.items()):
            if source_rel == rel:
                continue
            for link in source.links:
                target = link.target.strip()
                if not target:
                    continue
                key = target.lower()
                if key.endswith(".md"):
                    key = key[:-3]
                matched_via = None
                if "/" in key:
                    if key == rel_no_ext:
                        matched_via = "path"
                elif key in names:
                    matched_via = "name"
                elif key in aliases:
                    matched_via = "alias"
                if matched_via is None:
                    continue
                candidates = self._candidates(target)
                backlinks.append(
                    {
                        "source": source_rel,
                        "raw": link.raw,
                        "alias": link.alias,
                        "heading": link.heading,
                        "embed": link.embed,
                        "matched_via": matched_via,
                        "ambiguous": len(candidates) > 1,
                        "candidates": candidates if len(candidates) > 1 else None,
                        "context": self._link_context(source_rel, link.raw),
                    }
                )
        return {"path": rel, "count": len(backlinks), "backlinks": backlinks}

    def _link_context(self, rel: str, raw_link: str, width: int = 200) -> str:
        try:
            raw = (self.root / rel).read_bytes()
        except OSError:
            return ""
        body = fm.split(raw).body.decode("utf-8", errors="replace")
        position = body.find(raw_link)
        if position == -1:
            return ""
        start = max(0, position - width // 3)
        chunk = " ".join(body[start : start + width].split())
        return f"{'…' if start > 0 else ''}{chunk}"

    # -- writing -----------------------------------------------------------

    def _atomic_write(self, path: Path, data: bytes) -> None:
        """Write ``data`` to ``path`` so an interruption cannot truncate it."""
        directory = path.parent
        directory.mkdir(parents=True, exist_ok=True)
        mode = None
        try:
            mode = path.stat().st_mode & 0o777
        except OSError:
            pass

        fd, tmp_name = tempfile.mkstemp(
            dir=str(directory), prefix=f".{path.name}.", suffix=".tmp"
        )
        tmp = Path(tmp_name)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            if mode is not None:
                os.chmod(tmp, mode)
            os.replace(tmp, path)
        except BaseException:
            # The original file has not been touched at this point.
            try:
                tmp.unlink()
            except OSError:
                pass
            raise
        try:
            dir_fd = os.open(str(directory), os.O_RDONLY)
        except OSError:
            return
        try:
            os.fsync(dir_fd)
        except OSError:
            pass
        finally:
            os.close(dir_fd)

    def _rename_no_clobber(self, src: Path, dst: Path) -> None:
        dst.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.link(src, dst)
        except FileExistsError as exc:
            raise NoteExistsError(f"destination already exists: {self.relpath_of(dst)}") from exc
        except OSError:
            if dst.exists():
                raise NoteExistsError(f"destination already exists: {self.relpath_of(dst)}")
            os.replace(src, dst)
            return
        os.unlink(src)

    def _check_version(self, rel: str, raw: bytes, expected_version: str) -> str:
        actual = version_of(raw)
        if not expected_version:
            raise ConflictError(
                f"expected_version is required when modifying {rel}",
                path=rel,
                actual_version=actual,
            )
        if expected_version != actual:
            raise ConflictError(
                f"{rel} changed on disk since it was read "
                f"(expected {expected_version}, found {actual}); re-read before writing",
                path=rel,
                expected_version=expected_version,
                actual_version=actual,
            )
        return actual

    def create_note(
        self, path: str, body: str = "", frontmatter: dict | None = None
    ) -> dict:
        note_path = self.note_path(path)
        rel = self.relpath_of(note_path)
        if note_path.exists():
            raise NoteExistsError(f"note already exists: {rel}", path=rel)
        block = fm.new_block(frontmatter or {})
        content = block + body.encode("utf-8")
        try:
            note_path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(str(note_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError as exc:
            raise NoteExistsError(f"note already exists: {rel}", path=rel) from exc
        except PermissionError as exc:
            raise VaultError(f"permission denied creating {rel}") from exc
        os.close(fd)
        try:
            self._atomic_write(note_path, content)
        except BaseException:
            # Remove the placeholder so a failed create leaves no empty note.
            try:
                note_path.unlink()
            except OSError:
                pass
            raise
        self.refresh()
        return {
            "path": rel,
            "version": version_of(content),
            "size": len(content),
            "created": True,
        }

    def replace_body(self, path: str, body: str, expected_version: str) -> dict:
        note_path, raw = self._read_raw(path)
        rel = self.relpath_of(note_path)
        self._check_version(rel, raw, expected_version)
        sp = fm.split(raw)
        content = sp.bom + sp.block + body.encode("utf-8")
        self._atomic_write(note_path, content)
        self.refresh()
        return {
            "path": rel,
            "version": version_of(content),
            "previous_version": expected_version,
            "frontmatter_unchanged": True,
            "size": len(content),
        }

    def update_frontmatter(
        self,
        path: str,
        updates: dict | None,
        expected_version: str,
        delete_keys: list[str] | None = None,
    ) -> dict:
        updates = updates or {}
        delete_keys = delete_keys or []
        if not updates and not delete_keys:
            raise VaultError("nothing to do: provide updates and/or delete_keys")
        overlap = sorted(set(updates) & set(delete_keys))
        if overlap:
            raise VaultError(f"keys appear in both updates and delete_keys: {overlap}")

        note_path, raw = self._read_raw(path)
        rel = self.relpath_of(note_path)
        self._check_version(rel, raw, expected_version)
        sp = fm.split(raw)

        if sp.state == fm.UNTERMINATED:
            raise FrontmatterError(
                f"{rel} starts with '---' that is never closed; "
                "refusing to guess where the frontmatter ends",
                path=rel,
            )
        _, state, error = fm.parse(sp)
        if state in (fm.INVALID, fm.NOT_MAPPING):
            raise FrontmatterError(
                f"{rel} has frontmatter that cannot be parsed ({error}); "
                "refusing to rewrite it",
                path=rel,
            )

        if sp.state == fm.ABSENT:
            if delete_keys:
                raise FrontmatterError(
                    f"{rel} has no frontmatter, so {delete_keys} cannot be deleted",
                    path=rel,
                )
            block = fm.new_block(updates)
            content = sp.bom + block + sp.body
        else:
            try:
                block = fm.edit_block(sp, updates, delete_keys)
            except fm.RoundTripUnstable as exc:
                raise FrontmatterError(f"{rel}: {exc.detail}", path=rel) from exc
            except KeyError as exc:
                raise FrontmatterError(
                    f"{rel} has no frontmatter key {exc.args[0]!r}", path=rel
                ) from exc
            content = sp.bom + block + sp.body

        self._atomic_write(note_path, content)
        self.refresh()
        new_sp = fm.split(content)
        parsed, _, _ = fm.parse(new_sp)
        return {
            "path": rel,
            "version": version_of(content),
            "previous_version": expected_version,
            "body_unchanged": new_sp.body == sp.body,
            "frontmatter": parsed,
            "updated_keys": sorted(updates),
            "deleted_keys": sorted(delete_keys),
        }

    # -- move / rename / delete -------------------------------------------

    def _affected_backlinks(self, rel: str) -> list[dict]:
        """Notes whose wikilinks point at ``rel``; these are NOT rewritten."""
        try:
            data = self.get_backlinks(rel)
        except VaultError:
            return []
        return [
            {"source": b["source"], "raw": b["raw"], "matched_via": b["matched_via"]}
            for b in data["backlinks"]
        ]

    def rename_note(
        self,
        path: str,
        new_name: str,
        expected_version: str,
        dry_run: bool = False,
    ) -> dict:
        if not isinstance(new_name, str) or not new_name.strip():
            raise VaultError("new_name must be a non-empty string")
        if "/" in new_name or "\\" in new_name:
            raise VaultError("new_name must be a bare filename; use move_note to change folders")
        note_path, raw = self._read_raw(path)
        rel = self.relpath_of(note_path)
        target_rel = (Path(rel).parent / new_name).as_posix()
        return self._relocate(note_path, raw, rel, target_rel, expected_version, dry_run, "rename")

    def move_note(
        self,
        path: str,
        new_path: str,
        expected_version: str,
        dry_run: bool = False,
    ) -> dict:
        if not isinstance(new_path, str) or not new_path.strip():
            raise VaultError("new_path must be a non-empty string")
        note_path, raw = self._read_raw(path)
        rel = self.relpath_of(note_path)
        destination = new_path.strip()
        if destination.endswith("/"):
            destination = destination + Path(rel).name
        else:
            probe = self.resolve_path(destination)
            if probe.is_dir():
                destination = (Path(destination) / Path(rel).name).as_posix()
        return self._relocate(note_path, raw, rel, destination, expected_version, dry_run, "move")

    def _relocate(
        self,
        note_path: Path,
        raw: bytes,
        rel: str,
        target_rel: str,
        expected_version: str,
        dry_run: bool,
        action: str,
    ) -> dict:
        target_path = self.note_path(target_rel)
        target_rel = self.relpath_of(target_path)
        if target_rel == rel:
            raise VaultError(f"{action} destination is the same as the source: {rel}")
        if target_path.exists():
            raise NoteExistsError(f"destination already exists: {target_rel}", path=target_rel)

        # Checked even for a dry run: a plan built from a stale read is useless.
        self._check_version(rel, raw, expected_version)
        self.refresh()
        affected = self._affected_backlinks(rel)
        plan = {
            "action": action,
            "dry_run": dry_run,
            "from": rel,
            "to": target_rel,
            "changes": [{"action": action, "from": rel, "to": target_rel}],
            "files_changed": 0 if dry_run else 1,
            "affected_backlinks": affected,
            "affected_backlink_count": len(affected),
            "links_rewritten": False,
        }
        if dry_run:
            plan["files_changed"] = 0
            plan["would_change"] = [rel, target_rel]
            return plan

        current = note_path.read_bytes()
        if version_of(current) != expected_version:
            raise ConflictError(
                f"{rel} changed on disk during {action}", path=rel,
                expected_version=expected_version, actual_version=version_of(current),
            )
        self._rename_no_clobber(note_path, target_path)
        self.refresh()
        plan["version"] = version_of(current)
        return plan

    def delete_note(self, path: str, expected_version: str, dry_run: bool = False) -> dict:
        note_path, raw = self._read_raw(path)
        rel = self.relpath_of(note_path)
        trash_dir = self.root / TRASH_DIRNAME
        target = self._free_trash_name(trash_dir, Path(rel).name)
        trash_rel = f"{TRASH_DIRNAME}/{target.name}"

        # Checked even for a dry run: a plan built from a stale read is useless.
        self._check_version(rel, raw, expected_version)
        self.refresh()
        affected = self._affected_backlinks(rel)
        plan = {
            "action": "delete",
            "dry_run": dry_run,
            "from": rel,
            "to": trash_rel,
            "changes": [{"action": "trash", "from": rel, "to": trash_rel}],
            "files_changed": 0,
            "affected_backlinks": affected,
            "affected_backlink_count": len(affected),
            "links_rewritten": False,
        }
        if dry_run:
            plan["would_change"] = [rel]
            return plan

        trash_dir.mkdir(parents=True, exist_ok=True)
        target = self._free_trash_name(trash_dir, Path(rel).name)
        plan["to"] = f"{TRASH_DIRNAME}/{target.name}"
        plan["changes"][0]["to"] = plan["to"]
        self._rename_no_clobber(note_path, target)
        self.refresh()
        plan["files_changed"] = 1
        plan["trashed_path"] = plan["to"]
        return plan

    @staticmethod
    def _free_trash_name(trash_dir: Path, name: str) -> Path:
        candidate = trash_dir / name
        if not candidate.exists():
            return candidate
        stem, suffix = Path(name).stem, Path(name).suffix
        counter = 1
        while True:
            candidate = trash_dir / f"{stem} {counter}{suffix}"
            if not candidate.exists():
                return candidate
            counter += 1
