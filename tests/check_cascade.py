#!/usr/bin/env python3
"""Validate parent-delete cascades to children and child-delete never removes the parent."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cascade import (  # noqa: E402
    collect_descendants,
    collect_stranded_ids,
    ids_deleted_with_child,
    ids_deleted_with_parent,
    parent_id_from_record,
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)
    print(f"PASS: {message}")


def main() -> int:
    records = {
        "parent-a": {"output_data": {}},
        "child-a": {"output_data": {"parent_context_id": "parent-a"}},
        "grandchild-a": {"output_data": {"parent_context_id": "child-a"}},
        "parent-b": {"parent_context_id": ""},
        "child-b": {"output_data": {"parent_context_id": "parent-b"}},
        "orphan-child": {"output_data": {"parent_context_id": "deleted-parent"}},
        "orphan-grandchild": {"output_data": {"parent_context_id": "orphan-child"}},
    }

    require(parent_id_from_record(records["child-a"]) == "parent-a", "parent id is read from output_data")
    require(
        collect_descendants("parent-a", records) == ["child-a", "grandchild-a"],
        "parent descendants include nested children",
    )
    require(
        ids_deleted_with_parent("parent-a", records) == ["parent-a", "child-a", "grandchild-a"],
        "deleting a parent also deletes its descendants",
    )
    require(
        ids_deleted_with_child("child-a", records) == ["child-a", "grandchild-a"],
        "deleting a child deletes that child and its descendants",
    )
    require(
        "parent-a" not in ids_deleted_with_child("child-a", records),
        "deleting a child never deletes its parent",
    )
    require(
        sorted(collect_stranded_ids(records)) == ["orphan-child", "orphan-grandchild"],
        "leftover children of deleted parents are stranded",
    )
    require(
        "parent-b" not in collect_stranded_ids(records),
        "live parents are not treated as stranded",
    )
    print("All cascade checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
