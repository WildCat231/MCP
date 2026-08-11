"""Write safety: atomicity, optimistic concurrency, path containment, dry runs."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from conftest import snapshot
from obsidian_mcp.vault import (
    ConflictError,
    NoteExistsError,
    NoteNotFoundError,
    PathTraversalError,
    Vault,
    VaultError,
)

TARGET = "projects/Alpha.md"


def temp_files(root: Path) -> list[str]:
    return [p.name for p in root.rglob("*.tmp")]


# -- optimistic concurrency -------------------------------------------------


def test_stale_version_raises_and_leaves_the_file_untouched(vault: Vault):
    version = vault.read_note(TARGET)["version"]
    path = vault.root / TARGET

    # Obsidian saves the note behind our back.
    path.write_bytes(path.read_bytes() + b"\nEdited in Obsidian.\n")
    on_disk = path.read_bytes()

    with pytest.raises(ConflictError) as excinfo:
        vault.replace_body(TARGET, "clobbered", version)

    assert excinfo.value.code == "version_conflict"
    assert excinfo.value.details["expected_version"] == version
    assert path.read_bytes() == on_disk, "a concurrent edit was overwritten"


def test_stale_version_blocks_update_frontmatter(vault: Vault):
    version = vault.read_note(TARGET)["version"]
    path = vault.root / TARGET
    path.write_bytes(path.read_bytes() + b"\nlater\n")
    on_disk = path.read_bytes()

    with pytest.raises(ConflictError):
        vault.update_frontmatter(TARGET, {"status": "done"}, version)
    assert path.read_bytes() == on_disk


@pytest.mark.parametrize("bad", ["", None])
def test_missing_expected_version_is_refused(vault: Vault, bad):
    path = vault.root / TARGET
    before = path.read_bytes()
    with pytest.raises(ConflictError, match="expected_version is required"):
        vault.replace_body(TARGET, "x", bad)
    assert path.read_bytes() == before


def test_version_changes_after_a_successful_write(vault: Vault):
    first = vault.read_note(TARGET)["version"]
    result = vault.replace_body(TARGET, "new\n", first)
    assert result["version"] != first
    assert vault.read_note(TARGET)["version"] == result["version"]

    # The now-stale first version must not work a second time.
    with pytest.raises(ConflictError):
        vault.replace_body(TARGET, "newer\n", first)


def test_rename_move_and_delete_all_require_the_current_version(vault: Vault):
    stale = "sha256:" + "0" * 64
    before = snapshot(vault.root)
    for call in (
        lambda: vault.rename_note(TARGET, "Gamma.md", stale),
        lambda: vault.move_note(TARGET, "archive/", stale),
        lambda: vault.delete_note(TARGET, stale),
    ):
        with pytest.raises(ConflictError):
            call()
    assert snapshot(vault.root) == before


# -- atomicity --------------------------------------------------------------


def test_interrupted_write_leaves_the_original_intact(vault: Vault, monkeypatch):
    """Fail halfway through writing the temp file; the note must be untouched."""
    path = vault.root / TARGET
    before = path.read_bytes()
    version = vault.read_note(TARGET)["version"]

    real_fdopen = os.fdopen

    class HalfWriter:
        """Writes half the bytes, then dies, exactly like a killed process."""

        def __init__(self, handle):
            self._handle = handle

        def write(self, data):
            self._handle.write(data[: len(data) // 2])
            raise OSError("simulated interruption mid-write")

        def flush(self):
            self._handle.flush()

        def fileno(self):
            return self._handle.fileno()

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return self._handle.__exit__(*exc)

    monkeypatch.setattr(os, "fdopen", lambda fd, mode: HalfWriter(real_fdopen(fd, mode)))
    with pytest.raises(OSError, match="simulated interruption"):
        vault.replace_body(TARGET, "a" * 5000, version)
    monkeypatch.undo()

    assert path.read_bytes() == before
    assert temp_files(vault.root) == [], "a partial temp file was left behind"


def test_crash_between_write_and_swap_leaves_the_original_intact(vault: Vault, monkeypatch):
    path = vault.root / TARGET
    before = path.read_bytes()
    version = vault.read_note(TARGET)["version"]

    def boom(src, dst):
        raise OSError("simulated crash before the atomic swap")

    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(OSError, match="before the atomic swap"):
        vault.replace_body(TARGET, "replacement body\n", version)
    monkeypatch.undo()

    assert path.read_bytes() == before
    assert temp_files(vault.root) == []


def test_failed_create_leaves_no_empty_note(vault: Vault, monkeypatch):
    def boom(src, dst):
        raise OSError("simulated crash")

    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(OSError):
        vault.create_note("brand/New.md", "hello")
    monkeypatch.undo()

    assert not (vault.root / "brand/New.md").exists()
    assert temp_files(vault.root) == []


def test_the_note_is_never_opened_for_truncation(vault: Vault, monkeypatch):
    """No code path may open the target note for writing directly."""
    path = vault.root / TARGET
    real_open = os.open
    opened_for_write = []

    def watched_open(file, flags, *args, **kwargs):
        if str(file) == str(path) and flags & (os.O_WRONLY | os.O_RDWR | os.O_TRUNC):
            opened_for_write.append((str(file), flags))
        return real_open(file, flags, *args, **kwargs)

    monkeypatch.setattr(os, "open", watched_open)
    version = vault.read_note(TARGET)["version"]
    vault.replace_body(TARGET, "rewritten\n", version)
    monkeypatch.undo()

    assert opened_for_write == []


# -- path containment -------------------------------------------------------


@pytest.mark.parametrize(
    "bad_path",
    [
        "../escape",
        "../../etc/passwd",
        "projects/../../escape",
        "/etc/passwd",
        "/tmp/note.md",
        "./../outside",
        "a/b/../../../c",
        "",
        "   ",
        "with\x00null",
    ],
)
def test_paths_outside_the_vault_raise(vault: Vault, bad_path):
    with pytest.raises(PathTraversalError):
        vault.resolve_path(bad_path)
    with pytest.raises(PathTraversalError):
        vault.read_note(bad_path)


@pytest.mark.parametrize("excluded", [".obsidian", ".git", ".trash", "node_modules"])
def test_excluded_directories_are_not_reachable(vault: Vault, excluded):
    with pytest.raises(PathTraversalError, match="excluded directory"):
        vault.read_note(f"{excluded}/anything.md")
    with pytest.raises(PathTraversalError, match="excluded directory"):
        vault.create_note(f"{excluded}/sneaky.md", "x")


def test_excluded_directories_are_not_indexed(vault: Vault):
    for excluded in (".obsidian", ".git", "node_modules", ".trash"):
        directory = vault.root / excluded
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "Hidden.md").write_text("secret overlay content\n")

    vault.reindex()
    paths = [note["path"] for note in vault.list_notes()["notes"]]
    assert not any(p.startswith((".obsidian", ".git", "node_modules", ".trash")) for p in paths)
    assert all(
        r["path"] != ".obsidian/Hidden.md" for r in vault.search("secret")["results"]
    )


def test_symlink_escaping_the_vault_is_refused(vault: Vault, tmp_path: Path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "Secret.md").write_text("not yours\n")
    (vault.root / "escape").symlink_to(outside)

    with pytest.raises(PathTraversalError):
        vault.read_note("escape/Secret.md")


def test_writes_cannot_escape_the_vault(vault: Vault):
    version = vault.read_note(TARGET)["version"]
    with pytest.raises(PathTraversalError):
        vault.create_note("../outside.md", "x")
    with pytest.raises(PathTraversalError):
        vault.move_note(TARGET, "../outside.md", version)
    with pytest.raises(VaultError):
        vault.rename_note(TARGET, "../outside.md", version)


# -- create -----------------------------------------------------------------


def test_create_note_writes_frontmatter_and_body(vault: Vault):
    result = vault.create_note(
        "new/Nested Note.md", "Body text.\n", {"title": "Nested Note", "tags": ["fresh"]}
    )
    content = (vault.root / "new/Nested Note.md").read_bytes()
    assert content == b"---\ntitle: Nested Note\ntags:\n  - fresh\n---\nBody text.\n"
    assert result["version"] == vault.read_note("new/Nested Note.md")["version"]


def test_create_note_refuses_to_overwrite(vault: Vault):
    before = (vault.root / TARGET).read_bytes()
    with pytest.raises(NoteExistsError):
        vault.create_note(TARGET, "clobber")
    assert (vault.root / TARGET).read_bytes() == before


def test_create_note_without_frontmatter(vault: Vault):
    vault.create_note("Plain.md", "just text\n")
    assert (vault.root / "Plain.md").read_bytes() == b"just text\n"


# -- rename / move / delete -------------------------------------------------


def test_rename_note(vault: Vault):
    version = vault.read_note(TARGET)["version"]
    content = (vault.root / TARGET).read_bytes()

    result = vault.rename_note(TARGET, "Alpha Prime.md", version)

    assert result["to"] == "projects/Alpha Prime.md"
    assert not (vault.root / TARGET).exists()
    assert (vault.root / "projects/Alpha Prime.md").read_bytes() == content


def test_rename_rejects_a_path_as_the_new_name(vault: Vault):
    version = vault.read_note(TARGET)["version"]
    with pytest.raises(VaultError, match="bare filename"):
        vault.rename_note(TARGET, "other/Alpha.md", version)


def test_rename_refuses_to_clobber(vault: Vault):
    version = vault.read_note(TARGET)["version"]
    with pytest.raises(NoteExistsError):
        vault.rename_note(TARGET, "Beta.md", version)
    assert (vault.root / TARGET).exists()
    assert (vault.root / "projects/Beta.md").exists()


def test_move_note_into_a_folder(vault: Vault):
    version = vault.read_note(TARGET)["version"]
    content = (vault.root / TARGET).read_bytes()
    (vault.root / "archive").mkdir(exist_ok=True)

    result = vault.move_note(TARGET, "archive", version)

    assert result["to"] == "archive/Alpha.md"
    assert (vault.root / "archive/Alpha.md").read_bytes() == content
    assert not (vault.root / TARGET).exists()


def test_move_note_to_a_new_nested_path(vault: Vault):
    version = vault.read_note(TARGET)["version"]
    vault.move_note(TARGET, "deep/deeper/Renamed.md", version)
    assert (vault.root / "deep/deeper/Renamed.md").exists()


def test_move_reports_backlinks_it_does_not_rewrite(vault: Vault):
    version = vault.read_note(TARGET)["version"]
    result = vault.move_note(TARGET, "archive/", version)
    sources = {b["source"] for b in result["affected_backlinks"]}
    assert sources == {"Docker Networking.md", "daily/2024-03-01.md", "projects/Beta.md"}
    assert result["links_rewritten"] is False


def test_delete_moves_to_trash_and_never_unlinks(vault: Vault):
    version = vault.read_note(TARGET)["version"]
    content = (vault.root / TARGET).read_bytes()
    files_before = len(snapshot(vault.root))

    result = vault.delete_note(TARGET, version)

    assert result["trashed_path"] == ".trash/Alpha.md"
    assert not (vault.root / TARGET).exists()
    trashed = vault.root / ".trash/Alpha.md"
    assert trashed.read_bytes() == content, "note content changed on the way to trash"
    assert len(snapshot(vault.root)) == files_before, "a file disappeared instead of moving"


def test_trash_never_overwrites_an_earlier_deletion(vault: Vault):
    vault.create_note("one/Same.md", "first\n")
    vault.create_note("two/Same.md", "second\n")

    vault.delete_note("one/Same.md", vault.read_note("one/Same.md")["version"])
    second = vault.delete_note("two/Same.md", vault.read_note("two/Same.md")["version"])

    assert second["trashed_path"] == ".trash/Same 1.md"
    assert (vault.root / ".trash/Same.md").read_bytes() == b"first\n"
    assert (vault.root / ".trash/Same 1.md").read_bytes() == b"second\n"


def test_delete_does_not_empty_the_trash(vault: Vault):
    trash = vault.root / ".trash"
    trash.mkdir()
    (trash / "Older.md").write_text("previously deleted\n")

    version = vault.read_note(TARGET)["version"]
    vault.delete_note(TARGET, version)

    assert (trash / "Older.md").read_text() == "previously deleted\n"


def test_operations_on_a_missing_note_raise_cleanly(vault: Vault):
    for call in (
        lambda: vault.read_note("Ghost.md"),
        lambda: vault.replace_body("Ghost.md", "x", "sha256:" + "0" * 64),
        lambda: vault.delete_note("Ghost.md", "sha256:" + "0" * 64),
        lambda: vault.rename_note("Ghost.md", "X.md", "sha256:" + "0" * 64),
    ):
        with pytest.raises(NoteNotFoundError) as excinfo:
            call()
        assert excinfo.value.code == "note_not_found"


# -- dry run ----------------------------------------------------------------


def test_dry_run_rename_changes_nothing(vault: Vault):
    before = snapshot(vault.root)
    version = vault.read_note(TARGET)["version"]

    plan = vault.rename_note(TARGET, "Alpha Prime.md", version, dry_run=True)

    assert snapshot(vault.root) == before
    assert plan["dry_run"] is True
    assert plan["files_changed"] == 0
    assert plan["changes"] == [
        {"action": "rename", "from": TARGET, "to": "projects/Alpha Prime.md"}
    ]


def test_dry_run_move_changes_nothing(vault: Vault):
    before = snapshot(vault.root)
    version = vault.read_note(TARGET)["version"]

    plan = vault.move_note(TARGET, "archive/", version, dry_run=True)

    assert snapshot(vault.root) == before
    assert plan["files_changed"] == 0
    assert plan["to"] == "archive/Alpha.md"
    assert len(plan["affected_backlinks"]) == 3


def test_dry_run_delete_changes_nothing(vault: Vault):
    before = snapshot(vault.root)
    version = vault.read_note(TARGET)["version"]

    plan = vault.delete_note(TARGET, version, dry_run=True)

    assert snapshot(vault.root) == before
    assert plan["files_changed"] == 0
    assert plan["to"] == ".trash/Alpha.md"
    assert not (vault.root / ".trash").exists(), "dry run created the trash directory"


def test_dry_run_still_reports_conflicts(vault: Vault):
    before = snapshot(vault.root)
    with pytest.raises(ConflictError):
        vault.delete_note(TARGET, "sha256:" + "0" * 64, dry_run=True)
    assert snapshot(vault.root) == before
