import { createStore } from "/js/AlpineStore.js";
import { callJsonApi } from "/js/api.js";
import { justToast } from "/index.js";

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

export const store = createStore("chatOrganizer", {
  tree: null,
  draggedCtxid: null,
  dragOverFolderId: null,
  dragOverChatId: null,
  contextMenu: null,
  editingId: null,
  editValue: "",
  expanded: {},

  init() {
    if (!this.tree) this.loadTree();
  },

  onOpen() {
    this.loadTree();
  },

  cleanup() {
    this.contextMenu = null;
    this.draggedCtxid = null;
    this.dragOverFolderId = null;
    this.dragOverChatId = null;
  },

  async loadTree() {
    try {
      this.tree = await api("get_tree");
      this.tree.folders ||= [];
      this.tree.orphan_order ||= [];
    } catch (e) {
      console.error("ChatOrganizer: failed to load tree", e);
      justToast("Failed to load folder tree", "error", 3000, "chat-organizer");
      this.tree = { folders: [], orphan_order: [] };
    }
  },

  async createFolder(name, parentId = null) {
    try {
      const res = await api("create_folder", { name, parent_id: parentId });
      if (res?.folder?.id) this.expanded = { ...this.expanded, [parentId || res.folder.id]: true };
      await this.loadTree();
      justToast("Folder created", "success", 1500, "chat-organizer");
    } catch (e) {
      console.error("ChatOrganizer: create folder failed", e);
      justToast("Failed to create folder", "error", 3000, "chat-organizer");
    }
  },

  async renameFolder(folderId, name) {
    try {
      await api("rename_folder", { folder_id: folderId, name });
      await this.loadTree();
      justToast("Folder renamed", "success", 1500, "chat-organizer");
    } catch (e) {
      console.error("ChatOrganizer: rename failed", e);
      justToast("Failed to rename folder", "error", 3000, "chat-organizer");
    }
  },

  async deleteFolder(folderId) {
    try {
      await api("delete_folder", { folder_id: folderId });
      await this.loadTree();
      justToast("Folder deleted", "success", 1500, "chat-organizer");
    } catch (e) {
      console.error("ChatOrganizer: delete failed", e);
      justToast("Failed to delete folder", "error", 3000, "chat-organizer");
    }
  },

  async moveChat(ctxid, folderId = "", position = null) {
    try {
      await api("move_chat", { ctxid, folder_id: folderId || "", position });
      await this.loadTree();
    } catch (e) {
      console.error("ChatOrganizer: move chat failed", e);
      justToast("Failed to move chat", "error", 3000, "chat-organizer");
    }
  },

  isExpanded(id) { return !!this.expanded[id]; },

  toggleFolder(id) {
    this.expanded = { ...this.expanded, [id]: !this.expanded[id] };
  },

  folderTotalChats(folder) { return countTotalChats(folder); },

  getChatsStore() { return window.Alpine?.store("chats"); },

  getAllChats() { return this.getChatsStore()?.contexts || []; },

  getFolderChats(folder) {
    const chats = this.getAllChats();
    const ids = folder.chat_ids || [];
    return ids.map(id => chats.find(c => c.id === id)).filter(Boolean);
  },

  getOrphanChats() {
    const chats = this.getAllChats();
    const assigned = collectAssignedIds(this.tree?.folders || []);
    const orphans = chats.filter(c => !assigned.has(c.id));
    const byId = new Map(orphans.map(c => [c.id, c]));
    const ordered = [];
    for (const id of this.tree?.orphan_order || []) {
      if (byId.has(id)) {
        ordered.push(byId.get(id));
        byId.delete(id);
      }
    }
    return [...ordered, ...Array.from(byId.values())];
  },

  getRows() {
    const rows = [];
    const pushFolder = (folder, depth) => {
      rows.push({ key: `folder:${folder.id}`, type: "folder", folder, depth });
      if (this.isExpanded(folder.id)) {
        for (const ctx of this.getFolderChats(folder)) {
          rows.push({ key: `chat:${folder.id}:${ctx.id}`, type: "chat", ctx, folderId: folder.id, depth: depth + 1 });
        }
        for (const child of folder.children || []) pushFolder(child, depth + 1);
        if ((folder.chat_ids || []).length === 0 && (folder.children || []).length === 0) {
          rows.push({ key: `empty:${folder.id}`, type: "empty", depth: depth + 1 });
        }
      }
    };
    for (const folder of this.tree?.folders || []) pushFolder(folder, 0);
    const orphans = this.getOrphanChats();
    if (orphans.length > 0) rows.push({ key: "orphans-header", type: "orphansHeader", count: orphans.length, depth: 0 });
    for (const ctx of orphans) rows.push({ key: `chat:orphans:${ctx.id}`, type: "chat", ctx, folderId: "", depth: 0, orphan: true });
    return rows;
  },

  dragStartChat(ev, ctxid) {
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("text/plain", ctxid);
    this.draggedCtxid = ctxid;
  },

  dragOverFolder(ev, folderId) {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    this.dragOverFolderId = folderId || "__orphans__";
  },

  dragLeaveFolder(_ev, folderId) {
    if (this.dragOverFolderId === (folderId || "__orphans__")) this.dragOverFolderId = null;
  },

  dropOnFolder(ev, folderId = "") {
    ev.preventDefault();
    const ctxid = ev.dataTransfer.getData("text/plain") || this.draggedCtxid;
    this.dragOverFolderId = null;
    this.dragOverChatId = null;
    if (ctxid) this.moveChat(ctxid, folderId || "", null);
    this.draggedCtxid = null;
  },

  dragOverChat(ev, ctxid) {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    this.dragOverChatId = ctxid;
  },

  async dropBeforeChat(ev, targetCtxid, folderId = "") {
    ev.preventDefault();
    const ctxid = ev.dataTransfer.getData("text/plain") || this.draggedCtxid;
    this.dragOverFolderId = null;
    this.dragOverChatId = null;
    this.draggedCtxid = null;
    if (!ctxid || ctxid === targetCtxid) return;

    let ids;
    if (folderId) {
      const folder = findFolder(folderId, this.tree?.folders || []);
      ids = (folder?.chat_ids || []).filter(id => id !== ctxid);
    } else {
      ids = this.getOrphanChats().map(c => c.id).filter(id => id !== ctxid);
    }
    const position = Math.max(0, ids.indexOf(targetCtxid));
    await this.moveChat(ctxid, folderId || "", position);
  },

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
      const el = document.getElementById(`rename-input-${folderId}`);
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

  async newChat() {
    try {
      const chats = this.getChatsStore();
      if (chats?.newChat) await chats.newChat();
      await this.loadTree();
    } catch (e) {
      console.error("ChatOrganizer: newChat failed", e);
      justToast("Failed to create chat", "error", 3000, "chat-organizer");
    }
  },

  selectChat(ctxid) { this.getChatsStore()?.selectChat?.(ctxid); },
  isSelected(ctxid) { return this.getChatsStore()?.selected === ctxid; },
  killChat(ctxid) { this.getChatsStore()?.killChat?.(ctxid); },
});
