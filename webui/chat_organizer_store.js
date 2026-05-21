import { createStore } from "/js/AlpineStore.js";
import { callJsonApi } from "/js/api.js";
import { toastFrontendError, toastFrontendSuccess } from "/components/notifications/notification-store.js";

const PLUGIN = "chat_organizer";

async function api(action, body = {}) {
  return await callJsonApi(`/plugins/${PLUGIN}/tree_handler`, { ...body, action });
}

function walkFolders(folders, fn) {
  for (const folder of folders || []) {
    fn(folder);
    walkFolders(folder.children || [], fn);
  }
}

function findFolder(id, folders) {
  for (const folder of folders || []) {
    if (folder.id === id) return folder;
    const found = findFolder(id, folder.children || []);
    if (found) return found;
  }
  return null;
}

function findFolderName(id, folders) {
  const folder = findFolder(id, folders);
  return folder ? folder.name : "";
}

function countTotalChats(folder) {
  let n = (folder.chat_ids || []).length;
  for (const child of folder.children || []) n += countTotalChats(child);
  return n;
}

function collectAssignedIds(folders, out = new Set()) {
  walkFolders(folders, (folder) => {
    for (const id of folder.chat_ids || []) out.add(id);
  });
  return out;
}

function flattenFolders(folders, out = []) {
  walkFolders(folders, (folder) => {
    out.push({ id: folder.id, name: folder.name, depth: 0 });
  });
  // Add depth info
  function walkDepth(list, depth) {
    for (const f of list) {
      const entry = out.find(e => e.id === f.id);
      if (entry) entry.depth = depth;
      walkDepth(f.children || [], depth + 1);
    }
  }
  walkDepth(folders, 0);
  return out;
}

function findFolderForChat(ctxid, folders) {
  for (const folder of folders || []) {
    if ((folder.chat_ids || []).includes(ctxid)) return folder;
    const found = findFolderForChat(ctxid, folder.children || []);
    if (found) return found;
  }
  return null;
}

