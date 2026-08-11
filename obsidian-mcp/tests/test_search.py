"""BM25 ranking, metadata filtering, error handling, and incremental indexing."""

from __future__ import annotations

import pytest

from obsidian_mcp.vault import SearchError, Vault


def paths(result: dict) -> list[str]:
    return [r["path"] for r in result["results"]]


# -- ranking ----------------------------------------------------------------


def test_multi_word_query_ranks_by_relevance(vault: Vault):
    result = vault.search("overlay networking")
    ranked = paths(result)

    assert "Docker Networking.md" in ranked
    assert "NoFrontmatter.md" in ranked
    scores = [r["score"] for r in result["results"]]
    assert scores == sorted(scores, reverse=True), "results are not ordered by score"
    assert all(score > 0 for score in scores)


def test_documents_matching_both_terms_outrank_documents_matching_one(vault: Vault):
    result = vault.search("overlay networking")
    by_path = {r["path"]: r for r in result["results"]}

    both = by_path["Docker Networking.md"]
    one = by_path["Kubernetes Ingress.md"]
    assert both["matched_terms"] == ["networking", "overlay"]
    assert one["matched_terms"] == ["networking"]
    assert both["score"] > one["score"]


def test_irrelevant_notes_score_zero_by_being_absent(vault: Vault):
    result = vault.search("overlay")
    assert "daily/2024-03-01.md" not in paths(result)
    assert "inbox/Duplicate.md" not in paths(result)

    every_note = {n["path"] for n in vault.list_notes()["notes"]}
    unscored = every_note - set(paths(result))
    assert unscored, "expected some notes to score zero"
    for path in unscored:
        assert "overlay" not in vault.read_note(path)["raw"].lower()


def test_a_term_present_nowhere_returns_no_results(vault: Vault):
    result = vault.search("supercalifragilistic")
    assert result["results"] == []
    assert result["total_matches"] == 0


def test_results_carry_the_required_fields(vault: Vault):
    hit = vault.search("ingress controller")["results"][0]
    assert set(hit) >= {"path", "score", "title", "snippet", "matched_terms"}
    assert hit["path"] == "Kubernetes Ingress.md"
    assert hit["title"] == "Kubernetes Ingress"
    assert "ingress" in hit["snippet"].lower()
    assert hit["matched_terms"] == ["controller", "ingress"]


def test_title_and_alias_text_is_searchable(vault: Vault):
    assert "projects/Alpha.md" in paths(vault.search("alpha"))
    # "A1" only appears as an alias in Alpha's frontmatter.
    assert "projects/Alpha.md" in paths(vault.search("a1"))


def test_limit_is_respected(vault: Vault):
    unlimited = vault.search("the")
    assert len(vault.search("the", limit=2)["results"]) == 2
    assert vault.search("the", limit=2)["total_matches"] == unlimited["total_matches"]


# -- filtering --------------------------------------------------------------


def test_filter_by_folder(vault: Vault):
    assert paths(vault.search("project", folder="projects")) == [
        "projects/Alpha.md",
        "projects/Beta.md",
    ]
    assert paths(vault.search("project", folder="daily")) == []


def test_filter_by_tag(vault: Vault):
    assert set(paths(vault.search("project", tags=["project"]))) == {
        "projects/Alpha.md",
        "projects/Beta.md",
    }
    assert paths(vault.search("project", tags=["journal"])) == []


def test_nested_tags_match_by_prefix(vault: Vault):
    assert "Docker Networking.md" in paths(vault.search("driver", tags=["infra"]))
    assert "Docker Networking.md" in paths(vault.search("driver", tags=["infra/containers"]))
    assert paths(vault.search("driver", tags=["infra/k8s"])) == []


def test_multiple_tags_are_combined_with_and(vault: Vault):
    assert "Docker Networking.md" in paths(
        vault.search("driver", tags=["infra/containers", "reference"])
    )
    assert paths(vault.search("driver", tags=["infra/containers", "journal"])) == []


