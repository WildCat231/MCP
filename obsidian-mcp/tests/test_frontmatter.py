"""Frontmatter integrity: assertions are on raw bytes, not on parsed values."""

from __future__ import annotations

import pytest

from obsidian_mcp import frontmatter as fm
from obsidian_mcp.vault import FrontmatterError, Vault

COMPLEX = "Docker Networking.md"


def raw(vault: Vault, rel: str) -> bytes:
    return (vault.root / rel).read_bytes()


def fm_bytes(vault: Vault, rel: str) -> bytes:
    return fm.split(raw(vault, rel)).block


def body_bytes(vault: Vault, rel: str) -> bytes:
    return fm.split(raw(vault, rel)).body


def test_fixture_covers_every_awkward_yaml_type(vault: Vault):
    """Guard the guard: the byte-identity tests are only meaningful on rich input."""
    data = vault.read_note(COMPLEX)["frontmatter"]
    assert isinstance(data["nested"], dict)  # nested object
    assert isinstance(data["nested"]["deps"], list)  # nested array
    assert isinstance(data["tags"], list)  # block sequence
    assert isinstance(data["aliases"], list)  # flow sequence
    assert data["created"] == "2024-01-05"  # date
    assert data["updated"] == "2024-01-06T09:30:00"  # datetime
    assert data["draft"] is False and data["pinned"] is True  # booleans
    assert data["reviewer"] is None  # null
    assert data["score"] == 4.5  # float
    assert b'title: "Docker Networking"' in fm_bytes(vault, COMPLEX)  # quoted string
    assert b"# how the driver stack fits together" in fm_bytes(vault, COMPLEX)  # comment


def test_replace_body_leaves_frontmatter_byte_identical(vault: Vault):
    before = fm_bytes(vault, COMPLEX)
    version = vault.read_note(COMPLEX)["version"]

    vault.replace_body(COMPLEX, "Totally new body.\n\nWith [[Kubernetes Ingress]].\n", version)

    after = fm_bytes(vault, COMPLEX)
    assert after == before, "frontmatter block changed during a body-only edit"
    assert body_bytes(vault, COMPLEX) == b"Totally new body.\n\nWith [[Kubernetes Ingress]].\n"


def test_replace_body_is_byte_exact_and_repeatable(vault: Vault):
    """Ten body rewrites must not drift the frontmatter by a single byte."""
    before = fm_bytes(vault, COMPLEX)
    for i in range(10):
        version = vault.read_note(COMPLEX)["version"]
        vault.replace_body(COMPLEX, f"body revision {i}\n", version)
    assert fm_bytes(vault, COMPLEX) == before


def test_update_frontmatter_changes_one_key_only(vault: Vault):
    before = fm_bytes(vault, COMPLEX).decode()
    version = vault.read_note(COMPLEX)["version"]

    vault.update_frontmatter(COMPLEX, {"status": "archived"}, version)

    after = fm_bytes(vault, COMPLEX).decode()
    before_lines = before.splitlines(keepends=True)
    after_lines = after.splitlines(keepends=True)
    assert len(before_lines) == len(after_lines)

    differing = [
        (b, a) for b, a in zip(before_lines, after_lines) if b != a
    ]
    assert differing == [("status: published\n", "status: archived\n")], differing


def test_update_frontmatter_preserves_quoting_order_and_comments(vault: Vault):
    version = vault.read_note(COMPLEX)["version"]
    vault.update_frontmatter(COMPLEX, {"score": 9.0}, version)
    text = fm_bytes(vault, COMPLEX).decode()

    assert 'title: "Docker Networking"' in text  # double quotes kept
    assert 'aliases: [Docker Nets, "container networking"]' in text  # flow seq kept
    assert "tags:\n  - infra/containers\n  - reference\n" in text  # block seq indent kept
    assert "reviewer: null\n" in text  # null spelling kept
    assert "# how the driver stack fits together" in text  # comment kept
    assert "created: 2024-01-05\n" in text  # date not requoted

    keys = [line.split(":")[0] for line in text.splitlines() if line and line[0].isalpha()]
    assert keys == [
        "title", "tags", "aliases", "created", "updated", "status",
        "draft", "pinned", "score", "reviewer", "nested",
    ]


