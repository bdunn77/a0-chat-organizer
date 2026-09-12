from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
from typing import Any

from helpers.api import ApiHandler, Input, Output, Request, Response

# Import cascade.py by file path under a unique module name. Never add the
# plugin root to sys.path: doing so would make this plugin's top-level `api`
# directory shadow Agent Zero core's `api` package for every later import in
# the process (breaking e.g. `from api.message import Message` in core).
# This keeps Chat Organizer fully self-contained and update-proof.
_PLUGIN_ROOT = Path(__file__).resolve().parent.parent


def _load_cascade():
    cascade_path = _PLUGIN_ROOT / "cascade.py"
    spec = importlib.util.spec_from_file_location(
        "_chat_organizer_cascade", cascade_path
    )
    if spec is None or spec.loader is None:
        raise ImportError(f"Could not load cascade module from {cascade_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_cascade = _load_cascade()
collect_family_ids = _cascade.collect_family_ids


# ---------------------------------------------------------------------------
# Persistence helpers
# ---------------------------------------------------------------------------
# Folder data used to live at <plugin>/data/tree.json. Plugin Hub updates and
# reinstalls replace that directory, which made user folders disappear. Durable
# state now lives under usr/data/chat_organizer/, with a one-time migration.

_LEGACY_TREE_FILE = _PLUGIN_ROOT / "data" / "tree.json"


def _durable_tree_file() -> Path:
    try:
        from helpers import files as a0_files

        return Path(
            a0_files.get_abs_path(
                a0_files.USER_DIR, "data", "chat_organizer", "tree.json"
            )
        )
    except Exception:
        pass
    for parent in _PLUGIN_ROOT.parents:
        if parent.name == "usr":
            return parent / "data" / "chat_organizer" / "tree.json"
        if parent.name == "plugins" and parent.parent.name == "usr":
            return parent.parent / "data" / "chat_organizer" / "tree.json"
    return _LEGACY_TREE_FILE


def _default_tree() -> dict[str, Any]:
    return {"folders": [], "orphan_order": [], "visible_order": []}


def _normalize_tree(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    raw.setdefault("folders", [])
    raw.setdefault("orphan_order", [])
    raw.setdefault("visible_order", [])
    if not isinstance(raw["folders"], list):
        raw["folders"] = []
    if not isinstance(raw["orphan_order"], list):
        raw["orphan_order"] = []
    if not isinstance(raw["visible_order"], list):
        raw["visible_order"] = []
    return raw


def _tree_has_user_data(tree: dict[str, Any]) -> bool:
    return bool(tree.get("folders") or tree.get("orphan_order") or tree.get("visible_order"))


def _read_tree_file(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        return _normalize_tree(json.loads(path.read_text(encoding="utf-8")))
    except (json.JSONDecodeError, OSError):
        return None


def _write_tree_file(path: Path, tree: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(tree, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def _migrate_legacy_tree(durable: Path, legacy: Path) -> dict[str, Any] | None:
    """Copy plugin-local folder data to the durable path once."""
    legacy_tree = _read_tree_file(legacy)
    if legacy_tree is None or not _tree_has_user_data(legacy_tree):
        return None
    durable_tree = _read_tree_file(durable)
    if durable_tree is not None and _tree_has_user_data(durable_tree):
        return durable_tree
    _write_tree_file(durable, legacy_tree)
    return legacy_tree


def _load_tree() -> dict[str, Any]:
    """Load the folder tree from durable storage, migrating legacy data if needed."""
    durable = _durable_tree_file()
    migrated = _migrate_legacy_tree(durable, _LEGACY_TREE_FILE)
    if migrated is not None:
        return migrated
    loaded = _read_tree_file(durable) or _read_tree_file(_LEGACY_TREE_FILE)
    return loaded if loaded is not None else _default_tree()


def _save_tree(tree: dict[str, Any]) -> None:
    """Persist the tree outside the plugin directory so updates cannot wipe it."""
    _write_tree_file(_durable_tree_file(), tree)


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


def _find_folder_for_chat(folders: list[dict], ctxid: str) -> dict | None:
    for folder in folders:
        if ctxid in folder.get("chat_ids", []):
            return folder
        found = _find_folder_for_chat(folder.get("children", []), ctxid)
        if found:
            return found
    return None


def _live_chat_records() -> dict[str, dict]:
    records: dict[str, dict] = {}
    try:
        from helpers import persist_chat

        chats_dir = Path(persist_chat.get_chat_folder_path("_")).parent
        if chats_dir.is_dir():
            for folder in chats_dir.iterdir():
                chat_file = folder / persist_chat.CHAT_FILE_NAME
                if not folder.is_dir() or not chat_file.is_file():
                    continue
                try:
                    data = json.loads(chat_file.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue
                if isinstance(data, dict):
                    records[folder.name] = data
    except Exception:
        pass
    try:
        from agent import AgentContext

        for context in AgentContext.all():
            records.setdefault(context.id, {
                "id": context.id,
                "output_data": dict(getattr(context, "output_data", None) or {}),
            })
    except Exception:
        pass
    return records


def _family_ids_for_move(ctxid: str, requested: Any = None) -> list[str]:
    ids: list[str] = []
    seen: set[str] = set()

    def add(value: str) -> None:
        cid = str(value or "").strip()
        if cid and cid not in seen:
            seen.add(cid)
            ids.append(cid)

    add(ctxid)
    if isinstance(requested, list):
        for value in requested:
            add(value)
    for value in collect_family_ids(ctxid, _live_chat_records()):
        add(value)
    return ids


def _place_chats(container: list[str], ids: list[str], position: Any) -> None:
    for cid in ids:
        if cid in container:
            container.remove(cid)
    if isinstance(position, int) and 0 <= position <= len(container):
        for offset, cid in enumerate(ids):
            container.insert(position + offset, cid)
    else:
        container.extend(ids)


def _sync_family_membership(tree: dict[str, Any], records: dict[str, dict] | None = None) -> bool:
    """Keep each live parent/child family in one folder, or all unfiled."""
    records = records if records is not None else _live_chat_records()
    if not records:
        return False
    changed = False
    seen: set[str] = set()
    for ctxid in list(records):
        cid = str(ctxid or "").strip()
        if not cid or cid in seen:
            continue
        family = collect_family_ids(cid, records)
        for member in family:
            seen.add(member)
        if len(family) < 2:
            continue
        target = _find_folder_for_chat(tree.get("folders", []), family[0])
        if target is None:
            for member in family[1:]:
                target = _find_folder_for_chat(tree.get("folders", []), member)
                if target is not None:
                    break
        if target is None:
            continue
        chat_ids = target.setdefault("chat_ids", [])
        for member in family:
            current = _find_folder_for_chat(tree.get("folders", []), member)
            if current is target:
                continue
            _remove_chat_from_all_folders(tree.get("folders", []), member)
            if member in tree.get("orphan_order", []):
                tree["orphan_order"].remove(member)
            if member not in chat_ids:
                chat_ids.append(member)
            changed = True
    return changed


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
        tree = _load_tree()
        if _sync_family_membership(tree):
            _save_tree(tree)
        return tree

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
        family = _family_ids_for_move(ctxid, input.get("ctxids"))

        # Remove the whole parent/child family from any existing folder + orphan list.
        for member in family:
            _remove_chat_from_all_folders(tree["folders"], member)
            if member in tree["orphan_order"]:
                tree["orphan_order"].remove(member)

        if folder_id:
            folder = _find_folder(tree["folders"], folder_id)
            if not folder:
                return Response("Folder not found", 404)
            _place_chats(folder.setdefault("chat_ids", []), family, position)
        else:
            # Move the whole family to Unfiled.
            _place_chats(tree["orphan_order"], family, position)

        _save_tree(tree)
        return {"ok": True, "moved": family}

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
        """Persist the unified sidebar order and keep per-container orders coherent.

        The unified visible_order controls the full mixed sidebar order. We also
        project that order back into each folder's chat_ids and orphan_order so
        filtered folder/Unfiled views remain consistent with the same drag order.
        Folder membership is not changed here.
        """
        ctxids = input.get("ctxids")
        if not isinstance(ctxids, list):
            return Response("ctxids must be a list", 400)

        tree = _load_tree()
        visible_order = [str(c) for c in ctxids if c]
        tree["visible_order"] = visible_order
        rank = {ctxid: i for i, ctxid in enumerate(visible_order)}

        def order_key(ctxid: str, fallback_index: int) -> tuple[int, int]:
            # Unknown/new chats keep their relative position after known ordered chats.
            return (rank.get(ctxid, len(rank) + fallback_index), fallback_index)

        def sort_folder(folder: dict) -> None:
            chat_ids = [str(c) for c in folder.get("chat_ids", []) if c]
            folder["chat_ids"] = [
                ctxid for _idx, ctxid in sorted(enumerate(chat_ids), key=lambda item: order_key(item[1], item[0]))
            ]
            for child in folder.get("children", []):
                sort_folder(child)

        assigned_ids: set[str] = set()
        for folder in tree.get("folders", []):
            sort_folder(folder)
            assigned_ids.update(_collect_all_chat_ids(folder))

        # Derive Unfiled order from visible_order for every visible chat that is
        # not assigned to a folder, then append any previously known orphan IDs
        # not present in visible_order. This keeps the Unfiled filtered view
        # coherent even for chats that were never explicitly moved into/out of a
        # folder before the first unified reorder.
        orphan_ids: list[str] = []
        seen_orphans: set[str] = set()
        for ctxid in visible_order:
            if ctxid not in assigned_ids and ctxid not in seen_orphans:
                orphan_ids.append(ctxid)
                seen_orphans.add(ctxid)
        for ctxid in [str(c) for c in tree.get("orphan_order", []) if c]:
            if ctxid not in seen_orphans:
                orphan_ids.append(ctxid)
                seen_orphans.add(ctxid)
        tree["orphan_order"] = orphan_ids
        _sync_family_membership(tree)

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
