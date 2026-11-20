"""Shared data-directory resolution for logs, config, and other runtime state.

The data directory holds the audit log (logs/audit-YYYYMMDD.ndjson) and the optional
safety.json overrides. Directory creation failures propagate to the operation that requested storage.
"""

import os

_APP_NAME = "ai-computer-control"


def data_dir() -> str:
    """Return the writable data directory, creating it if possible.

    WCW_DATA_DIR overrides the Mac user's default directory.
    """
    base = os.environ.get("WCW_DATA_DIR") or os.path.join(os.path.expanduser("~"), "." + _APP_NAME)
    os.makedirs(base, exist_ok=True)
    return base


def logs_dir() -> str:
    """Return (and create) the logs subdirectory under the data directory."""
    d = os.path.join(data_dir(), "logs")
    os.makedirs(d, exist_ok=True)
    return d


def safety_config_path() -> str:
    """Return the path to the optional safety.json overrides file (may not exist)."""
    return os.path.join(data_dir(), "safety.json")