def test_update_frontmatter_leaves_body_byte_identical(vault: Vault):
    before = body_bytes(vault, COMPLEX)
    version = vault.read_note(COMPLEX)["version"]

    result = vault.update_frontmatter(COMPLEX, {"status": "archived"}, version)

    assert result["body_unchanged"] is True
    assert body_bytes(vault, COMPLEX) == before


def test_update_frontmatter_can_delete_a_key(vault: Vault):
    version = vault.read_note(COMPLEX)["version"]
    body_before = body_bytes(vault, COMPLEX)

    vault.update_frontmatter(COMPLEX, None, version, delete_keys=["reviewer"])

    text = fm_bytes(vault, COMPLEX).decode()
    assert "reviewer" not in text
    assert 'title: "Docker Networking"' in text
    assert body_bytes(vault, COMPLEX) == body_before


def test_update_frontmatter_rejects_unknown_delete_key(vault: Vault):
    version = vault.read_note(COMPLEX)["version"]
    before = raw(vault, COMPLEX)
    with pytest.raises(FrontmatterError, match="no frontmatter key"):
        vault.update_frontmatter(COMPLEX, None, version, delete_keys=["nope"])
    assert raw(vault, COMPLEX) == before


def test_update_frontmatter_writes_nested_structures(vault: Vault):
    version = vault.read_note(COMPLEX)["version"]
    vault.update_frontmatter(
        COMPLEX, {"nested": {"owner": "bob", "deps": ["macvlan"]}}, version
    )
    data = vault.read_note(COMPLEX)["frontmatter"]
    assert data["nested"] == {"owner": "bob", "deps": ["macvlan"]}
    assert 'title: "Docker Networking"' in fm_bytes(vault, COMPLEX).decode()


# -- malformed input --------------------------------------------------------


def test_malformed_yaml_reads_without_crashing(vault: Vault):
    note = vault.read_note("Malformed.md")
    assert note["frontmatter"] is None
    assert note["frontmatter_state"] == "invalid_yaml"
    assert "invalid YAML" in note["frontmatter_error"]
    assert note["body"].startswith("This note has frontmatter")


def test_malformed_yaml_is_not_silently_fixed_on_write(vault: Vault):
    before = raw(vault, "Malformed.md")
    version = vault.read_note("Malformed.md")["version"]

    with pytest.raises(FrontmatterError, match="cannot be parsed"):
        vault.update_frontmatter("Malformed.md", {"title": "Fixed"}, version)

    assert raw(vault, "Malformed.md") == before


def test_body_edit_on_malformed_note_preserves_the_broken_block(vault: Vault):
    before = fm_bytes(vault, "Malformed.md")
    version = vault.read_note("Malformed.md")["version"]
    vault.replace_body("Malformed.md", "new body\n", version)
    assert fm_bytes(vault, "Malformed.md") == before


def test_unterminated_frontmatter_is_reported_not_guessed(vault: Vault):
    path = vault.root / "Unterminated.md"
    path.write_bytes(b"---\ntitle: Nope\nstill going\nand going\n")
    vault.refresh()

    note = vault.read_note("Unterminated.md")
    assert note["frontmatter_state"] == "unterminated"
    assert note["frontmatter_raw"] == ""
    assert note["body"].startswith("---\ntitle: Nope")

    with pytest.raises(FrontmatterError, match="never closed"):
        vault.update_frontmatter("Unterminated.md", {"title": "x"}, note["version"])
    assert path.read_bytes() == b"---\ntitle: Nope\nstill going\nand going\n"


def test_refuses_to_rewrite_a_block_the_emitter_would_reformat(vault: Vault):
    """`True` is not round-trippable; we refuse rather than normalise it."""
    path = vault.root / "Capitalised.md"
    path.write_bytes(b"---\nenabled: True\nother: 1\n---\nbody\n")
    vault.refresh()
    version = vault.read_note("Capitalised.md")["version"]

    with pytest.raises(FrontmatterError, match="would reformat"):
        vault.update_frontmatter("Capitalised.md", {"other": 2}, version)

    assert path.read_bytes() == b"---\nenabled: True\nother: 1\n---\nbody\n"


