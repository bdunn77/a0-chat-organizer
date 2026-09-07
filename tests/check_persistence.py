#!/usr/bin/env python3
"""Validate durable folder persistence and legacy tree.json migration."""

from __future__ import annotations

import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _install_fake_helpers() -> None:
    helpers = types.ModuleType("helpers")
    api = types.ModuleType("helpers.api")

    class ApiHandler:
        pass

    class Response:
        def __init__(self, message: str, status: int = 400):
            self.message = message
            self.status = status

    api.ApiHandler = ApiHandler
    api.Input = dict
    api.Output = object
    api.Request = object
    api.Response = Response
    sys.modules.setdefault("helpers", helpers)
    sys.modules["helpers.api"] = api


_install_fake_helpers()
sys.path.insert(0, str(ROOT / "api"))
import tree_handler as th  # noqa: E402


SAMPLE_TREE = {
    "folders": [
        {
            "id": "folder-a",
            "name": "Projects",
            "chat_ids": ["chat-1"],
            "children": [],
        }
    ],
    "orphan_order": ["chat-2"],
    "visible_order": ["chat-1", "chat-2"],
}


class PersistenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.legacy = self.root / "plugin" / "data" / "tree.json"
        self.durable = self.root / "usr" / "data" / "chat_organizer" / "tree.json"
        self.legacy.parent.mkdir(parents=True)
        th._LEGACY_TREE_FILE = self.legacy
        th._durable_tree_file = lambda: self.durable  # type: ignore[method-assign]

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_missing_files_yield_empty_tree(self) -> None:
        self.assertEqual(th._load_tree(), {"folders": [], "orphan_order": [], "visible_order": []})

    def test_save_writes_durable_path_not_plugin_dir(self) -> None:
        th._save_tree(SAMPLE_TREE)
        self.assertTrue(self.durable.is_file())
        self.assertFalse(self.legacy.exists())
        saved = json.loads(self.durable.read_text(encoding="utf-8"))
        self.assertEqual(saved["folders"][0]["name"], "Projects")

    def test_legacy_tree_is_migrated_once(self) -> None:
        self.legacy.write_text(json.dumps(SAMPLE_TREE), encoding="utf-8")
        loaded = th._load_tree()
        self.assertEqual(loaded["folders"][0]["id"], "folder-a")
        self.assertTrue(self.durable.is_file())
        migrated = json.loads(self.durable.read_text(encoding="utf-8"))
        self.assertEqual(migrated["orphan_order"], ["chat-2"])

    def test_existing_durable_tree_is_not_overwritten_by_legacy(self) -> None:
        self.durable.parent.mkdir(parents=True)
        self.durable.write_text(
            json.dumps(
                {
                    "folders": [{"id": "keep", "name": "Keep", "chat_ids": [], "children": []}],
                    "orphan_order": [],
                    "visible_order": [],
                }
            ),
            encoding="utf-8",
        )
        self.legacy.write_text(json.dumps(SAMPLE_TREE), encoding="utf-8")
        loaded = th._load_tree()
        self.assertEqual(loaded["folders"][0]["id"], "keep")

    def test_plugin_dir_replacement_keeps_durable_folders(self) -> None:
        th._save_tree(SAMPLE_TREE)
        if self.legacy.exists():
            self.legacy.unlink()
        loaded = th._load_tree()
        self.assertEqual(loaded["folders"][0]["name"], "Projects")

    def test_invalid_json_falls_back_to_empty_tree(self) -> None:
        self.legacy.write_text("{not-json", encoding="utf-8")
        self.assertEqual(th._load_tree()["folders"], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