export const store = createStore("chatOrganizer", {
  tree: null,
  contextMenu: null,        // folder context menu
  chatContextMenu: null,    // chat context menu {ctxid, x, y}
  editingId: null,
  editValue: "",
  expanded: {},
  activeFilter: null,

  init() {
    if (!this.tree) this.loadTree();
  },

  onOpen() {
    this.loadTree();
    this._startObserver();
  },

  cleanup() {
    this.contextMenu = null;
    this.chatContextMenu = null;
    this._stopObserver();
    this._clearFilter();
    this._removeChatInteractions();
  },

  async loadTree() {
    try {
      this.tree = await api("get_tree");
      this.tree.folders ||= [];
      this.tree.orphan_order ||= [];
      this._applyFilter();
    } catch (e) {
      console.error("ChatOrganizer: failed to load tree", e);
      toastFrontendError("Failed to load folder tree", "Chat Organizer");
      this.tree = { folders: [], orphan_order: [] };
    }
  },

  async createFolder(name, parentId = null) {
    try {
      const body = { name };
      if (parentId) body.parent_id = parentId;
      const res = await api("create_folder", body);
      if (res?.folder?.id) this.expanded = { ...this.expanded, [parentId || res.folder.id]: true };
      await this.loadTree();
      toastFrontendSuccess("Folder created", "Chat Organizer");
    } catch (e) {
      console.error("ChatOrganizer: create folder failed", e);
      toastFrontendError("Failed to create folder", "Chat Organizer");
    }
  },

  async renameFolder(folderId, name) {
    try {
      await api("rename_folder", { folder_id: folderId, name });
      await this.loadTree();
      toastFrontendSuccess("Folder renamed", "Chat Organizer");
    } catch (e) {
      console.error("ChatOrganizer: rename failed", e);
      toastFrontendError("Failed to rename folder", "Chat Organizer");
    }
  },

  async deleteFolder(folderId) {
    try {
      await api("delete_folder", { folder_id: folderId });
      await this.loadTree();
      if (this.activeFilter === folderId) this.activeFilter = null;
      toastFrontendSuccess("Folder deleted", "Chat Organizer");
    } catch (e) {
      console.error("ChatOrganizer: delete failed", e);
      toastFrontendError("Failed to delete folder", "Chat Organizer");
    }
  },

  async moveChat(ctxid, folderId = "", position = null) {
    try {
      await api("move_chat", { ctxid, folder_id: folderId || "", position });
      await this.loadTree();
      toastFrontendSuccess("Chat moved", "Chat Organizer");
    } catch (e) {
      console.error("ChatOrganizer: move chat failed", e);
      toastFrontendError("Failed to move chat", "Chat Organizer");
    }
  },

  async removeChatFromFolder(ctxid) {
    await this.moveChat(ctxid, "");
  },

  isExpanded(id) { return !!this.expanded[id]; },

  toggleFolder(id) {
    this.expanded = { ...this.expanded, [id]: !this.expanded[id] };
  },

  folderTotalChats(folder) { return countTotalChats(folder); },

  getChatsStore() { return window.Alpine?.store("chats"); },
  getAllChats() { return this.getChatsStore()?.contexts || []; },

  getOrphanIds() {
    const assigned = collectAssignedIds(this.tree?.folders || []);
    return this.getAllChats().filter(c => !assigned.has(c.id)).map(c => c.id);
  },

  getFolderForChat(ctxid) {
    return findFolderForChat(ctxid, this.tree?.folders || []);
  },

  // Build flat rows for rendering the folder tree (folders only)
  getRows() {
    const rows = [];
    const pushFolder = (folder, depth) => {
      rows.push({ key: `folder:${folder.id}`, type: "folder", folder, depth });
      if (this.isExpanded(folder.id)) {
        for (const child of folder.children || []) pushFolder(child, depth + 1);
      }
    };
    for (const folder of this.tree?.folders || []) pushFolder(folder, 0);
    const orphanCount = this.getOrphanIds().length;
    rows.push({ key: "orphans-row", type: "orphans", count: orphanCount, depth: 0 });
    rows.push({ key: "all-chats-row", type: "all", depth: 0 });
    return rows;
  },

  // Filtering: show/hide default chat-container elements
  setFilter(folderId) {
    this.activeFilter = folderId;
    this._applyFilter();
  },

  clearFilter() {
    this.activeFilter = null;
    this._applyFilter();
  },

  _applyFilter() {
    const list = document.querySelector('.chats-config-list');
    if (!list) return;
    const items = list.querySelectorAll('.chat-container');
    if (!this.activeFilter && this.activeFilter !== "") {
      items.forEach(el => el.style.display = '');
      return;
    }
    const folder = this.activeFilter ? findFolder(this.activeFilter, this.tree?.folders || []) : null;
    const visibleIds = folder ? new Set(folder.chat_ids || []) : new Set(this.getOrphanIds());
    items.forEach(el => {
      const ctxid = el.getAttribute('data-ctxid');
      el.style.display = visibleIds.has(ctxid) ? '' : 'none';
    });
  },

  _clearFilter() {
    const list = document.querySelector('.chats-config-list');
    if (!list) return;
    list.querySelectorAll('.chat-container').forEach(el => el.style.display = '');
  },

  // ── Observer + Chat interaction attachment ──
  _observer: null,
  _attachedChats: new WeakSet(),

  _startObserver() {
    this._stopObserver();
    const list = document.querySelector('.chats-config-list');
    if (!list) return;
    this._tagChatItems();
    this._attachChatInteractions();
    this._observer = new MutationObserver(() => {
      this._tagChatItems();
      this._attachChatInteractions();
      this._applyFilter();
    });
    this._observer.observe(list, { childList: true, subtree: true });
  },

  _stopObserver() {
    if (this._observer) { this._observer.disconnect(); this._observer = null; }
  },

  _tagChatItems() {
    const chats = this.getAllChats();
    const list = document.querySelector('.chats-config-list');
    if (!list) return;
    const items = list.querySelectorAll('.chat-container');
    items.forEach((el, i) => {
      if (!el.getAttribute('data-ctxid') && chats[i]) {
        el.setAttribute('data-ctxid', chats[i].id);
      }
    });
  },

  _attachChatInteractions() {
    const items = document.querySelectorAll('.chats-config-list .chat-container');
    const self = this;
    items.forEach((el) => {
      if (self._attachedChats.has(el)) return;
      self._attachedChats.add(el);

      // Make draggable
      el.setAttribute('draggable', 'true');
      el.addEventListener('dragstart', function(ev) {
        const ctxid = el.getAttribute('data-ctxid');
        if (ctxid) {
          ev.dataTransfer.effectAllowed = 'move';
          ev.dataTransfer.setData('text/plain', ctxid);
        }
      });

      // Right-click context menu on chat
      el.addEventListener('contextmenu', function(ev) {
        const ctxid = el.getAttribute('data-ctxid');
        if (ctxid) {
          ev.preventDefault();
          ev.stopPropagation();
          self.chatContextMenu = { ctxid, x: ev.clientX, y: ev.clientY };
        }
      });
    });
  },

  _removeChatInteractions() {
    const items = document.querySelectorAll('.chats-config-list .chat-container');
    items.forEach((el) => {
      el.removeAttribute('draggable');
    });
  },

  // ── Chat context menu ──
  closeChatContextMenu() { this.chatContextMenu = null; },

  getFlatFolders() {
    return flattenFolders(this.tree?.folders || []);
  },

  getChatCurrentFolderName(ctxid) {
    const folder = findFolderForChat(ctxid, this.tree?.folders || []);
    return folder ? folder.name : null;
  },

  moveChatToFolder(ctxid, folderId) {
    this.closeChatContextMenu();
    this.moveChat(ctxid, folderId || "");
  },

  // ── Folder context menu ──
  openContextMenu(ev, folderId) {
    ev.preventDefault();
    ev.stopPropagation();
    this.contextMenu = { folderId, x: ev.clientX, y: ev.clientY };
  },

  closeContextMenu() { this.contextMenu = null; },

  startRename(folderId) {
    this.editingId = folderId;
    this.editValue = findFolderName(folderId, this.tree?.folders || []);
    this.closeContextMenu();
    setTimeout(() => {
      const el = document.getElementById(`co-rename-${folderId}`);
      if (el) { el.focus(); el.select(); }
    }, 50);
  },

  finishRename(folderId) {
    const name = this.editValue.trim();
    if (name) this.renameFolder(folderId, name);
    this.editingId = null;
    this.editValue = "";
  },

  cancelRename() { this.editingId = null; this.editValue = ""; },

  isEditing(id) { return this.editingId === id; },

  showCreateFolder(parentId = null) {
    const name = prompt("Folder name:");
    if (name && name.trim()) this.createFolder(name.trim(), parentId);
  },

  // ── Drag-and-drop onto folders ──
  dragOverFolder(ev, folderId) {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
  },

  async dropOnFolder(ev, folderId = "") {
    ev.preventDefault();
    const ctxid = ev.dataTransfer.getData("text/plain");
    if (ctxid) await this.moveChat(ctxid, folderId);
  },
});
