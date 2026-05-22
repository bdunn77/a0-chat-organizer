# Chat Organizer

Organize your Agent Zero chats with unlimited nested folders while keeping the default chat sidebar intact and compatible with other sidebar plugins.

## Features

- **Folders** — create, rename, and delete folders to organize your chats
- **Unlimited nested folders** — folders inside folders with recursive rendering
- **Filter-by-folder** — click a folder to filter the default chat list to only its chats
- **Unfiled / All Chats** — quick filter buttons to show unfiled chats or all chats
- **Drag chat to folder** — drag a chat from the default sidebar list onto any folder or Unfiled
- **Right-click chat menu** — right-click any chat to move it to a folder, Unfiled, or remove it from its folder
- **Smooth drag reorder** — drag a chat above/below another chat using a custom pointer-drag interaction with a polished floating preview and insertion marker
- **Cross-folder move by reorder** — drag a chat near a chat in another folder to move it into that folder and place it there
- **Chat count badges** — each folder shows how many chats it contains, including nested folders
- **Plugin-compatible** — does not replace the default `.chat-container` rows, so Chat Rename, Favorite Chats, Chat Status Marklet, and similar plugins continue working
- **High-contrast UI** — folder rows, filter rows, badges, menus, active states, and rename inputs use scoped theme-safe colors so text stays readable across dark/light/custom themes

## Architecture

```
usr/plugins/chat_organizer/
├── plugin.yaml
├── README.md
├── LICENSE
├── api/
│   └── tree_handler.py          # CRUD/reorder endpoints with JSON persistence
├── webui/
│   └── chat_organizer_store.js   # Alpine store: folders, filtering, drag/drop, context menus
└── extensions/
    └── webui/
        └── sidebar-chats-list-start/
            └── chat_organizer.html  # Sidebar folder navigation/filter panel
```

## How it works

- **Backend** — `tree_handler.py` persists folder data at `data/tree.json` and supports `get_tree`, `create_folder`, `rename_folder`, `delete_folder`, `move_chat`, `reorder`, and `set_orphan_order`.
- **Frontend** — the `chatOrganizer` Alpine store renders the folder panel, attaches drag/drop and right-click listeners to the default chat rows, and filters/reorders `$store.chats.contexts` without replacing the default sidebar DOM.
- **File-drop overlay guard** — chat moves/reorders use custom pointer events instead of native file-style dragging, so Agent Zero's file attachment overlay does not appear during chat-only drags.
- **Compatibility** — default chat rows remain in the DOM, preserving other chat sidebar plugins.

## No dependencies

This plugin uses only Agent Zero built-in APIs. No pip packages or external services required.

## Reorder & Folder Rules (v1.2.1)

To keep behavior predictable and avoid accidental folder assignment:

- The default Agent Zero chat list reflects your saved ordering (Unfiled chats keep your reorder, then folder chats follow in their folder order).
- Dragging a chat onto a **folder row** assigns the chat to that folder.
- Dragging a chat onto the **Unfiled** row removes it from any folder.
- Dragging a chat **above/below another chat** reorders within that chat's container (Unfiled chats reorder unfiled, folder chats reorder within their folder). It will never silently move a chat into a different folder.
- Use the right-click chat menu to explicitly move a chat to any folder.
- ESC cancels an in-progress drag.
- Auto-scroll kicks in near the top/bottom edges of the sidebar while dragging.

## Reorder Reliability Notes (v1.4.1)

Reordering in All Chats now updates the visible sidebar order optimistically before backend persistence completes. The plugin also stores a local browser fallback (`localStorage`) so the row visibly moves immediately even if Agent Zero has not restarted yet with the newest backend API. Server-side persistence uses `visible_order` via `set_visible_order` after restart.

## Production Notes (v1.4.2)

The unified `visible_order` also projects back into each folder's `chat_ids` and the Unfiled `orphan_order`, so filtered folder views, Unfiled view, and All Chats view remain consistent after mixed sidebar reordering. Pointer-drag cleanup aborts safely on plugin unmount, pointer cancel, or ESC.

## Nested Folder Behavior (v1.5.0)

Child folders are visually indented under their parent folders. Selecting a parent folder shows every chat inside that folder tree, including chats assigned directly to the parent plus chats assigned to any child or descendant folder. Direct folder membership is still preserved for moving/reordering; recursive inclusion is used for filtering/display.

## Subfolder Creation Visibility (v1.5.1)

Creating a subfolder now reloads the tree first and then expands the full parent path, so the first child folder appears immediately under its parent without requiring a second subfolder or manual refresh.

## Folder Expansion Persistence (v1.5.2)

Folder expanded/collapsed state is now persisted in localStorage. On first run with no saved expansion state, folders that contain children are expanded by default so nested subfolders are visible after a hard refresh. User collapse/expand preferences are preserved afterwards.

## Resizable Folder Panel (v1.6.0)

A draggable divider sits between the folder panel and the chat list. Drag the divider up/down to resize the folder panel and reveal more folders or more chats. Double-click the divider to reset to the default size. The chosen size is remembered in localStorage so it persists across hard refreshes.
