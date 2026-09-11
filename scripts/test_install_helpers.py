# scripts/test_install_helpers.py
import os
import pytest
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).parent))
from install_helpers import resolve_hermes_home, resolve_active_profile, skill_target_path

def test_resolve_hermes_home_uses_env(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    assert resolve_hermes_home() == tmp_path

def test_resolve_hermes_home_falls_back_to_default(monkeypatch, tmp_path):
    monkeypatch.delenv("HERMES_HOME", raising=False)
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    assert resolve_hermes_home() == tmp_path / ".hermes"

def test_resolve_active_profile_default(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    assert resolve_active_profile(str(tmp_path)) == "default"

def test_resolve_active_profile_from_config(monkeypatch, tmp_path):
    (tmp_path / "config.yaml").write_text("agent:\n  active_profile: work\n")
    assert resolve_active_profile(str(tmp_path)) == "work"

def test_skill_target_path(tmp_path):
    """Test that skill_target_path returns <HERMES_HOME>/skills/<name>/
    (NOT profiles/<profile>/skills/external/...).
    The profile arg is unused — hermes uses a single global skills dir.
    """
    target = skill_target_path(str(tmp_path), "default", "ssb-coach")
    # PATCHED: skills go to <HERMES_HOME>/skills/<name>/ (not profiles/<profile>/skills/external/)
    assert target == tmp_path / "skills" / "ssb-coach"