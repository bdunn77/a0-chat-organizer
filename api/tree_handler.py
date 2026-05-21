from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from helpers.api import ApiHandler, Input, Output, Request, Response


# ---------------------------------------------------------------------------
# Persistence helpers
# ---------------------------------------------------------------------------

_TREE_FILE = Path(__file__).resolve().parent.parent / "data" / "tree.json"


def _load_tree() -> dict[str, Any]:
    """Load the folder tree from the JSON data file, ensuring a valid shape."""
    if not _TREE_FILE.exists():
        return _default_tree()
    try:
        raw = json.loads(_TREE_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return _default_tree()
    if not isinstance(raw, dict):
        return _default_tree()
    raw.setdefault("folders", [])
    raw.setdefault("orphan_order", [])
    raw.setdefault("visible_order", [])
    return raw


def _save_tree(tree: dict[str, Any]) -> None:
    """Persist the tree to disk atomically."""
    _TREE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = _TREE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(tree, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, _TREE_FILE)


def _default_tree() -> dict[str, Any]:
    return {"folders": [], "orphan_order": [], "visible_order": []}


# ---------------------------------------------------------------------------
# Recursive folder helpers
# ---------------------------------------------------------------------------

def _find_folder(folders: list[dict], folder_id: str) -> dict | None:
    """Search for a folder by id recursively."""
    for f in folders:
        if f["id"] == folder_id:
            return f
        child = _find_folder(f.get("children", []), folder_id)
        if child is not None:
            return child
    return None


def _remove_folder_from_list(folders: list[dict], folder_id: str) -> bool:
    """Remove a folder from a list; returns True if found and removed."""
    for i, f in enumerate(folders):
        if f["id"] == folder_id:
            folders.pop(i)
            return True
        if _remove_folder_from_list(f.get("children", []), folder_id):
            return True
    return False


def _remove_chat_from_all_folders(folders: list[dict], ctxid: str) -> None:
    """Sweep the chat out of every folder (it's moved or assigned elsewhere)."""
    for f in folders:
        if ctxid in f.get("chat_ids", []):
            f["chat_ids"].remove(ctxid)
        _remove_chat_from_all_folders(f.get("children", []), ctxid)


# ---------------------------------------------------------------------------
# Handler
# ---------------------------------------------------------------------------

class TreeHandler(ApiHandler):
    async def process(self, input: Input, request: Request) -> Output:
        action = str(input.get("action", "")).strip().lower()

        if action == "get_tree":
            return self._get_tree()
        if action == "create_folder":
            return self._create_folder(input)
        if action == "rename_folder":
            return self._rename_folder(input)
        if action == "delete_folder":
            return self._delete_folder(input)
        if action == "move_chat":
            return self._move_chat(input)
        if action == "reorder":
            return self._reorder(input)
        if action == "set_orphan_order":
            return self._set_orphan_order(input)
        if action == "set_visible_order":
            return self._set_visible_order(input)

        return Response("Unknown action", 400)

    # ------------------------------------------------------------------

    def _get_tree(self) -> Output:
        return _load_tree()

    # ------------------------------------------------------------------

    def _create_folder(self, input: Input) -> Output:
        name = str(input.get("name", "")).strip()
        if not name:
            return Response("Folder name is required", 400)

        raw_pid = input.get("parent_id")
        parent_id = str(raw_pid).strip() if raw_pid is not None else None
        if parent_id == "":
            parent_id = None
        tree = _load_tree()

        new_folder: dict[str, Any] = {
            "id": _new_id(tree),
            "name": name,
            "chat_ids": [],
            "children": [],
        }

        if parent_id:
            parent = _find_folder(tree["folders"], parent_id)
            if not parent:
                return Response("Parent folder not found", 404)
            parent.setdefault("children", []).append(new_folder)
        else:
            tree["folders"].append(new_folder)

        _save_tree(tree)
        return {"ok": True, "folder": new_folder}

    # ------------------------------------------------------------------

    def _rename_folder(self, input: Input) -> Output:
        folder_id = str(input.get("folder_id", "")).strip()
        name = str(input.get("name", "")).strip()
        if not folder_id or not name:
            return Response("folder_id and name are required", 400)

        tree = _load_tree()
        folder = _find_folder(tree["folders"], folder_id)
        if not folder:
            return Response("Folder not found", 404)

        folder["name"] = name
        _save_tree(tree)
        return {"ok": True}

    # ------------------------------------------------------------------

    def _delete_folder(self, input: Input) -> Output:
        folder_id = str(input.get("folder_id", "")).strip()
        if not folder_id:
            return Response("folder_id is required", 400)

        tree = _load_tree()
        folder = _find_folder(tree["folders"], folder_id)
        if not folder:
            return Response("Folder not found", 404)

        # Move chats from this folder (and all descendants) to orphan_order
        orphaned = _collect_all_chat_ids(folder)
        for ctxid in orphaned:
            if ctxid not in tree["orphan_order"]:
                tree["orphan_order"].append(ctxid)

        _remove_folder_from_list(tree["folders"], folder_id)
        _save_tree(tree)
        return {"ok": True, "orphaned": orphaned}

    # ------------------------------------------------------------------

    def _move_chat(self, input: Input) -> Output:
        ctxid = str(input.get("ctxid", "")).strip()
        folder_id = str(input.get("folder_id", "")).strip()
        position = input.get("position")  # int index or None to append

        if not ctxid:
            return Response("ctxid is required", 400)

        tree = _load_tree()

        # Remove from any existing folder + orphan list
        _remove_chat_from_all_folders(tree["folders"], ctxid)
        if ctxid in tree["orphan_order"]:
            tree["orphan_order"].remove(ctxid)

        if folder_id:
            folder = _find_folder(tree["folders"], folder_id)
            if not folder:
                return Response("Folder not found", 404)
            chat_ids = folder.setdefault("chat_ids", [])
            if isinstance(position, int) and 0 <= position < len(chat_ids):
                chat_ids.insert(position, ctxid)
            else:
                chat_ids.append(ctxid)
        else:
            # Move to orphans (no folder)
            if isinstance(position, int) and 0 <= position < len(tree["orphan_order"]):
                tree["orphan_order"].insert(position, ctxid)
            else:
                tree["orphan_order"].append(ctxid)

        _save_tree(tree)
        return {"ok": True}

    # ------------------------------------------------------------------

    def _reorder(self, input: Input) -> Output:
        """Reorder children inside a folder or the root orphan list."""
        folder_id = str(input.get("folder_id", "")).strip() or None
        ctxids = input.get("ctxids")
        if not isinstance(ctxids, list):
            return Response("ctxids must be a list", 400)

        tree = _load_tree()

        if folder_id:
            folder = _find_folder(tree["folders"], folder_id)
            if not folder:
                return Response("Folder not found", 404)
            folder["chat_ids"] = ctxids
        else:
            tree["orphan_order"] = ctxids

        _save_tree(tree)
        return {"ok": True}

    # ------------------------------------------------------------------

    def _set_orphan_order(self, input: Input) -> Output:
        ctxids = input.get("ctxids")
        if not isinstance(ctxids, list):
            return Response("ctxids must be a list", 400)

        tree = _load_tree()
        tree["orphan_order"] = ctxids
        _save_tree(tree)
        return {"ok": True}


    def _set_visible_order(self, input: Input) -> Output:
        """Persist the unified sidebar order (all chats, mixed folder + unfiled)."""
        ctxids = input.get("ctxids")
        if not isinstance(ctxids, list):
            return Response("ctxids must be a list", 400)

        tree = _load_tree()
        tree["visible_order"] = [str(c) for c in ctxids if c]
        _save_tree(tree)
        return {"ok": True}


# ---------------------------------------------------------------------------
# Utility helpers
# ---------------------------------------------------------------------------

import uuid

def _new_id(tree: dict[str, Any]) -> str:
    """Generate a short unique id."""
    return uuid.uuid4().hex[:12]


def _collect_all_chat_ids(folder: dict) -> list[str]:
    """Collect chat IDs from a folder and all its descendants."""
    ids = list(folder.get("chat_ids", []))
    for child in folder.get("children", []):
        ids.extend(_collect_all_chat_ids(child))
    return ids
