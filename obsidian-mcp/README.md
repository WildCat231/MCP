# obsidian-mcp

A local MCP server that gives Claude Code filesystem-level access to an Obsidian
vault. Obsidian does not need to be running. The Markdown files are the source
of truth; the search index is a disposable in-memory cache.

## Layout

| File | Role |
| --- | --- |
| `obsidian_mcp/vault.py` | All vault behaviour: paths, index, BM25, link graph, writes. No MCP. |
| `obsidian_mcp/frontmatter.py` | Byte-preserving frontmatter split, parse and edit. |
| `obsidian_mcp/server.py` | MCP tool registration and error translation only. |
| `sandbox_vault/` | Throwaway fixture vault. Tests copy it into a temp directory. |
| `tests/` | 170 tests against real files in temp vaults. |

## Running

```bash
python -m venv .venv && .venv/bin/pip install -r requirements.txt
OBSIDIAN_VAULT_PATH=/path/to/vault .venv/bin/python -m obsidian_mcp.server
```

Claude Code config:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "/path/to/.venv/bin/python",
      "args": ["-m", "obsidian_mcp.server"],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/path/to/vault",
        "PYTHONPATH": "/path/to/obsidian-mcp"
      }
    }
  }
}
```

## SDK version

The `mcp` Python SDK renamed `FastMCP` (1.x, `mcp.server.fastmcp`) to
`MCPServer` (2.x, `mcp.server`). `server.py` imports whichever is present and
records the result in `server.SDK_FLAVOUR`. Both expose the same `.tool()`
decorator and `.run("stdio")`.

**Developed and tested against `mcp` 2.0.0** (`MCPServer`). The 1.x path is
written but has not been exercised — no `FastMCP` build was installed here.

## The twelve tools

**Read** — `read_note`, `search_notes`, `list_notes`, `get_links`, `get_backlinks`
**Write** — `create_note`, `replace_body`, `update_frontmatter`, `rename_note`, `move_note`, `delete_note`
**Maintenance** — `reindex`

## Guarantees

**Frontmatter is opaque by default.** A note is stored as `bom + fm_block +
body`, all raw bytes. `replace_body` reuses `bom` and `fm_block` verbatim, so
byte-identity is structural rather than best-effort. A UTF-8 BOM is peeled off
before the opening `---` is looked for, so a marked file's frontmatter is still
found; the text handed to the caller has the BOM stripped and `has_bom` records
that the file had one. Writers put back exactly what was there — a marked file
keeps its BOM, an unmarked file never gains one.

**Frontmatter edits refuse to reformat.** `update_frontmatter` uses
`ruamel.yaml` round-trip mode with the source document's own sequence
indentation and null spelling detected and re-applied. Before writing, it
round-trips the block with *no* changes and compares against the bytes on
disk. If they differ — meaning the emitter would restyle a key you did not ask
to touch — the write is refused with a `frontmatter_error` naming the first
differing line. The known case is capitalised booleans (`True`), which ruamel
lowercases; everything Obsidian itself writes round-trips exactly.

**Writes are atomic.** Temp file in the same directory, `flush`, `fsync`,
`os.replace`, then `fsync` on the directory. An interrupted write leaves the
original intact and no temp file behind.

**Optimistic concurrency.** Every read returns `version` (a SHA-256 of the file
bytes). Every mutation of an existing note requires `expected_version` and
raises `version_conflict` on mismatch, including on dry runs — a plan built
from a stale read is not worth returning.

**Wikilinks resolve like Obsidian**, by note name anywhere in the vault rather
than by relative path, case-insensitively. `[[Note|alias]]`, `[[Note#heading]]`,
`[[Note#^block]]`, `![[embeds]]` and frontmatter `aliases` are all handled.
Links inside fenced code blocks (both ``` and `~~~`, including unclosed ones)
and inside inline `` `code` `` spans are not links, matching what Obsidian
renders.
Where a single answer is required, an ambiguous bare name raises
`ambiguous_reference` listing the candidates; `get_links` instead marks the
link `ambiguous` and lists candidates, so one duplicate name cannot break the
whole call.

**Deletes go to `.trash`.** Nothing is ever unlinked, and the trash is never
emptied. Name collisions get an Obsidian-style ` 1`, ` 2` suffix.

**Path containment.** Absolute paths, null bytes, and anything resolving
outside the vault root raise `path_outside_vault`. Symlinks that escape are
caught because resolution happens before the check. `.obsidian`, `.trash`,
`.git` and `node_modules` are skipped by the indexer and unreachable through
any tool.

**No side databases.** The link graph is derived from note bodies on read.
Nothing is ever committed to Git.

## Search

BM25 (`k1=1.5`, `b=0.75`) over a per-note bag of tokens drawn from the note's
filename stem, its frontmatter aliases and tags, and its body. Notes containing
none of the query terms are not scored and do not appear. Filters — `folder`
(path prefix), `tags` (all must match, nested tags match by prefix) and
`frontmatter` (all key/value pairs must match) — are applied before ranking.

The index is refreshed before every query by `stat`-ing each note; only files
whose mtime or size changed are reparsed. Creates, modifies, deletes and
renames are all handled incrementally. `reindex` drops the cache and rebuilds,
producing an index identical to the incrementally maintained one.

## Deliberate non-features

`rename_note` and `move_note` do **not** rewrite wikilinks in other notes.
Because Obsidian resolves `[[Name]]` by name, a rename does break inbound
links, so both tools return `affected_backlinks` listing every note that
references the moved one. Rewriting them would mean mutating files the caller
never named; that is left as an explicit decision.

Code masking covers link extraction only: an inline `#tag` inside a code fence
is still indexed as a tag. Indented (four-space) code blocks are not masked.
Markdown-style `[text](note.md)` links are not in the graph — wikilinks only.
Only a UTF-8 BOM is recognised; UTF-16 files are not supported.

## Tests

```bash
.venv/bin/python -m pytest
```
