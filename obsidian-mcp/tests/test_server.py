"""The MCP layer: exactly twelve tools, reachable over a real stdio subprocess."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import pytest

from mcp import Client, StdioServerParameters, stdio_client

from conftest import SANDBOX_NOTE_COUNT
from obsidian_mcp import server as server_module

PROJECT_ROOT = Path(__file__).resolve().parents[1]

EXPECTED_TOOLS = {
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
}


def test_the_sdk_shim_picked_a_server_class():
    assert server_module.SDK_FLAVOUR in {"mcp>=2.0 (MCPServer)", "mcp<2.0 (FastMCP)"}
    assert hasattr(server_module.mcp, "tool")
    assert hasattr(server_module.mcp, "run")


def test_the_declared_tool_list_matches_what_is_registered():
    assert set(server_module.TOOL_NAMES) == EXPECTED_TOOLS
    assert len(server_module.TOOL_NAMES) == 12


class Session:
    """Drives the server as a real subprocess over stdio."""

    def __init__(self, vault_root: Path):
        self.vault_root = vault_root

    def run(self, coro_factory):
        async def main():
            params = StdioServerParameters(
                command=sys.executable,
                args=["-m", "obsidian_mcp.server"],
                env={
                    **os.environ,
                    "OBSIDIAN_VAULT_PATH": str(self.vault_root),
                    "PYTHONPATH": str(PROJECT_ROOT),
                },
            )
            async with Client(stdio_client(params)) as client:
                return await coro_factory(client)

        return asyncio.run(main())


@pytest.fixture
def session(vault_root: Path) -> Session:
    return Session(vault_root)


def payload(result):
    """Structured content if the tool returned it, otherwise the JSON text block."""
    if result.structured_content is not None:
        return result.structured_content
    return json.loads(result.content[0].text)


def test_server_starts_and_lists_exactly_twelve_tools(session: Session):
    async def call(client):
        return await client.list_tools()

    tools = session.run(call)
    names = {tool.name for tool in tools.tools}
    assert names == EXPECTED_TOOLS
    assert len(tools.tools) == 12
    for tool in tools.tools:
        assert tool.description, f"{tool.name} has no description"


def test_read_note_returns_structured_output_over_the_wire(session: Session):
    async def call(client):
        return await client.call_tool("read_note", {"path": "projects/Alpha"})

    result = session.run(call)
    assert result.is_error is False
    data = payload(result)
    assert data["frontmatter"]["title"] == "Alpha"
    assert data["body"].startswith("Alpha is the first project.")
    assert data["version"].startswith("sha256:")
    assert [link["target"] for link in data["links"]] == ["Docker Networking"]
    assert data["raw"].startswith("---\n")


def test_a_full_read_modify_write_cycle_over_stdio(session: Session, vault_root: Path):
    async def call(client):
        note = payload(await client.call_tool("read_note", {"path": "projects/Alpha"}))
        write = await client.call_tool(
            "replace_body",
            {
                "path": "projects/Alpha.md",
                "body": "Rewritten through MCP.\n",
                "expected_version": note["version"],
            },
        )
        stale = await client.call_tool(
            "replace_body",
            {
                "path": "projects/Alpha.md",
                "body": "second write",
                "expected_version": note["version"],
            },
        )
        return payload(write), stale

    write, stale = session.run(call)
    assert write["frontmatter_unchanged"] is True
    assert stale.is_error is True
    assert "version_conflict" in stale.content[0].text

    content = (vault_root / "projects/Alpha.md").read_bytes()
    assert content.endswith(b"---\nRewritten through MCP.\n")


def test_search_with_filters_over_the_wire(session: Session):
    async def call(client):
        return await client.call_tool(
            "search_notes",
            {
                "query": "project",
                "folder": "projects",
                "tags": ["project"],
                "frontmatter": {"status": "archived"},
            },
        )

    data = payload(session.run(call))
    assert [hit["path"] for hit in data["results"]] == ["projects/Beta.md"]


def test_dry_run_over_the_wire_touches_nothing(session: Session, vault_root: Path):
    from conftest import snapshot

    before = snapshot(vault_root)

    async def call(client):
        note = payload(await client.call_tool("read_note", {"path": "projects/Alpha"}))
        return payload(
            await client.call_tool(
                "delete_note",
                {
                    "path": "projects/Alpha.md",
                    "expected_version": note["version"],
                    "dry_run": True,
                },
            )
        )

    plan = session.run(call)
    assert plan["files_changed"] == 0
    assert plan["to"] == ".trash/Alpha.md"
    assert snapshot(vault_root) == before


@pytest.mark.parametrize(
    "tool,args,expected",
    [
        ("read_note", {"path": "../../etc/passwd"}, "path_outside_vault"),
        ("read_note", {"path": "Nope.md"}, "note_not_found"),
        ("search_notes", {"query": "   "}, "invalid_query"),
        ("get_backlinks", {"path": "Duplicate"}, "ambiguous_reference"),
        ("create_note", {"path": "projects/Alpha.md"}, "note_exists"),
        (
            "update_frontmatter",
            {"path": "Malformed.md", "expected_version": "sha256:" + "0" * 64,
             "updates": {"a": 1}},
            "version_conflict",
        ),
    ],
)
def test_failures_come_back_as_clean_errors_not_tracebacks(
    session: Session, tool, args, expected
):
    async def call(client):
        return await client.call_tool(tool, args)

    result = session.run(call)
    text = result.content[0].text
    assert result.is_error is True
    assert expected in text
    assert "Traceback" not in text
    assert text.count("\n") == 0, f"error spans multiple lines: {text!r}"


def test_reindex_is_callable_over_the_wire(session: Session):
    async def call(client):
        return payload(await client.call_tool("reindex", {}))

    stats = session.run(call)
    assert stats["rebuilt"] is True
    assert stats["notes"] == SANDBOX_NOTE_COUNT


def test_server_refuses_to_start_without_a_vault_path():
    import subprocess

    env = {k: v for k, v in os.environ.items() if k != "OBSIDIAN_VAULT_PATH"}
    env["PYTHONPATH"] = str(PROJECT_ROOT)
    proc = subprocess.run(
        [sys.executable, "-m", "obsidian_mcp.server"],
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 2
    assert "OBSIDIAN_VAULT_PATH is not set" in proc.stderr
    assert "Traceback" not in proc.stderr


def test_server_refuses_to_start_on_a_missing_vault(tmp_path: Path):
    import subprocess

    env = {**os.environ, "OBSIDIAN_VAULT_PATH": str(tmp_path / "nope"),
           "PYTHONPATH": str(PROJECT_ROOT)}
    proc = subprocess.run(
        [sys.executable, "-m", "obsidian_mcp.server"],
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 2
    assert "cannot open vault" in proc.stderr
    assert "Traceback" not in proc.stderr
