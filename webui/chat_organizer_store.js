import { createStore } from "/js/AlpineStore.js";
import { callJsonApi } from "/js/api.js";
import { toastFrontendError, toastFrontendSuccess } from "/components/notifications/notification-store.js";

const PLUGIN = "chat_organizer";
const CHAT_DRAG_TYPE = "application/x-chat-organizer-ctxid";

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
  draggedCtxid: null,
  dragOverFolderId: null,
  dragOverChatId: null,
  dragOverChatPosition: null,
  _attachmentOverlayPatched: false,

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
    this.draggedCtxid = null;
    this.dragOverFolderId = null;
    this.dragOverChatId = null;
    this.dragOverChatPosition = null;
    this._hideAttachmentOverlay();
    this._stopObserver();
    this._clearFilter();
    this._removeChatInteractions();
  },

  async loadTree() {
    try {
      this.tree = await api("get_tree");
      this.tree.folders ||= [];
      this.tree.orphan_order ||= [];
      this._syncChatsStoreOrder();
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

  async reorderChats(folderId, ctxids) {
    try {
      await api("reorder", { folder_id: folderId || "", ctxids });
      await this.loadTree();
      toastFrontendSuccess("Chats reordered", "Chat Organizer");
    } catch (e) {
      console.error("ChatOrganizer: reorder failed", e);
      toastFrontendError("Failed to reorder chats", "Chat Organizer");
    }
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
    const ids = this.getAllChats().filter(c => !assigned.has(c.id)).map(c => c.id);
    const available = new Set(ids);
    const ordered = [];
    for (const id of this.tree?.orphan_order || []) {
      if (available.has(id)) {
        ordered.push(id);
        available.delete(id);
      }
    }
    for (const id of ids) {
      if (available.has(id)) ordered.push(id);
    }
    return ordered;
  },

  getFolderIds(folderId) {
    if (!folderId) return this.getOrphanIds();
    const folder = findFolder(folderId, this.tree?.folders || []);
    return folder ? [...(folder.chat_ids || [])] : [];
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

  _getTreeOrderedIds() {
    const ids = [];
    const pushFolder = (folder) => {
      for (const id of folder.chat_ids || []) ids.push(id);
      for (const child of folder.children || []) pushFolder(child);
    };
    for (const folder of this.tree?.folders || []) pushFolder(folder);
    for (const id of this.getOrphanIds()) ids.push(id);
    return ids;
  },

  _syncChatsStoreOrder() {
    const chats = this.getChatsStore();
    if (!chats?.contexts?.length || !this.tree) return;

    const current = chats.contexts;
    const byId = new Map(current.map(ctx => [ctx.id, ctx]));
    const used = new Set();
    const ordered = [];

    for (const id of this._getTreeOrderedIds()) {
      if (byId.has(id) && !used.has(id)) {
        ordered.push(byId.get(id));
        used.add(id);
      }
    }

    // Keep brand-new/untracked chats visible; append them in the framework's current order.
    for (const ctx of current) {
      if (!used.has(ctx.id)) ordered.push(ctx);
    }

    if (ordered.length !== current.length) return;
    const changed = ordered.some((ctx, i) => ctx.id !== current[i]?.id);
    if (changed) chats.contexts = [...ordered];
  },

  // Filtering: show/hide default chat-container elements
  setFilter(folderId) {
    this.activeFilter = folderId;
    this._syncChatsStoreOrder();
    this._applyFilter();
  },

  clearFilter() {
    this.activeFilter = null;
    this._syncChatsStoreOrder();
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
    this._patchAttachmentOverlay();
    this._tagChatItems();
    this._attachChatInteractions();
    this._observer = new MutationObserver(() => {
      this._syncChatsStoreOrder();
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
      if (chats[i]) {
        // Always refresh: Alpine may reuse DOM nodes when contexts are reordered.
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

      // Make default Agent Zero chat rows draggable as internal chat-organizer items.
      el.setAttribute('draggable', 'true');
      el.classList.add('co-chat-draggable');

      el.addEventListener('dragstart', function(ev) {
        const ctxid = el.getAttribute('data-ctxid');
        if (!ctxid) return;
        self.draggedCtxid = ctxid;
        window.__chatOrganizerDraggingChat = true;
        self._patchAttachmentOverlay();
        self._hideAttachmentOverlay();
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData(CHAT_DRAG_TYPE, ctxid);
        ev.dataTransfer.setData('text/plain', ctxid);
        el.classList.add('co-chat-dragging');
      });

      el.addEventListener('dragend', function() {
        self._clearDragState();
      });

      // Let chats be reordered by dropping above/below another visible chat.
      el.addEventListener('dragenter', function(ev) {
        if (!self._isInternalChatDrag(ev)) return;
        ev.preventDefault();
        ev.stopPropagation();
      });

      el.addEventListener('dragover', function(ev) {
        if (!self._isInternalChatDrag(ev)) return;
        ev.preventDefault();
        ev.stopPropagation();
        ev.dataTransfer.dropEffect = 'move';
        self._hideAttachmentOverlay();
        const targetCtxid = el.getAttribute('data-ctxid');
        if (!targetCtxid || targetCtxid === self.draggedCtxid) return;
        const rect = el.getBoundingClientRect();
        const pos = ev.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
        self._setChatDropIndicator(el, targetCtxid, pos);
      });

      el.addEventListener('dragleave', function(ev) {
        if (!self._isInternalChatDrag(ev)) return;
        if (!el.contains(ev.relatedTarget)) self._clearChatDropIndicator(el);
      });

      el.addEventListener('drop', async function(ev) {
        if (!self._isInternalChatDrag(ev)) return;
        ev.preventDefault();
        ev.stopPropagation();
        const dragged = ev.dataTransfer.getData(CHAT_DRAG_TYPE) || ev.dataTransfer.getData('text/plain') || self.draggedCtxid;
        const target = el.getAttribute('data-ctxid');
        const position = self.dragOverChatPosition || 'before';
        self._clearChatDropIndicators();
        if (dragged && target && dragged !== target) await self.dropChatNearChat(dragged, target, position);
        self._clearDragState();
      });

      // Right-click context menu on chat.
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
      el.classList.remove('co-chat-draggable', 'co-chat-dragging', 'co-drop-before', 'co-drop-after');
    });
  },

  _isInternalChatDrag(ev) {
    const types = Array.from(ev?.dataTransfer?.types || []);
    return window.__chatOrganizerDraggingChat || types.includes(CHAT_DRAG_TYPE);
  },

  _patchAttachmentOverlay() {
    if (this._attachmentOverlayPatched) return;
    const attachments = window.Alpine?.store?.('chatAttachments');
    if (!attachments || attachments.__chatOrganizerPatched) return;
    const originalShow = attachments.showDragDropOverlay?.bind(attachments);
    const originalHide = attachments.hideDragDropOverlay?.bind(attachments);
    if (!originalShow || !originalHide) return;
    attachments.__chatOrganizerPatched = true;
    attachments.__chatOrganizerOriginalShow = originalShow;
    attachments.__chatOrganizerOriginalHide = originalHide;
    attachments.showDragDropOverlay = function() {
      if (window.__chatOrganizerDraggingChat) {
        this.dragDropOverlayVisible = false;
        return;
      }
      return originalShow();
    };
    attachments.hideDragDropOverlay = function() {
      return originalHide();
    };
    this._attachmentOverlayPatched = true;
  },

  _hideAttachmentOverlay() {
    const attachments = window.Alpine?.store?.('chatAttachments');
    if (attachments) attachments.dragDropOverlayVisible = false;
  },

  _clearDragState() {
    window.__chatOrganizerDraggingChat = false;
    this.draggedCtxid = null;
    this.dragOverFolderId = null;
    this.dragOverChatId = null;
    this.dragOverChatPosition = null;
    this._clearChatDropIndicators();
    document.querySelectorAll('.co-chat-dragging').forEach(el => el.classList.remove('co-chat-dragging'));
  },

  _setChatDropIndicator(el, ctxid, position) {
    this._clearChatDropIndicators();
    this.dragOverChatId = ctxid;
    this.dragOverChatPosition = position;
    el.classList.add(position === 'before' ? 'co-drop-before' : 'co-drop-after');
  },

  _clearChatDropIndicator(el) {
    el.classList.remove('co-drop-before', 'co-drop-after');
  },

  _clearChatDropIndicators() {
    document.querySelectorAll('.co-drop-before, .co-drop-after').forEach(el => {
      el.classList.remove('co-drop-before', 'co-drop-after');
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

  async dropChatNearChat(draggedCtxid, targetCtxid, position = 'before') {
    const targetFolder = findFolderForChat(targetCtxid, this.tree?.folders || []);
    const draggedFolder = findFolderForChat(draggedCtxid, this.tree?.folders || []);
    const targetFolderId = targetFolder?.id || "";
    const draggedFolderId = draggedFolder?.id || "";

    // If the dragged chat is coming from another folder/unfiled, move it into the target container first.
    if (draggedFolderId !== targetFolderId) {
      await api("move_chat", { ctxid: draggedCtxid, folder_id: targetFolderId, position: null });
      await this.loadTree();
    }

    let ids = this.getFolderIds(targetFolderId).filter(id => id !== draggedCtxid);
    let index = ids.indexOf(targetCtxid);
    if (index < 0) index = ids.length;
    if (position === 'after') index += 1;
    ids.splice(index, 0, draggedCtxid);
    await this.reorderChats(targetFolderId, ids);
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
    if (!this._isInternalChatDrag(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.dataTransfer.dropEffect = "move";
    this._hideAttachmentOverlay();
    this.dragOverFolderId = folderId || "__orphans__";
  },

  dragLeaveFolder(ev, folderId = "") {
    if (!this._isInternalChatDrag(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
    const key = folderId || "__orphans__";
    if (this.dragOverFolderId === key) this.dragOverFolderId = null;
  },

  async dropOnFolder(ev, folderId = "") {
    if (!this._isInternalChatDrag(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
    const ctxid = ev.dataTransfer.getData(CHAT_DRAG_TYPE) || ev.dataTransfer.getData("text/plain") || this.draggedCtxid;
    this.dragOverFolderId = null;
    if (ctxid) await this.moveChat(ctxid, folderId);
    this._clearDragState();
  },
});
