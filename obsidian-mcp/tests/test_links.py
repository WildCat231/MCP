"""Wikilink parsing, Obsidian-style resolution, backlinks and ambiguity."""

from __future__ import annotations

import pytest

from obsidian_mcp.vault import AmbiguousReferenceError, NoteNotFoundError, Vault, parse_links


# -- parsing ----------------------------------------------------------------


def test_parse_plain_link():
    (link,) = parse_links("see [[Note Name]] here")
    assert (link.target, link.alias, link.heading, link.block, link.embed) == (
        "Note Name", None, None, None, False
    )


def test_parse_piped_link():
    (link,) = parse_links("[[Note Name|display text]]")
    assert link.target == "Note Name"
    assert link.alias == "display text"


def test_parse_heading_link():
    (link,) = parse_links("[[Note Name#Section Two]]")
    assert link.target == "Note Name"
    assert link.heading == "Section Two"


def test_parse_block_reference():
    (link,) = parse_links("[[Note Name#^abc123]]")
    assert link.target == "Note Name"
    assert link.block == "abc123"
    assert link.heading is None


def test_parse_heading_and_alias_together():
    (link,) = parse_links("[[Folder/Note#Heading|shown]]")
    assert (link.target, link.heading, link.alias) == ("Folder/Note", "Heading", "shown")


def test_parse_embed():
    (link,) = parse_links("![[Diagram]]")
    assert link.embed is True and link.target == "Diagram"


def test_parse_same_note_anchor():
    (link,) = parse_links("[[#Section]]")
    assert link.target == "" and link.heading == "Section"


def test_parse_ignores_unclosed_and_single_brackets():
    assert parse_links("[[unclosed and [single] and ]] stray") == []


def test_parse_finds_several_links_on_one_line():
    links = parse_links("[[A]] then [[B|b]] then ![[C#d]]")
    assert [link.target for link in links] == ["A", "B", "C"]


# -- resolution -------------------------------------------------------------


def test_links_report_resolution_status(vault: Vault):
    links = {link["target"]: link for link in vault.get_links("Docker Networking.md")["links"]}

    assert links["Kubernetes Ingress"]["status"] == "resolved"
    assert links["Kubernetes Ingress"]["resolved_path"] == "Kubernetes Ingress.md"
    assert links["projects/Alpha"]["status"] == "resolved"
    assert links["projects/Alpha"]["alias"] == "the Alpha project"
    assert links["Missing Note"]["status"] == "broken"


def test_broken_links_are_reported_not_raised(vault: Vault):
    result = vault.get_links("Docker Networking.md")
    assert result["counts"]["broken"] == 1
    assert result["counts"]["resolved"] == 2


def test_bare_name_resolves_anywhere_in_the_vault_not_by_relative_path(vault: Vault):
    """`[[Docker Networking]]` in projects/Alpha.md points at the vault root note."""
    links = vault.get_links("projects/Alpha.md")["links"]
    (link,) = [link for link in links if link["target"] == "Docker Networking"]
    assert link["status"] == "resolved"
    assert link["resolved_path"] == "Docker Networking.md"
    assert link["heading"] == "overlay"


def test_ambiguous_link_is_reported_with_candidates(vault: Vault):
    links = vault.get_links("daily/2024-03-01.md")["links"]
    (link,) = [link for link in links if link["target"] == "Duplicate"]
    assert link["status"] == "ambiguous"
    assert link["candidates"] == ["archive/Duplicate.md", "inbox/Duplicate.md"]


def test_ambiguous_bare_name_raises_and_lists_candidates(vault: Vault):
    with pytest.raises(AmbiguousReferenceError) as excinfo:
        vault.get_backlinks("Duplicate")

    error = excinfo.value
    assert error.code == "ambiguous_reference"
    assert error.details["candidates"] == ["archive/Duplicate.md", "inbox/Duplicate.md"]
    assert "archive/Duplicate.md" in error.message
    assert "inbox/Duplicate.md" in error.message


def test_a_full_path_disambiguates(vault: Vault):
    assert vault.get_backlinks("inbox/Duplicate.md")["path"] == "inbox/Duplicate.md"
    assert vault.get_links("archive/Duplicate.md")["path"] == "archive/Duplicate.md"


def test_unknown_reference_raises_not_found(vault: Vault):
    with pytest.raises(NoteNotFoundError):
        vault.get_backlinks("Nothing Like This")


