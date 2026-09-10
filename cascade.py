"""Pure parent/child helpers for Chat Organizer cascade delete."""

from __future__ import annotations

from typing import Any


def parent_id_from_record(record: dict[str, Any] | None) -> str:
    """Return the stored parent context id, if any."""
    if not isinstance(record, dict):
        return ""
    output_data = record.get("output_data") or {}
    if not isinstance(output_data, dict):
        output_data = {}
    parent = output_data.get("parent_context_id") or record.get("parent_context_id") or ""
    return str(parent).strip()


def collect_direct_children(parent_id: str, records: dict[str, dict[str, Any]]) -> list[str]:
    """Return direct children of parent_id. Never returns the parent itself."""
    parent_id = str(parent_id or "").strip()
    if not parent_id:
        return []
    children: list[str] = []
    for ctxid, record in records.items():
        cid = str(ctxid or "").strip()
        if not cid or cid == parent_id:
            continue
        if parent_id_from_record(record) == parent_id:
            children.append(cid)
    return children


def collect_descendants(parent_id: str, records: dict[str, dict[str, Any]]) -> list[str]:
    """Return all descendants of parent_id, children before deeper descendants."""
    parent_id = str(parent_id or "").strip()
    if not parent_id:
        return []
    out: list[str] = []
    seen = {parent_id}
    stack = collect_direct_children(parent_id, records)
    while stack:
        ctxid = stack.pop(0)
        if ctxid in seen:
            continue
        seen.add(ctxid)
        out.append(ctxid)
        stack.extend(collect_direct_children(ctxid, records))
    return out


def collect_stranded_ids(records: dict[str, dict[str, Any]]) -> list[str]:
    """Return leftover children of missing parents, including their descendants."""
    live = {str(ctxid).strip() for ctxid in records if str(ctxid).strip()}
    direct: list[str] = []
    for ctxid, record in records.items():
        cid = str(ctxid or "").strip()
        if not cid:
            continue
        parent = parent_id_from_record(record)
        if parent and parent not in live:
            direct.append(cid)
    out: list[str] = []
    seen: set[str] = set()
    for ctxid in direct:
        if ctxid in seen:
            continue
        seen.add(ctxid)
        out.append(ctxid)
        for descendant in collect_descendants(ctxid, records):
            if descendant in seen:
                continue
            seen.add(descendant)
            out.append(descendant)
    return out


def ids_deleted_with_parent(parent_id: str, records: dict[str, dict[str, Any]]) -> list[str]:
    """IDs removed when a parent is deleted: the parent plus all descendants."""
    parent_id = str(parent_id or "").strip()
    if not parent_id:
        return []
    return [parent_id, *collect_descendants(parent_id, records)]


def ids_deleted_with_child(child_id: str, records: dict[str, dict[str, Any]]) -> list[str]:
    """IDs removed when a child is deleted: the child plus its descendants, never its parent."""
    child_id = str(child_id or "").strip()
    if not child_id:
        return []
    parent = parent_id_from_record(records.get(child_id))
    deleted = [child_id, *collect_descendants(child_id, records)]
    return [ctxid for ctxid in deleted if ctxid != parent]