def test_filter_by_frontmatter_key_value(vault: Vault):
    assert paths(vault.search("project", frontmatter_filter={"status": "active"})) == [
        "projects/Alpha.md"
    ]
    assert paths(vault.search("project", frontmatter_filter={"priority": 2})) == [
        "projects/Beta.md"
    ]
    assert paths(vault.search("project", frontmatter_filter={"status": "nonexistent"})) == []


def test_frontmatter_filter_matches_inside_lists(vault: Vault):
    assert "projects/Alpha.md" in paths(
        vault.search("alpha", frontmatter_filter={"aliases": "Project Alpha"})
    )


def test_frontmatter_filter_handles_booleans_distinctly(vault: Vault):
    assert paths(vault.search("driver", frontmatter_filter={"draft": False})) == [
        "Docker Networking.md"
    ]
    assert paths(vault.search("driver", frontmatter_filter={"draft": True})) == []


def test_filters_combine(vault: Vault):
    assert paths(
        vault.search("project", folder="projects", tags=["project"],
                     frontmatter_filter={"status": "archived"})
    ) == ["projects/Beta.md"]


# -- clean errors -----------------------------------------------------------


@pytest.mark.parametrize("query", ["", "   ", "\n\t"])
def test_empty_query_raises_a_clean_error(vault: Vault, query):
    with pytest.raises(SearchError) as excinfo:
        vault.search(query)
    assert excinfo.value.code == "invalid_query"
    assert "non-empty" in excinfo.value.message


def test_query_with_no_searchable_terms_raises(vault: Vault):
    with pytest.raises(SearchError, match="no searchable terms"):
        vault.search("!!! ??? ---")


@pytest.mark.parametrize("limit", [0, -1])
def test_invalid_limit_raises(vault: Vault, limit):
    with pytest.raises(SearchError, match="positive integer"):
        vault.search("overlay", limit=limit)
    with pytest.raises(SearchError, match="positive integer"):
        vault.list_notes(limit=limit)


def test_searching_an_empty_vault_is_not_an_error(tmp_path):
    empty = Vault(tmp_path)
    assert empty.search("anything") == {
        "query": "anything",
        "total_matches": 0,
        "results": [],
    }


def test_vault_root_must_be_a_directory(tmp_path):
    from obsidian_mcp.vault import VaultError

    with pytest.raises(VaultError, match="not a directory"):
        Vault(tmp_path / "does-not-exist")


# -- list_notes -------------------------------------------------------------


def test_list_notes_returns_metadata_and_versions(vault: Vault):
    listing = vault.list_notes()
    assert listing["total"] == 11
    alpha = next(n for n in listing["notes"] if n["path"] == "projects/Alpha.md")
    assert alpha["title"] == "Alpha"
    assert alpha["tags"] == ["project"]
    assert alpha["aliases"] == ["Project Alpha", "A1"]
    assert alpha["version"] == vault.read_note("projects/Alpha.md")["version"]


def test_list_notes_filters_and_paginates(vault: Vault):
    assert [n["path"] for n in vault.list_notes(folder="projects")["notes"]] == [
        "projects/Alpha.md",
        "projects/Beta.md",
    ]
    page = vault.list_notes(limit=1, offset=1)
    assert page["total"] == 11
    assert len(page["notes"]) == 1
    assert page["notes"][0]["path"] == vault.list_notes()["notes"][1]["path"]


def test_list_notes_reports_malformed_frontmatter(vault: Vault):
    entry = next(
        n for n in vault.list_notes()["notes"] if n["path"] == "Malformed.md"
    )
    assert entry["frontmatter_state"] == "invalid_yaml"


# -- incremental index ------------------------------------------------------


def assert_index_matches_a_full_rebuild(vault: Vault):
    incremental = vault.index_snapshot()
    rebuilt = Vault(vault.root)
    rebuilt.reindex()
    assert incremental == rebuilt.index_snapshot()


