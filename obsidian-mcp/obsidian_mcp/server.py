"""MCP stdio server exposing the vault. Twelve tools, no more.

This module is only tool registration and error translation. All behaviour
lives in ``obsidian_mcp.vault`` so the test suite exercises real logic rather
than tool-call plumbing.

SDK compatibility: the ``mcp`` Python SDK renamed ``FastMCP`` (1.x, in
``mcp.server.fastmcp``) to ``MCPServer`` (2.x, in ``mcp.server``). Both expose
the same ``.tool()`` decorator and ``.run("stdio")``, so we detect which one is
installed at import time and use it.
"""

from __future__ import annotations

import functools
import os
import sys
from typing import Any

from .vault import Vault, VaultError

try:  # mcp >= 2.0
    from mcp.server import MCPServer as _ServerClass

    SDK_FLAVOUR = "mcp>=2.0 (MCPServer)"
except ImportError:  # pragma: no cover - depends on installed SDK
    from mcp.server.fastmcp import FastMCP as _ServerClass

    SDK_FLAVOUR = "mcp<2.0 (FastMCP)"

try:  # mcp >= 2.0
    from mcp.server.mcpserver.exceptions import ToolError
except ImportError:  # pragma: no cover - depends on installed SDK
    try:
        from mcp.server.fastmcp.exceptions import ToolError
    except ImportError:
        ToolError = RuntimeError  # type: ignore[assignment,misc]


TOOL_NAMES = (
    "read_note",
    "search_notes",
    "list_notes",
    "get_links",
    "get_backlinks",
    "create_note",
    "replace_body",
    "update_frontmatter",
    "rename_note",
    "move_note",
    "delete_note",
    "reindex",
)

mcp = _ServerClass(
    name="obsidian-vault",
    instructions=(
        "Filesystem-level access to an Obsidian vault. Markdown files are the "
        "source of truth; Obsidian does not need to be running. Read a note "
        "first to obtain its `version`, then pass that version as "
        "`expected_version` on any write. A version mismatch means someone "
        "else edited the note and the write is refused."
    ),
)

_vault: Vault | None = None


def configure(vault: Vault) -> None:
    """Install the vault instance the tools operate on."""
    global _vault
    _vault = vault


def get_vault() -> Vault:
    global _vault
    if _vault is None:
        root = os.environ.get("OBSIDIAN_VAULT_PATH")
        if not root:
            raise VaultError("OBSIDIAN_VAULT_PATH is not set")
        _vault = Vault(root)
    return _vault


def _tool(func):
    """Turn expected vault failures into clean tool errors, never tracebacks."""

    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        try:
            return func(*args, **kwargs)
        except VaultError as exc:
            raise ToolError(f"{exc.code}: {exc.message}") from None

    return wrapper


# ---------------------------------------------------------------- read tools


@mcp.tool()
@_tool
def read_note(path: str) -> dict[str, Any]:
    """Read one note, returning frontmatter, body, links and a version hash.

    `path` is vault-relative (the `.md` suffix is optional). The returned
    `version` is required for any later write to this note.
    """
    return get_vault().read_note(path)


@mcp.tool()
@_tool
def search_notes(
    query: str,
    folder: str | None = None,
    tags: list[str] | None = None,
    frontmatter: dict | None = None,
    limit: int = 20,
) -> dict[str, Any]:
    """BM25-ranked full-text search with optional metadata filtering.

    `folder` restricts to a path prefix, `tags` requires every listed tag
    (nested tags match by prefix), and `frontmatter` requires every listed
    key/value pair. Notes containing none of the query terms are not returned.
    """
    return get_vault().search(
        query, folder=folder, tags=tags, frontmatter_filter=frontmatter, limit=limit
    )


@mcp.tool()
@_tool
def list_notes(
    folder: str | None = None,
    tags: list[str] | None = None,
    frontmatter: dict | None = None,
    limit: int = 200,
    offset: int = 0,
) -> dict[str, Any]:
    """List notes with their metadata and versions, filtered like search_notes."""
    return get_vault().list_notes(
        folder=folder,
        tags=tags,
        frontmatter_filter=frontmatter,
        limit=limit,
        offset=offset,
    )


