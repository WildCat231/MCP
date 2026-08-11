"""Shared fixtures. Every test runs against a throwaway copy of sandbox_vault."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from obsidian_mcp.vault import Vault

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SANDBOX = PROJECT_ROOT / "sandbox_vault"
SANDBOX_NOTE_COUNT = len(list(SANDBOX.rglob("*.md")))


@pytest.fixture(autouse=True)
def _no_real_vault(monkeypatch):
    """Make it impossible for a test to fall back to the user's real vault."""
    monkeypatch.delenv("OBSIDIAN_VAULT_PATH", raising=False)


@pytest.fixture
def vault_root(tmp_path: Path) -> Path:
    root = tmp_path / "vault"
    shutil.copytree(SANDBOX, root)
    return root


@pytest.fixture
def vault(vault_root: Path) -> Vault:
    v = Vault(vault_root)
    v.refresh()
    return v


def snapshot(root: Path) -> dict[str, bytes]:
    """Every file under ``root`` mapped to its exact bytes."""
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }
