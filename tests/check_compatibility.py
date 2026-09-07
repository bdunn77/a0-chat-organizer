#!/usr/bin/env python3
"""Validate Chat Organizer and the Agent Zero contracts it depends on."""

from __future__ import annotations

import argparse
import ast
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)
    print(f"PASS: {message}")


def read(path: Path) -> str:
    require(path.is_file(), f"required file exists: {path}")
    return path.read_text(encoding="utf-8")


def check_plugin() -> None:
    manifest = read(ROOT / "plugin.yaml")
    require(re.search(r"(?m)^name:\s*chat_organizer\s*$", manifest) is not None, "manifest name is chat_organizer")
    require(re.search(r"(?m)^version:\s*\d+\.\d+\.\d+\s*$", manifest) is not None, "manifest version is semantic")
    for field in ("title", "description", "settings_sections", "per_project_config", "per_agent_config"):
        require(re.search(rf"(?m)^{field}:", manifest) is not None, f"manifest includes {field}")

    backend_path = ROOT / "api" / "tree_handler.py"
    backend = read(backend_path)
    tree = ast.parse(backend, filename=str(backend_path))
    imports = {
        alias.name
        for node in tree.body
        if isinstance(node, ast.ImportFrom) and node.module == "helpers.api"
        for alias in node.names
    }
    require({"ApiHandler", "Input", "Output", "Request", "Response"} <= imports, "backend uses the supported helpers.api interface")
    handlers = [node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "TreeHandler"]
    require(len(handlers) == 1, "TreeHandler class exists once")
    require(any(isinstance(base, ast.Name) and base.id == "ApiHandler" for base in handlers[0].bases), "TreeHandler subclasses ApiHandler")
    process = next((node for node in handlers[0].body if isinstance(node, ast.AsyncFunctionDef) and node.name == "process"), None)
    require(process is not None and [arg.arg for arg in process.args.args] == ["self", "input", "request"], "TreeHandler implements async process(self, input, request)")
    require('USER_DIR, "data", "chat_organizer", "tree.json"' in backend, "backend stores folders outside the plugin directory")
    require("_migrate_legacy_tree" in backend, "backend migrates legacy plugin-local tree.json")
    require('_LEGACY_TREE_FILE = _PLUGIN_ROOT / "data" / "tree.json"' in backend, "backend still knows the legacy plugin data path")

    html = read(ROOT / "extensions" / "webui" / "sidebar-chats-list-start" / "chat_organizer.html")
    require('<template x-if="$store.chatOrganizer">' in html, "frontend uses the Alpine store gate")
    require('x-init="$store.chatOrganizer.onOpen()"' in html, "frontend initializes the store")
    require('x-destroy="$store.chatOrganizer.cleanup()"' in html, "frontend cleans up the store")
    require('/plugins/chat_organizer/webui/chat_organizer_store.js' in html, "frontend loads its module through the plugin route")
    require("touch-action: pan-y" in html, "touch rows preserve vertical scrolling")

    store = read(ROOT / "webui" / "chat_organizer_store.js")
    require('createStore("chatOrganizer"' in store, "frontend uses createStore")
    require(re.search(r'registerRowListExtension\(\s*["\']chat["\']\s*,\s*(?:PLUGIN|["\']chatOrganizer["\'])\s*,', store) is not None, "plugin registers the supported chat row extension")
    require("topLevelContexts?.()" in store and "childContexts?.(" in store, "plugin maps hierarchical chat rows")
    require("touchActivate = ax >= 12 && ax > ay * 1.25" in store, "touch drag requires horizontal intent")
    require("if (ay >= 10 && ay > ax)" in store, "vertical touch intent cancels drag")
    require(re.search(r"chats\.contexts\s*=", store) is None, "plugin does not replace the WebSocket-owned contexts array")


def check_upstream(agent_zero: Path) -> None:
    require(agent_zero.is_dir(), f"Agent Zero checkout exists: {agent_zero}")
    sidebar = read(agent_zero / "webui" / "components" / "sidebar" / "sidebar-store.js")
    require("registerRowListExtension(kind, name, extension)" in sidebar, "Agent Zero exposes registerRowListExtension")
    require("sortRows(kind, rows)" in sidebar, "Agent Zero exposes sortRows")
    require("hasRowDividerBefore(kind, item, index, rows)" in sidebar, "Agent Zero exposes row divider extensions")

    chat_list = read(agent_zero / "webui" / "components" / "sidebar" / "chats" / "chats-list.html")
    require('<x-extension id="sidebar-chats-list-start"></x-extension>' in chat_list, "Agent Zero retains the sidebar extension point")
    require("$store.chats.topLevelContexts()" in chat_list, "Agent Zero renders top-level contexts")
    require("$store.chats.childContexts(context.id)" in chat_list, "Agent Zero renders child contexts")
    require('class="chat-container' in chat_list or "'chat-container': true" in chat_list, "Agent Zero retains chat-container rows")
    require(re.search(r'class=["\'][^"\']*\bchats-config-list\b[^"\']*["\']', chat_list) is not None, "Agent Zero retains the scrollable chat list")

    chats_store = read(agent_zero / "webui" / "components" / "sidebar" / "chats" / "chats-store.js")
    require("topLevelContexts()" in chats_store, "Agent Zero chat store exposes topLevelContexts")
    require("childContexts(" in chats_store, "Agent Zero chat store exposes childContexts")

    api = read(agent_zero / "helpers" / "api.py")
    api_tree = ast.parse(api)
    api_handlers = [node for node in api_tree.body if isinstance(node, ast.ClassDef) and node.name == "ApiHandler"]
    require(len(api_handlers) == 1, "Agent Zero exposes ApiHandler")
    process = next((node for node in api_handlers[0].body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "process"), None)
    require(process is not None and [arg.arg for arg in process.args.args] == ["self", "input", "request"], "Agent Zero ApiHandler process signature remains compatible")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent-zero", type=Path, required=True, help="Path to an Agent Zero checkout")
    args = parser.parse_args()
    try:
        check_plugin()
        check_upstream(args.agent_zero.resolve())
    except (AssertionError, SyntaxError) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    print("All Chat Organizer compatibility checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
