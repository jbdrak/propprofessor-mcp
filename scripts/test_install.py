"""End-to-end test for install.py. Uses a temporary HERMES_HOME to avoid
touching the user's real config."""
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
INSTALL = REPO_ROOT / "scripts" / "install.py"


@pytest.fixture
def fake_hermes_home(tmp_path, monkeypatch):
    """Create a minimal hermes home with config.yaml and bin/hermes stub."""
    home = tmp_path / "fake_hermes"
    home.mkdir(parents=True, exist_ok=True)
    (home / "config.yaml").write_text("agent:\n  active_profile: default\n")
    (home / "skills" / "external").mkdir(parents=True)
    bin_dir = home / "bin"
    bin_dir.mkdir()
    hermes_stub = bin_dir / "hermes"
    hermes_stub.write_text("#!/bin/sh\necho \"fake hermes $*\"\nexit 0\n")
    hermes_stub.chmod(0o755)
    monkeypatch.setenv("HERMES_HOME", str(home))
    # Prepend fake hermes to PATH so install_helpers.hermes_bin() finds it first.
    monkeypatch.setenv("PATH", f"{bin_dir}:{os.environ.get('PATH', '')}")
    return home


def test_install_skill_creates_symlink(fake_hermes_home):
    result = subprocess.run(
        [sys.executable, str(INSTALL), "skill"],
        capture_output=True, text=True,
        env={**os.environ, "HERMES_HOME": str(fake_hermes_home), "PATH": f"{fake_hermes_home / 'bin'}:{os.environ.get('PATH', '')}"}
    )
    assert result.returncode == 0, result.stderr
    target = fake_hermes_home / "skills" / "ssb-coach"
    assert target.is_symlink()
    assert target.resolve() == (REPO_ROOT / "skills" / "ssb-coach").resolve()


def test_install_skill_idempotent(fake_hermes_home):
    """Running twice doesn't error and doesn't create a nested symlink."""
    subprocess.run(
        [sys.executable, str(INSTALL), "skill"],
        capture_output=True, text=True,
        env={**os.environ, "HERMES_HOME": str(fake_hermes_home), "PATH": f"{fake_hermes_home / 'bin'}:{os.environ.get('PATH', '')}"},
        check=True
    )
    result = subprocess.run(
        [sys.executable, str(INSTALL), "skill"],
        capture_output=True, text=True,
        env={**os.environ, "HERMES_HOME": str(fake_hermes_home), "PATH": f"{fake_hermes_home / 'bin'}:{os.environ.get('PATH', '')}"}
    )
    assert result.returncode == 0, result.stderr
    target = fake_hermes_home / "skills" / "ssb-coach"
    assert target.is_symlink()
    # Resolve once — should still be the source, not a nested link.
    assert target.resolve() == (REPO_ROOT / "skills" / "ssb-coach").resolve()


def test_install_mcp_calls_hermes(fake_hermes_home, capsys):
    """Test that install_mcp runs without error and produces expected output."""
    # Create a fake hermes at the expected venv location to intercept the call.
    venv_hermes = fake_hermes_home / "hermes-agent" / "venv" / "bin" / "hermes"
    venv_hermes.parent.mkdir(parents=True, exist_ok=True)
    venv_hermes.write_text("#!/bin/sh\necho \"fake hermes $*\"\nexit 0\n")
    venv_hermes.chmod(0o755)
    
    result = subprocess.run(
        [sys.executable, str(INSTALL), "mcp"],
        capture_output=True, text=True,
        env={**os.environ, "HERMES_HOME": str(fake_hermes_home)}
    )
    assert result.returncode == 0, result.stderr
    captured = capsys.readouterr()
    # The fake hermes stub echoes its args; verify it was called with mcp add ssb.
    assert "fake hermes mcp add ssb" in (result.stdout + result.stderr + captured.out)


def test_install_mcp_creates_config(fake_hermes_home, monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))  # redirect ~/.ssb-for-agents
    subprocess.run([sys.executable, str(INSTALL), "mcp"], check=True,
                   env={**os.environ, "HERMES_HOME": str(fake_hermes_home)})
    assert (tmp_path / ".ssb-for-agents" / "config.json").exists()


def test_install_mcp_passes_auth_file_env(fake_hermes_home, monkeypatch, tmp_path):
    """When AUTH_FILE is set in the env, install.py must pass it through to hermes
    rather than overriding with the default path. Regression test for the v2.1.1
    install.py update — previously AUTH_FILE was always hardcoded to the default,
    silently overriding users with custom auth paths (e.g. multi-project setups)."""
    monkeypatch.setenv("HOME", str(tmp_path))
    # Use a custom AUTH_FILE path the user might set for a multi-project setup.
    custom_auth = tmp_path / "shared-secrets" / "my-ssb-auth.json"
    custom_auth.parent.mkdir(parents=True)

    # Replace the fake hermes stub with one that records its env to a log file.
    # The venv-path hermes stub (from fake_hermes_home fixture) gets used by
    # install_helpers.hermes_bin() — that's the one we need to instrument.
    venv_hermes = fake_hermes_home / "hermes-agent" / "venv" / "bin" / "hermes"
    venv_hermes.parent.mkdir(parents=True, exist_ok=True)
    log_file = tmp_path / "hermes-env.log"
    venv_hermes.write_text(
        f"#!/bin/sh\nenv > {log_file}\nexit 0\n"
    )
    venv_hermes.chmod(0o755)

    result = subprocess.run(
        [sys.executable, str(INSTALL), "mcp"],
        capture_output=True, text=True,
        env={
            **os.environ,
            "HERMES_HOME": str(fake_hermes_home),
            "AUTH_FILE": str(custom_auth),
        }
    )
    assert result.returncode == 0, result.stderr
    # The fake hermes writes its env to log_file on every invocation. Verify
    # the env that hermes actually saw contained the custom AUTH_FILE.
    assert log_file.exists(), "fake hermes did not run"
    hermes_env = log_file.read_text()
    assert f"AUTH_FILE={custom_auth}" in hermes_env, (
        f"install.py did not pass through AUTH_FILE env var to hermes. "
        f"Expected AUTH_FILE={custom_auth} in env, got:\n{hermes_env}"
    )


def test_uninstall_removes_skill_link(fake_hermes_home):
    subprocess.run([sys.executable, str(INSTALL), "skill"], check=True,
                   env={**os.environ, "HERMES_HOME": str(fake_hermes_home)})
    target = fake_hermes_home / "skills" / "ssb-coach"
    assert target.is_symlink()
    subprocess.run([sys.executable, str(INSTALL), "uninstall"], check=True,
                   env={**os.environ, "HERMES_HOME": str(fake_hermes_home)})
    assert not target.exists()


def test_uninstall_is_idempotent(fake_hermes_home):
    """Running uninstall twice doesn't error."""
    result = subprocess.run(
        [sys.executable, str(INSTALL), "uninstall"],
        capture_output=True, text=True,
        env={**os.environ, "HERMES_HOME": str(fake_hermes_home)}
    )
    assert result.returncode == 0, result.stderr
    result2 = subprocess.run(
        [sys.executable, str(INSTALL), "uninstall"],
        capture_output=True, text=True,
        env={**os.environ, "HERMES_HOME": str(fake_hermes_home)}
    )
    assert result2.returncode == 0