"""Hostile inputs and races. Nothing here may produce a traceback to the caller."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from conftest import snapshot
from obsidian_mcp.vault import (
    ConflictError,
    NoteNotFoundError,
    Vault,
    VaultError,
)


# -- size -------------------------------------------------------------------


def test_huge_note_is_read_searched_and_rewritten(vault: Vault):
    filler = ("lorem ipsum dolor sit amet consectetur " * 20 + "\n") * 6000
    huge = "---\ntitle: Huge\n---\n" + filler + "the needle is here\n"
    (vault.root / "Huge.md").write_text(huge)
    assert (vault.root / "Huge.md").stat().st_size > 4_000_000

    vault.refresh()
    note = vault.read_note("Huge.md")
    assert note["size"] > 4_000_000
    assert note["frontmatter"] == {"title": "Huge"}

    assert [r["path"] for r in vault.search("needle")["results"]] == ["Huge.md"]

    vault.replace_body("Huge.md", "small again\n", note["version"])
    assert (vault.root / "Huge.md").read_bytes() == b"---\ntitle: Huge\n---\nsmall again\n"


def test_note_with_thousands_of_links(vault: Vault):
    body = "\n".join(f"[[Kubernetes Ingress]] and [[Ghost {i}]]" for i in range(2000))
    (vault.root / "LinkStorm.md").write_text(body)
    vault.refresh()

    result = vault.get_links("LinkStorm.md")
    assert result["counts"]["total"] == 4000
    assert result["counts"]["resolved"] == 2000
    assert result["counts"]["broken"] == 2000


# -- races ------------------------------------------------------------------


def test_note_deleted_between_index_and_read(vault: Vault):
    vault.refresh()
    (vault.root / "projects/Beta.md").unlink()

    with pytest.raises(NoteNotFoundError) as excinfo:
        vault.read_note("projects/Beta.md")
    assert excinfo.value.code == "note_not_found"


def test_note_deleted_between_index_and_snippet(vault: Vault):
    """Search must degrade to an empty snippet, not blow up."""
    vault.refresh()
    target = vault.root / "NoFrontmatter.md"

    real_read_bytes = Path.read_bytes

    def vanishing(self):
        if self.name == "NoFrontmatter.md":
            raise FileNotFoundError(str(self))
        return real_read_bytes(self)

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(Path, "read_bytes", vanishing)
        results = vault.search("overlay")

    hit = next(r for r in results["results"] if r["path"] == "NoFrontmatter.md")
    assert hit["snippet"] == ""
    assert hit["score"] > 0
    assert target.exists()


def test_note_deleted_during_a_walk(vault: Vault):
    """A file that vanishes between os.walk and stat is skipped silently."""
    vault.reindex()
    real_stat = Path.stat
    doomed = vault.root / "projects/Beta.md"
    already_deleted = []

    def racing_stat(self, *args, **kwargs):
        if self == doomed and not already_deleted:
            already_deleted.append(True)
            os.unlink(doomed)
        return real_stat(self, *args, **kwargs)

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(Path, "stat", racing_stat)
        vault.refresh()

    assert already_deleted, "the race was never triggered"
    assert "projects/Beta.md" not in [n["path"] for n in vault.list_notes()["notes"]]


def test_note_renamed_between_read_and_write(vault: Vault):
    note = vault.read_note("projects/Beta.md")
    os.rename(vault.root / "projects/Beta.md", vault.root / "projects/Moved.md")

    with pytest.raises(NoteNotFoundError):
        vault.replace_body("projects/Beta.md", "x", note["version"])

    # The moved file is untouched and still writable under its new name.
    assert (vault.root / "projects/Moved.md").exists()
    vault.replace_body("projects/Moved.md", "rewritten\n", note["version"])


def test_note_replaced_by_a_different_note_between_read_and_write(vault: Vault):
    note = vault.read_note("projects/Beta.md")
    (vault.root / "projects/Beta.md").write_text("---\ntitle: Impostor\n---\nnot Beta\n")
    on_disk = (vault.root / "projects/Beta.md").read_bytes()

    with pytest.raises(ConflictError):
        vault.replace_body("projects/Beta.md", "clobber", note["version"])
    assert (vault.root / "projects/Beta.md").read_bytes() == on_disk


def test_destination_appears_between_plan_and_rename(vault: Vault):
    """The no-clobber rename must refuse even if the check-then-act window loses."""
    note = vault.read_note("projects/Beta.md")
    (vault.root / "projects/Gamma.md").write_text("I got here first\n")

    with pytest.raises(VaultError, match="already exists"):
        vault.rename_note("projects/Beta.md", "Gamma.md", note["version"])
    assert (vault.root / "projects/Gamma.md").read_text() == "I got here first\n"
    assert (vault.root / "projects/Beta.md").exists()


# -- unreadable files -------------------------------------------------------


def test_permission_error_on_read_is_reported_cleanly(vault: Vault):
    real_read_bytes = Path.read_bytes

    def denied(self):
        if self.name == "Beta.md":
            raise PermissionError(13, "Permission denied", str(self))
        return real_read_bytes(self)

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(Path, "read_bytes", denied)
        with pytest.raises(VaultError) as excinfo:
            vault.read_note("projects/Beta.md")

    assert "permission denied" in excinfo.value.message.lower()
    assert excinfo.value.code == "vault_error"


def test_an_unreadable_file_does_not_break_the_whole_index(vault: Vault):
    real_read_bytes = Path.read_bytes

    def denied(self):
        if self.name == "Beta.md":
            raise PermissionError(13, "Permission denied", str(self))
        return real_read_bytes(self)

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(Path, "read_bytes", denied)
        vault.reindex()
        listed = [n["path"] for n in vault.list_notes()["notes"]]
        assert "projects/Beta.md" not in listed
        assert "projects/Alpha.md" in listed
        assert vault.search("overlay")["results"]


def test_a_directory_named_like_a_note_is_not_a_note(vault: Vault):
    (vault.root / "Folder.md").mkdir()
    vault.refresh()
    with pytest.raises(NoteNotFoundError):
        vault.read_note("Folder.md")
    assert "Folder.md" not in [n["path"] for n in vault.list_notes()["notes"]]


# -- odd but legal content --------------------------------------------------


def test_note_with_no_frontmatter(vault: Vault):
    note = vault.read_note("NoFrontmatter.md")
    assert note["frontmatter"] is None
    assert note["frontmatter_state"] == "absent"
    assert note["frontmatter_raw"] == ""
    assert note["raw"] == note["body"]

    vault.replace_body("NoFrontmatter.md", "replaced\n", note["version"])
    assert (vault.root / "NoFrontmatter.md").read_bytes() == b"replaced\n"


def test_note_that_is_only_frontmatter(vault: Vault):
    note = vault.read_note("OnlyFrontmatter.md")
    assert note["body"] == ""
    assert note["links"] == []
    assert note["tags"] == ["stub"]


def test_empty_file_survives_every_read_path(vault: Vault):
    assert vault.read_note("Empty.md")["body"] == ""
    assert vault.get_links("Empty.md")["links"] == []
    assert vault.get_backlinks("Empty.md")["backlinks"] == []
    assert "Empty.md" in [n["path"] for n in vault.list_notes()["notes"]]


def test_note_with_invalid_utf8_is_read_not_crashed_on(vault: Vault):
    (vault.root / "Binary.md").write_bytes(b"---\ntitle: Bin\n---\nbefore \xff\xfe after\n")
    vault.refresh()
    note = vault.read_note("Binary.md")
    assert "before" in note["body"] and "after" in note["body"]
    assert note["frontmatter"] == {"title": "Bin"}


def test_note_named_with_awkward_characters(vault: Vault):
    name = "Odd [name] with #hash & 'quotes'.md"
    vault.create_note(name, "content about pangolins\n")
    vault.refresh()
    assert [r["path"] for r in vault.search("pangolins")["results"]] == [name]
    assert vault.read_note(name)["title"] == "Odd [name] with #hash & 'quotes'"


def test_deeply_nested_note(vault: Vault):
    deep = "/".join(f"level{i}" for i in range(15)) + "/Deep.md"
    vault.create_note(deep, "buried treasure\n")
    assert [r["path"] for r in vault.search("treasure")["results"]] == [deep]
    assert vault.read_note(deep)["path"] == deep


def test_frontmatter_with_a_body_that_looks_like_frontmatter(vault: Vault):
    content = b"---\ntitle: Real\n---\nbody\n\n---\nnot: frontmatter\n---\n\nmore\n"
    (vault.root / "Tricky.md").write_bytes(content)
    vault.refresh()

    note = vault.read_note("Tricky.md")
    assert note["frontmatter"] == {"title": "Real"}
    assert note["frontmatter_raw"] == "---\ntitle: Real\n---\n"
    assert "not: frontmatter" in note["body"]

    before = snapshot(vault.root)["Tricky.md"]
    vault.update_frontmatter("Tricky.md", {"title": "Still Real"}, note["version"])
    after = (vault.root / "Tricky.md").read_bytes()
    assert after == before.replace(b"title: Real", b"title: Still Real")


def test_repeated_writes_never_leave_stray_temp_files(vault: Vault):
    for i in range(20):
        version = vault.read_note("projects/Beta.md")["version"]
        vault.replace_body("projects/Beta.md", f"revision {i}\n", version)
    assert list(vault.root.rglob("*.tmp")) == []
    assert list(vault.root.rglob(".*.tmp")) == []
