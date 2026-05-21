# Chat Organizer

Organize your Agent Zero chats with folders, drag-and-drop reordering, and unlimited nesting. Adds a collapsible folder tree above the default chat list as a navigation filter panel — **compatible with Chat Rename, Favorite Chats, Chat Status Marklet, and other sidebar plugins.**

## Features

- **Folders** — create, rename, and delete folders to organize your chats
- **Nested folders** — folders inside folders with unlimited depth
- **Filter-by-folder** — click a folder to filter the default chat list to only its chats
- **Unfiled / All Chats** — quick filter buttons to show unfiled chats or all chats
- **Drag & drop** — drag chats from the default list onto any folder to assign them
- **Inline rename** — click the ⋮ context menu on any folder to rename
- **New Subfolder** — right-click (or click ⋮) any folder to create a subfolder
- **Chat count badge** — each folder shows how many chats it contains (including nested)
- **Plugin-compatible** — does NOT hide the default chat list; preserves all other sidebar plugin enhancements

## Architecture

```
usr/plugins/chat_organizer/
├── plugin.yaml
├── README.md
├── LICENSE
├── api/
│   └── tree_handler.py          # CRUD endpoints for folder tree (JSON persistence)
├── webui/
│   └── chat_organizer_store.js   # Alpine.js store for the frontend
└── extensions/
    └── webui/
        └── sidebar-chats-list-start/
            └── chat_organizer.html  # Sidebar folder tree + filter panel
```

## How it works

- **Backend** — `tree_handler.py` manages a JSON tree at `data/tree.json` with actions: `get_tree`, `create_folder`, `rename_folder`, `delete_folder`, `move_chat`, `reorder`
- **Frontend** — Alpine store (`chatOrganizer`) loads the tree, manages context menus, inline rename, and filters
- **Extension point** — injects at `sidebar-chats-list-start` as a folder navigation panel above the default chat list
- **Filtering** — clicking a folder filters the default `.chat-container` elements via `display:none`; clicking "All Chats" shows everything
- **Plugin compatibility** — the default chat list stays in the DOM so other plugins (Chat Rename, Favorite Chats, Status Marklet) continue to work

## No dependencies

This plugin uses only Agent Zero built-in APIs. No pip packages or external services required.