def test_index_picks_up_a_created_note(vault: Vault):
    before = vault.refresh()
    (vault.root / "Newborn.md").write_text("---\ntags: [fresh]\n---\nquokka sightings\n")

    stats = vault.refresh()
    assert stats["added"] == 1
    assert stats["notes"] == before["notes"] + 1
    assert "Newborn.md" in [r["path"] for r in vault.search("quokka")["results"]]
    assert_index_matches_a_full_rebuild(vault)


def test_index_picks_up_a_modified_note(vault: Vault):
    assert vault.search("wombat")["results"] == []
    path = vault.root / "projects/Beta.md"
    path.write_text(path.read_text() + "\nwombat census\n")

    stats = vault.refresh()
    assert stats["modified"] == 1 and stats["added"] == 0
    assert [r["path"] for r in vault.search("wombat")["results"]] == ["projects/Beta.md"]
    assert_index_matches_a_full_rebuild(vault)


def test_index_picks_up_a_deleted_note(vault: Vault):
    assert vault.search("dormant")["results"] != []
    (vault.root / "projects/Beta.md").unlink()

    stats = vault.refresh()
    assert stats["removed"] == 1
    assert vault.search("dormant")["results"] == []
    assert "projects/Beta.md" not in [n["path"] for n in vault.list_notes()["notes"]]
    assert_index_matches_a_full_rebuild(vault)


def test_index_picks_up_a_rename(vault: Vault):
    version = vault.read_note("projects/Beta.md")["version"]
    vault.rename_note("projects/Beta.md", "Gamma.md", version)

    listed = [n["path"] for n in vault.list_notes()["notes"]]
    assert "projects/Gamma.md" in listed
    assert "projects/Beta.md" not in listed
    assert [r["path"] for r in vault.search("dormant")["results"]] == ["projects/Gamma.md"]
    assert_index_matches_a_full_rebuild(vault)


def test_unchanged_files_are_not_reparsed(vault: Vault, monkeypatch):
    vault.refresh()
    parsed = []
    real_build = vault._build_entry
    monkeypatch.setattr(
        vault, "_build_entry",
        lambda path, rel, stat: (parsed.append(rel), real_build(path, rel, stat))[1],
    )

    stats = vault.refresh()

    assert parsed == [], "an unchanged file was reparsed"
    assert stats["unchanged"] == stats["notes"]


def test_only_the_changed_file_is_reparsed(vault: Vault, monkeypatch):
    vault.refresh()
    parsed = []
    real_build = vault._build_entry
    monkeypatch.setattr(
        vault, "_build_entry",
        lambda path, rel, stat: (parsed.append(rel), real_build(path, rel, stat))[1],
    )

    path = vault.root / "Kubernetes Ingress.md"
    path.write_text(path.read_text() + "\nnew line\n")
    vault.refresh()

    assert parsed == ["Kubernetes Ingress.md"]


def test_a_same_size_edit_is_still_detected(vault: Vault):
    """mtime must be consulted, not just size."""
    path = vault.root / "projects/Beta.md"
    original = path.read_bytes()
    replacement = original.replace(b"dormant", b"DORMANT")
    assert len(replacement) == len(original)
    path.write_bytes(replacement)

    vault.refresh()
    assert [r["path"] for r in vault.search("DORMANT")["results"]] == ["projects/Beta.md"]


def test_reindex_rebuilds_from_scratch_and_reproduces_the_index(vault: Vault):
    incremental = vault.index_snapshot()
    stats = vault.reindex()

    assert stats["rebuilt"] is True
    assert stats["added"] == stats["notes"] == 11
    assert stats["unchanged"] == 0
    assert vault.index_snapshot() == incremental


def test_reindex_recovers_from_a_corrupted_cache(vault: Vault):
    expected = vault.index_snapshot()
    vault._entries.pop("projects/Alpha.md")
    vault._postings.clear()
    vault._df.clear()

    vault.reindex()
    assert vault.index_snapshot() == expected
