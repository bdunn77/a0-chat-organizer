# Chat Organizer

Organize your Agent Zero chats with folders, drag-and-drop reordering, and unlimited nesting. Adds a collapsible folder tree above the default chat list while keeping other chat sidebar plugins compatible.

## Features

- **Folders** — create, rename, and delete folders to organize your chats
- **Nested folders** — folders inside folders with unlimited depth, rendered recursively in the sidebar
- **Drag & drop** — drag chats into any folder, reorder them, or move them to the "Unfiled" section
- **Inline rename** — click the ⋮ context menu on any folder to rename
- **New Subfolder** — right-click (or click ⋮) any folder to create a subfolder
- **Chat count badge** — each folder shows how many chats it contains (including nested)
- **Unfiled section** — chats not in any folder stay in the "Unfiled" area
- **Project color balls** — each chat keeps its project color indicator

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
            └── chat_organizer.html  # Sidebar UI replacing default chat list
```

## How it works

- **Backend** — `tree_handler.py` manages a JSON tree at `data/tree.json` with actions: `get_tree`, `create_folder`, `rename_folder`, `delete_folder`, `move_chat`, `reorder`
- **Frontend** — Alpine store (`chatOrganizer`) loads the tree, manages drag-drop, context menus, and inline rename
- **Extension point** — injects at `sidebar-chats-list-start` into the Chats section, hiding the default flat list via CSS

## No dependencies

This plugin uses only Agent Zero built-in APIs. No pip packages or external services required.
