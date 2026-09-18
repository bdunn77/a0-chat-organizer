#!/usr/bin/env python3
"""Boot the real Chat Organizer backend and drive every handler end to end.

Unlike the contract checks, this test loads the actual api/tree_handler.py
module and exercises its handlers against a temporary durable data directory.
Agent Zero runtime dependencies (flask, helpers.*) are replaced with tiny stubs
so the test runs on plain Python, while the plugin's own logic stays real.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def build_stubs(base_root: Path) -> None:
    """Install minimal Agent Zero stand-ins so the real handler can import."""
    helpers = types.ModuleType("helpers")

    files = types.ModuleType("helpers.files")
    files.USER_DIR = "usr"

    def get_abs_path(*parts: str) -> str:
        # Mirror Agent Zero: paths resolve against the install base, so the
        # USER_DIR prefix ("usr") becomes <base>/usr rather than <base>/usr/usr.
        return str(base_root.joinpath(*[str(part) for part in parts]))

    files.get_abs_path = get_abs_path
    helpers.files = files

    api = types.ModuleType("helpers.api")

    class Response:
        def __init__(self, body: object = "", status: int = 200) -> None:
            self.body = body
            self.status = status

    class ApiHandler:
        def __init__(self, app: object = None, thread_lock: object = None) -> None:
            self.app = app
            self.thread_lock = thread_lock

    api.ApiHandler = ApiHandler
    api.Response = Response
    api.Input = dict
    api.Output = dict
    api.Request = object
    helpers.api = api

    sys.modules["helpers"] = helpers
    sys.modules["helpers.files"] = files
    sys.modules["helpers.api"] = api


def load_handler():
    spec = importlib.util.spec_from_file_location(
        "chat_organizer_boot_smoke", ROOT / "api" / "tree_handler.py"
    )
    if spec is None or spec.loader is None:
        raise AssertionError("could not load api/tree_handler.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)
    print(f"PASS: {message}")


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        base_root = Path(tmp)
        usr_root = base_root / "usr"
        usr_root.mkdir(parents=True)
        build_stubs(base_root)

        module = load_handler()
        handler = module.TreeHandler(app=None, thread_lock=None)

        def run(payload: dict):
            return asyncio.run(handler.process(payload, None))

        tree = run({"action": "get_tree"})
        require(
            tree == {"folders": [], "orphan_order": [], "visible_order": []},
            "fresh boot returns an empty tree",
        )

        root = run({"action": "create_folder", "name": "Projects"})
        require(root.get("ok") and root["folder"]["name"] == "Projects", "top-level folder is created")
        require(root["folder"]["id"] and root["folder"]["chat_ids"] == [] and root["folder"]["children"] == [], "new folder has a stable shape")
        root_id = root["folder"]["id"]

        child = run({"action": "create_folder", "name": "Client A", "parent_id": root_id})
        require(child.get("ok"), "subfolder is created under its parent")
        child_id = child["folder"]["id"]

        missing_parent = run({"action": "create_folder", "name": "x", "parent_id": "does-not-exist"})
        require(getattr(missing_parent, "status", None) == 404, "creating inside a missing parent is rejected")

        renamed = run({"action": "rename_folder", "folder_id": child_id, "name": "Client B"})
        require(renamed.get("ok"), "folder rename succeeds")

        moved = run({"action": "move_chat", "ctxid": "chat-1", "folder_id": child_id})
        require(moved.get("ok") and moved["moved"] == ["chat-1"], "chat moves into a folder")

        reordered = run({"action": "reorder", "folder_id": child_id, "ctxids": ["chat-1"]})
        require(reordered.get("ok"), "folder reorder succeeds")

        visible = run({"action": "set_visible_order", "ctxids": ["chat-1", "chat-2"]})
        require(visible.get("ok"), "unified visible order is persisted")

        orphan = run({"action": "set_orphan_order", "ctxids": ["chat-2"]})
        require(orphan.get("ok"), "unfiled order is persisted")

        unknown = run({"action": "definitely-not-an-action"})
        require(getattr(unknown, "status", None) == 400, "unknown action is rejected")

        deleted = run({"action": "delete_folder", "folder_id": root_id})
        require(deleted.get("ok") and "chat-1" in deleted["orphaned"], "deleting a folder orphans its nested chats")

        durable = usr_root / "data" / "chat_organizer" / "tree.json"
        require(durable.is_file(), "state is written to the durable path outside the plugin directory")

        saved = json.loads(durable.read_text(encoding="utf-8"))
        require(saved.get("folders") == [], "durable file reflects the deleted folder")
        require("chat-1" in saved.get("orphan_order", []), "deleted folder chats are preserved as unfiled")
        require("chat-1" in saved.get("visible_order", []), "visible order survives the round trip")

        reloaded = module._load_tree()
        require(isinstance(reloaded, dict) and "folders" in reloaded, "saved tree reloads cleanly")

    print("All Chat Organizer backend boot checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