def test_resolution_is_case_insensitive(vault: Vault):
    assert vault.resolve_reference("docker networking") == "Docker Networking.md"
    assert vault.resolve_reference("PROJECTS/ALPHA") == "projects/Alpha.md"


# -- backlinks --------------------------------------------------------------


def test_backlinks_resolve_through_paths_aliases_and_pipes(vault: Vault):
    result = vault.get_backlinks("projects/Alpha.md")
    by_source = {b["source"]: b for b in result["backlinks"]}

    assert set(by_source) == {
        "Docker Networking.md",
        "daily/2024-03-01.md",
        "projects/Beta.md",
    }
    # full path, with a pipe
    assert by_source["Docker Networking.md"]["matched_via"] == "path"
    assert by_source["Docker Networking.md"]["alias"] == "the Alpha project"
    # frontmatter alias "A1", with a pipe
    assert by_source["daily/2024-03-01.md"]["matched_via"] == "alias"
    assert by_source["daily/2024-03-01.md"]["alias"] == "the alpha work"
    # frontmatter alias "Project Alpha", bare
    assert by_source["projects/Beta.md"]["matched_via"] == "alias"
    assert by_source["projects/Beta.md"]["alias"] is None


def test_backlinks_match_by_note_name(vault: Vault):
    result = vault.get_backlinks("Kubernetes Ingress.md")
    assert [b["source"] for b in result["backlinks"]] == ["Docker Networking.md"]
    assert result["backlinks"][0]["matched_via"] == "name"


def test_backlinks_survive_a_heading_suffix(vault: Vault):
    result = vault.get_backlinks("Docker Networking.md")
    sources = {b["source"] for b in result["backlinks"]}
    assert "projects/Alpha.md" in sources  # links via [[Docker Networking#overlay]]
    assert next(b for b in result["backlinks"] if b["source"] == "projects/Alpha.md")[
        "heading"
    ] == "overlay"


def test_backlinks_include_context(vault: Vault):
    result = vault.get_backlinks("Kubernetes Ingress.md")
    context = result["backlinks"][0]["context"]
    assert "[[Kubernetes Ingress]] builds on" in context
    assert "The overlay driver spans" in context


def test_a_note_does_not_backlink_to_itself(vault: Vault):
    (vault.root / "SelfRef.md").write_text("I link to [[SelfRef]] and [[#top]].\n")
    vault.refresh()
    assert vault.get_backlinks("SelfRef.md")["backlinks"] == []


def test_backlinks_flag_ambiguous_sources(vault: Vault):
    result = vault.get_backlinks("inbox/Duplicate.md")
    (link,) = result["backlinks"]
    assert link["source"] == "daily/2024-03-01.md"
    assert link["ambiguous"] is True
    assert link["candidates"] == ["archive/Duplicate.md", "inbox/Duplicate.md"]


def test_notes_with_no_backlinks_return_an_empty_list(vault: Vault):
    result = vault.get_backlinks("Empty.md")
    assert result == {"path": "Empty.md", "count": 0, "backlinks": []}


def test_embeds_count_as_backlinks(vault: Vault):
    (vault.root / "Embedder.md").write_text("![[Kubernetes Ingress]]\n")
    vault.refresh()
    result = vault.get_backlinks("Kubernetes Ingress.md")
    embed = next(b for b in result["backlinks"] if b["source"] == "Embedder.md")
    assert embed["embed"] is True


def test_link_graph_is_derived_from_files_not_a_side_database(vault: Vault):
    """Editing a file on disk changes the graph on the next read, with no rebuild."""
    assert vault.get_backlinks("Kubernetes Ingress.md")["count"] == 1

    (vault.root / "Latecomer.md").write_text("points at [[Kubernetes Ingress]]\n")
    assert vault.get_backlinks("Kubernetes Ingress.md")["count"] == 2

    (vault.root / "Latecomer.md").unlink()
    assert vault.get_backlinks("Kubernetes Ingress.md")["count"] == 1


def test_frontmatter_links_are_not_treated_as_body_links(vault: Vault):
    (vault.root / "FmLink.md").write_text('---\nsee: "[[Kubernetes Ingress]]"\n---\nno links\n')
    vault.refresh()
    assert vault.get_links("FmLink.md")["links"] == []
