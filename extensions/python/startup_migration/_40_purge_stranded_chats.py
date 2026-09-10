from __future__ import annotations

import json
import sys
from pathlib import Path

from helpers.extension import Extension
from helpers.print_style import PrintStyle

_PLUGIN_ROOT = Path(__file__).resolve()
for parent in Path(__file__).resolve().parents:
    if (parent / "cascade.py").is_file() and (parent / "plugin.yaml").is_file():
        _PLUGIN_ROOT = parent
        break
if str(_PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_ROOT))

from cascade import collect_stranded_ids  # noqa: E402


def _load_persisted_records() -> dict[str, dict]:
    from helpers import persist_chat

    records: dict[str, dict] = {}
    chats_dir = Path(persist_chat.get_chat_folder_path("_")).parent
    if not chats_dir.is_dir():
        return records
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
    return records


def purge_stranded_chats() -> list[str]:
    """Delete leftover children of already-deleted parents. Never deletes a live parent."""
    from agent import AgentContext
    from helpers import persist_chat

    records = _load_persisted_records()
    for context in AgentContext.all():
        records.setdefault(context.id, {
            "id": context.id,
            "output_data": dict(getattr(context, "output_data", None) or {}),
        })
    removed: list[str] = []
    for ctxid in collect_stranded_ids(records):
        if not ctxid:
            continue
        try:
            context = AgentContext.get(ctxid)
            if context:
                context.reset()
            AgentContext.remove(ctxid)
        except Exception:
            pass
        try:
            persist_chat.remove_chat(ctxid)
        except Exception:
            continue
        removed.append(ctxid)
    return removed


class PurgeStrandedChats(Extension):
    def execute(self, **kwargs):
        removed = purge_stranded_chats()
        if removed:
            PrintStyle.info(f"Chat Organizer removed {len(removed)} leftover child chats of deleted parents.")
