"""Privacy guard shared by every PhotoSort command.

Standing rule: photos, screenshots and anything derived from them (image bytes, captions, visible text,
faces) go only to the NVIDIA PAIR proxy on this PC, and only to models running on the user's own machines.
"""
from __future__ import annotations

import ipaddress
import os
from pathlib import Path
from typing import Iterable
from urllib.parse import urlparse


class LocalOnlyError(RuntimeError):
    pass


def under_onedrive(path: Path) -> bool:
    """True when `path` is inside a OneDrive folder, whose contents OneDrive uploads to the cloud."""
    roots = [Path.home() / "OneDrive"]
    roots += [Path(os.environ[k]) for k in ("OneDrive", "OneDriveConsumer", "OneDriveCommercial") if os.environ.get(k)]
    return any(Path(path).resolve().is_relative_to(r.resolve()) for r in roots)


def require_loopback(url: str) -> None:
    """Refuse any endpoint that is not on this machine, so photos cannot leave via a misconfiguration."""
    host = urlparse(url).hostname or ""
    if host == "localhost":
        return
    try:
        if ipaddress.ip_address(host).is_loopback:
            return
    except ValueError:
        pass
    raise LocalOnlyError(f"Refusing non-loopback endpoint {url!r}; PhotoSort only talks to the local PAIR proxy.")


def is_cloud_model(name: str) -> bool:
    """Ollama cloud models (e.g. `gpt-oss:120b-cloud`, `glm-4.6:cloud`) run on ollama.com, not on a LAN node."""
    tag = name.strip().lower().rpartition(":")[2]
    return tag == "cloud" or tag.endswith("-cloud")


def require_local_models(names: Iterable[str], available: list[dict] | None = None) -> None:
    """Refuse cloud-hosted models by name and, given the /api/tags listing, by its remote-model fields."""
    entries = {m.get("name"): m for m in available or []}
    for name in names:
        entry = entries.get(name) or {}
        if is_cloud_model(name) or entry.get("remote_host") or entry.get("remote_model"):
            raise LocalOnlyError(f"Refusing model {name!r}: it runs in the cloud. Photos and anything derived "
                                 "from them may only go to models on your own machines.")
