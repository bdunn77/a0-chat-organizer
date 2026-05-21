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