@mcp.tool()
@_tool
def get_links(path: str) -> dict[str, Any]:
    """List outgoing wikilinks from a note with their resolution status.

    Each link is `resolved`, `broken`, `ambiguous` (with candidates listed) or
    `self`. Aliases, `[[Note|alias]]` and `[[Note#heading]]` are handled.
    """
    return get_vault().get_links(path)


@mcp.tool()
@_tool
def get_backlinks(path: str) -> dict[str, Any]:
    """List notes linking to this one, matching by name, alias or path.

    `path` may be a vault-relative path or a bare note name; a bare name that
    matches more than one note is an error listing the candidates.
    """
    return get_vault().get_backlinks(path)


# --------------------------------------------------------------- write tools


@mcp.tool()
@_tool
def create_note(path: str, body: str = "", frontmatter: dict | None = None) -> dict[str, Any]:
    """Create a new note. Fails if the path already exists."""
    return get_vault().create_note(path, body, frontmatter)


@mcp.tool()
@_tool
def replace_body(path: str, body: str, expected_version: str) -> dict[str, Any]:
    """Replace a note's body, leaving its frontmatter block byte-identical.

    `expected_version` must be the `version` from your most recent read.
    """
    return get_vault().replace_body(path, body, expected_version)


@mcp.tool()
@_tool
def update_frontmatter(
    path: str,
    expected_version: str,
    updates: dict | None = None,
    delete_keys: list[str] | None = None,
) -> dict[str, Any]:
    """Set or remove top-level frontmatter keys, leaving the body byte-identical.

    Other keys keep their order, quoting and comments. Nested values are
    replaced wholesale — pass the complete object for a nested key. If the
    block cannot be rewritten without reformatting untouched keys, the write
    is refused rather than normalising the file.
    """
    return get_vault().update_frontmatter(path, updates, expected_version, delete_keys)


@mcp.tool()
@_tool
def rename_note(
    path: str, new_name: str, expected_version: str, dry_run: bool = False
) -> dict[str, Any]:
    """Rename a note within its folder. Wikilinks in other notes are NOT rewritten.

    The response lists the notes that link to this one so you can decide what
    to do about them. With `dry_run` no file is touched.
    """
    return get_vault().rename_note(path, new_name, expected_version, dry_run)


@mcp.tool()
@_tool
def move_note(
    path: str, new_path: str, expected_version: str, dry_run: bool = False
) -> dict[str, Any]:
    """Move a note to another folder. Wikilinks in other notes are NOT rewritten.

    `new_path` may be a destination folder or a full vault-relative path. With
    `dry_run` no file is touched.
    """
    return get_vault().move_note(path, new_path, expected_version, dry_run)


@mcp.tool()
@_tool
def delete_note(path: str, expected_version: str, dry_run: bool = False) -> dict[str, Any]:
    """Move a note into the vault's .trash directory. Nothing is ever unlinked.

    With `dry_run` no file is touched.
    """
    return get_vault().delete_note(path, expected_version, dry_run)


# --------------------------------------------------------- maintenance tool


@mcp.tool()
@_tool
def reindex() -> dict[str, Any]:
    """Discard the search index and rebuild it from the files on disk."""
    return get_vault().reindex()


def main() -> None:
    root = os.environ.get("OBSIDIAN_VAULT_PATH")
    if not root:
        print(
            "OBSIDIAN_VAULT_PATH is not set; point it at your vault directory.",
            file=sys.stderr,
        )
        raise SystemExit(2)
    try:
        configure(Vault(root))
    except VaultError as exc:
        print(f"cannot open vault: {exc.message}", file=sys.stderr)
        raise SystemExit(2) from None
    mcp.run("stdio")


if __name__ == "__main__":
    main()
