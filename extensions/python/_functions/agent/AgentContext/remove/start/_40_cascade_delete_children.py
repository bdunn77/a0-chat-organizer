from __future__ import annotations

import sys
import threading
from pathlib import Path

from helpers.extension import Extension

_PLUGIN_ROOT = Path(__file__).resolve()
for parent in Path(__file__).resolve().parents:
    if (parent / "cascade.py").is_file() and (parent / "plugin.yaml").is_file():
        _PLUGIN_ROOT = parent
        break
if str(_PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_ROOT))

from cascade import collect_descendants  # noqa: E402

_CASCADE = threading.local()


def _context_id(data: dict) -> str:
    args = data.get("args") or ()
    kwargs = data.get("kwargs") or {}
    if isinstance(args, tuple) and args:
        return str(args[0] or "").strip()
    return str(kwargs.get("id") or "").strip()


def _records() -> dict[str, dict]:
    from agent import AgentContext

    records: dict[str, dict] = {}
    for context in AgentContext.all():
        records[context.id] = {
            "id": context.id,
            "output_data": dict(getattr(context, "output_data", None) or {}),
            "parent_context_id": context.get_output_data("parent_context_id"),
        }
    return records


class CascadeDeleteChildrenOnRemove(Extension):
    def execute(self, data: dict = {}, **kwargs):
        # Nested AgentContext.remove calls from this cascade must not delete the
        # original parent. They only continue so descendants can be removed.
        if getattr(_CASCADE, "active", False):
            return

        parent_id = _context_id(data)
        if not parent_id:
            return

        descendants = collect_descendants(parent_id, _records())
        if not descendants:
            return

        from agent import AgentContext
        from helpers import persist_chat

        _CASCADE.active = True
        try:
            for child_id in descendants:
                if not child_id or child_id == parent_id:
                    continue
                try:
                    context = AgentContext.get(child_id)
                    if context:
                        context.reset()
                    AgentContext.remove(child_id)
                except Exception:
                    pass
                try:
                    persist_chat.remove_chat(child_id)
                except Exception:
                    pass
        finally:
            _CASCADE.active = False