def test_note_with_no_frontmatter_gains_a_block(vault: Vault):
    before_body = raw(vault, "NoFrontmatter.md")
    version = vault.read_note("NoFrontmatter.md")["version"]

    vault.update_frontmatter("NoFrontmatter.md", {"title": "Added", "tags": ["new"]}, version)

    content = raw(vault, "NoFrontmatter.md")
    assert content.startswith(b"---\n")
    assert content.endswith(before_body)
    assert vault.read_note("NoFrontmatter.md")["frontmatter"] == {
        "title": "Added",
        "tags": ["new"],
    }


def test_cannot_delete_keys_from_a_note_without_frontmatter(vault: Vault):
    before = raw(vault, "NoFrontmatter.md")
    version = vault.read_note("NoFrontmatter.md")["version"]
    with pytest.raises(FrontmatterError, match="has no frontmatter"):
        vault.update_frontmatter("NoFrontmatter.md", None, version, delete_keys=["title"])
    assert raw(vault, "NoFrontmatter.md") == before


def test_note_that_is_only_frontmatter(vault: Vault):
    note = vault.read_note("OnlyFrontmatter.md")
    assert note["body"] == ""
    assert note["frontmatter"]["title"] == "Only Frontmatter"

    before_fm = fm_bytes(vault, "OnlyFrontmatter.md")
    vault.replace_body("OnlyFrontmatter.md", "now it has a body\n", note["version"])
    assert fm_bytes(vault, "OnlyFrontmatter.md") == before_fm
    assert body_bytes(vault, "OnlyFrontmatter.md") == b"now it has a body\n"


def test_empty_file(vault: Vault):
    note = vault.read_note("Empty.md")
    assert note["body"] == ""
    assert note["frontmatter"] is None
    assert note["frontmatter_state"] == "absent"

    vault.update_frontmatter("Empty.md", {"title": "No Longer Empty"}, note["version"])
    assert raw(vault, "Empty.md") == b"---\ntitle: No Longer Empty\n---\n"


def test_frontmatter_that_is_not_a_mapping(vault: Vault):
    path = vault.root / "ListFm.md"
    path.write_bytes(b"---\n- one\n- two\n---\nbody\n")
    vault.refresh()
    note = vault.read_note("ListFm.md")
    assert note["frontmatter"] is None
    assert note["frontmatter_state"] == "not_mapping"
    with pytest.raises(FrontmatterError):
        vault.update_frontmatter("ListFm.md", {"a": 1}, note["version"])
    assert path.read_bytes() == b"---\n- one\n- two\n---\nbody\n"


# -- the splitter itself ----------------------------------------------------


@pytest.mark.parametrize(
    "content,state,block,body",
    [
        (b"", "absent", b"", b""),
        (b"hello\n", "absent", b"", b"hello\n"),
        (b"---\na: 1\n---\n", "present", b"---\na: 1\n---\n", b""),
        (b"---\na: 1\n---\nbody\n", "present", b"---\na: 1\n---\n", b"body\n"),
        (b"---\na: 1\n---", "present", b"---\na: 1\n---", b""),
        (b"---\r\na: 1\r\n---\r\nx\r\n", "present", b"---\r\na: 1\r\n---\r\n", b"x\r\n"),
        (b"---\na: 1\n...\nbody\n", "present", b"---\na: 1\n...\n", b"body\n"),
        (b"---\nno close\n", "unterminated", b"", b"---\nno close\n"),
        (b"----\na\n", "absent", b"", b"----\na\n"),
        (b"---\n---\nbody\n", "present", b"---\n---\n", b"body\n"),
    ],
)
def test_split_is_lossless(content, state, block, body):
    sp = fm.split(content)
    assert sp.state == state
    assert sp.block == block
    assert sp.body == body
    assert sp.block + sp.body == content
    assert sp.open_line + sp.inner + sp.close_line == sp.block
