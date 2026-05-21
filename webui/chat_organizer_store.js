import { createStore } from "/js/AlpineStore.js";
import { callJsonApi } from "/js/api.js";
import { toastFrontendError, toastFrontendSuccess, toastFrontendInfo } from "/components/notifications/notification-store.js";

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
  pointerDrag: null,
  dragGhost: null,
  dropMarker: null,
  suppressClickOnce: false,
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
    this._cleanupPointerDragUI();
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
      if (folderId) {
        await api("reorder", { folder_id: folderId, ctxids });
      } else {
        // Unfiled list: persist via set_orphan_order so the tree.json keeps the
        // explicit order even though it is not a folder.
        await api("set_orphan_order", { ctxids });
      }
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
    // Apply saved order to the default chat list so reordering in the sidebar
    // visually persists. Critically, this does NOT change folder membership —
    // it only reorders chats within their existing containers.
    //
    // Order strategy: orphan_order first (the visible "top" of the sidebar),
    // then folder chats in their folder order. Untracked/new chats keep their
    // native position at the end.
    const chats = this.getChatsStore();
    if (!chats?.contexts?.length || !this.tree) return;

    const current = chats.contexts;
    const byId = new Map(current.map(ctx => [ctx.id, ctx]));
    const used = new Set();
    const ordered = [];

    // Orphan chats first (in saved orphan_order)
    for (const id of this.getOrphanIds()) {
      if (byId.has(id) && !used.has(id)) {
        ordered.push(byId.get(id));
        used.add(id);
      }
    }

    // Then folder chats in folder order (preserves user-defined folder grouping)
    const pushFolder = (folder) => {
      for (const id of folder.chat_ids || []) {
        if (byId.has(id) && !used.has(id)) {
          ordered.push(byId.get(id));
          used.add(id);
        }
      }
      for (const child of folder.children || []) pushFolder(child);
    };
    for (const folder of this.tree?.folders || []) pushFolder(folder);

    // Anything not yet placed (brand-new chats, untracked) keeps native order
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

      // Use custom pointer-drag instead of native HTML drag/drop. This avoids the
      // Agent Zero file-drop overlay and gives us smoother, production-grade UX.
      el.setAttribute('draggable', 'false');
      el.classList.add('co-chat-draggable');

      el.addEventListener('pointerdown', function(ev) {
        self._startPointerDrag(ev, el);
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
      el.setAttribute('draggable', 'false');
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

  // ── Smooth pointer-drag UX for moving/reordering chats ──
  _startPointerDrag(ev, el) {
    if (ev.button !== 0) return;
    if (ev.target.closest('button, input, textarea, select, a, .dropdown, .co-context-menu')) return;
    const ctxid = el.getAttribute('data-ctxid');
    if (!ctxid) return;

    this.pointerDrag = {
      ctxid,
      sourceEl: el,
      startX: ev.clientX,
      startY: ev.clientY,
      x: ev.clientX,
      y: ev.clientY,
      active: false,
      targetCtxid: null,
      targetPosition: null,
      targetFolderId: null,
    };

    this._boundPointerMove = this._boundPointerMove || ((e) => this._onPointerMove(e));
    this._boundPointerUp = this._boundPointerUp || ((e) => this._onPointerUp(e));
    this._boundKey = this._boundKey || ((e) => { if (e.key === 'Escape') this._abortPointerDrag(); });
    document.addEventListener('pointermove', this._boundPointerMove, true);
    document.addEventListener('pointerup', this._boundPointerUp, true);
    document.addEventListener('pointercancel', this._boundPointerUp, true);
    document.addEventListener('keydown', this._boundKey, true);
  },

  _abortPointerDrag() {
    if (!this.pointerDrag) return;
    this.pointerDrag = null;
    document.removeEventListener('pointermove', this._boundPointerMove, true);
    document.removeEventListener('pointerup', this._boundPointerUp, true);
    document.removeEventListener('pointercancel', this._boundPointerUp, true);
    document.removeEventListener('keydown', this._boundKey, true);
    this._cleanupPointerDragUI();
  },

  _onPointerMove(ev) {
    const drag = this.pointerDrag;
    if (!drag) return;

    const dx = ev.clientX - drag.startX;
    const dy = ev.clientY - drag.startY;
    if (!drag.active && Math.hypot(dx, dy) < 7) return;

    ev.preventDefault();
    ev.stopPropagation();
    if (!drag.active) this._beginPointerDrag(ev);

    drag.x = ev.clientX;
    drag.y = ev.clientY;
    this._moveGhost(ev.clientX, ev.clientY);
    this._updatePointerDropTarget(ev.clientX, ev.clientY);
    this._maybeAutoScroll(ev.clientY);
  },

  _maybeAutoScroll(y) {
    const list = document.querySelector('.chats-config-list');
    if (!list) return;
    const rect = list.getBoundingClientRect();
    const zone = 38;
    const speed = 18;
    if (y < rect.top + zone) list.scrollTop -= speed;
    else if (y > rect.bottom - zone) list.scrollTop += speed;
  },

  async _onPointerUp(ev) {
    const drag = this.pointerDrag;
    if (!drag) return;

    document.removeEventListener('pointermove', this._boundPointerMove, true);
    document.removeEventListener('pointerup', this._boundPointerUp, true);
    document.removeEventListener('pointercancel', this._boundPointerUp, true);
    document.removeEventListener('keydown', this._boundKey, true);

    if (drag.active) {
      ev.preventDefault();
      ev.stopPropagation();
      this.suppressClickOnce = true;
      setTimeout(() => { this.suppressClickOnce = false; }, 80);

      if (drag.targetCtxid && drag.targetCtxid !== drag.ctxid) {
        await this.dropChatNearChat(drag.ctxid, drag.targetCtxid, drag.targetPosition || 'before');
      } else if (drag.targetFolderId !== null && drag.targetFolderId !== undefined) {
        await this.moveChat(drag.ctxid, drag.targetFolderId || '');
      }
    }

    this._cleanupPointerDragUI();
  },

  _beginPointerDrag(ev) {
    const drag = this.pointerDrag;
    if (!drag) return;
    drag.active = true;
    this.draggedCtxid = drag.ctxid;
    window.__chatOrganizerDraggingChat = true;
    this._patchAttachmentOverlay();
    this._hideAttachmentOverlay();
    drag.sourceEl.classList.add('co-chat-dragging');
    document.body.classList.add('co-chat-organizer-drag-active');
    this._ensureGhost(this._getChatTitle(drag.ctxid));
    this._moveGhost(ev.clientX, ev.clientY);
  },

  _updatePointerDropTarget(x, y) {
    const drag = this.pointerDrag;
    if (!drag?.active) return;

    const ghost = this.dragGhost;
    const marker = this.dropMarker;
    if (ghost) ghost.style.pointerEvents = 'none';
    if (marker) marker.style.pointerEvents = 'none';

    const el = document.elementFromPoint(x, y);
    this._clearFolderPointerTargets();
    this._hideDropMarker();
    drag.targetCtxid = null;
    drag.targetPosition = null;
    drag.targetFolderId = null;

    const folderEl = el?.closest?.('.chat-organizer-root .co-folder-row, .chat-organizer-root .co-filter-row[data-co-folder-drop="true"]');
    if (folderEl) {
      const folderId = folderEl.getAttribute('data-folder-id') || '';
      drag.targetFolderId = folderId;
      folderEl.classList.add('co-pointer-drop-target');
      return;
    }

    const chatEl = el?.closest?.('.chats-config-list .chat-container');
    if (chatEl) {
      const targetCtxid = chatEl.getAttribute('data-ctxid');
      if (targetCtxid && targetCtxid !== drag.ctxid) {
        const rect = chatEl.getBoundingClientRect();
        const position = y < rect.top + rect.height / 2 ? 'before' : 'after';
        drag.targetCtxid = targetCtxid;
        drag.targetPosition = position;
        this._showDropMarker(rect, position);
      }
    }
  },

  _getChatTitle(ctxid) {
    const ctx = this.getAllChats().find(c => c.id === ctxid);
    if (!ctx) return 'Moving chat';
    return ctx.name || `Chat #${ctx.no || ''}`.trim();
  },

  _ensureGhost(text) {
    if (!this.dragGhost) {
      this.dragGhost = document.createElement('div');
      this.dragGhost.className = 'co-drag-ghost';
      document.body.appendChild(this.dragGhost);
    }
    this.dragGhost.textContent = text;
  },

  _moveGhost(x, y) {
    if (!this.dragGhost) return;
    this.dragGhost.style.transform = `translate3d(${x + 14}px, ${y + 12}px, 0)`;
  },

  _ensureDropMarker() {
    if (!this.dropMarker) {
      this.dropMarker = document.createElement('div');
      this.dropMarker.className = 'co-insert-marker';
      document.body.appendChild(this.dropMarker);
    }
  },

  _showDropMarker(rect, position) {
    this._ensureDropMarker();
    const y = position === 'before' ? rect.top : rect.bottom;
    this.dropMarker.style.display = 'block';
    this.dropMarker.style.left = `${rect.left + 8}px`;
    this.dropMarker.style.top = `${y - 2}px`;
    this.dropMarker.style.width = `${Math.max(32, rect.width - 16)}px`;
  },

  _hideDropMarker() {
    if (this.dropMarker) this.dropMarker.style.display = 'none';
  },

  _clearFolderPointerTargets() {
    document.querySelectorAll('.co-pointer-drop-target').forEach(el => el.classList.remove('co-pointer-drop-target'));
  },

  _cleanupPointerDragUI() {
    window.__chatOrganizerDraggingChat = false;
    this.pointerDrag = null;
    this.draggedCtxid = null;
    this.dragOverFolderId = null;
    this.dragOverChatId = null;
    this.dragOverChatPosition = null;
    this._clearChatDropIndicators();
    this._clearFolderPointerTargets();
    this._hideDropMarker();
    document.querySelectorAll('.co-chat-dragging').forEach(el => el.classList.remove('co-chat-dragging'));
    document.body.classList.remove('co-chat-organizer-drag-active');
    if (this.dragGhost) {
      this.dragGhost.remove();
      this.dragGhost = null;
    }
    if (this.dropMarker) {
      this.dropMarker.remove();
      this.dropMarker = null;
    }
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
    // Reorder rules:
    //   - Drop above/below a chat in the SAME container -> reorder within that container.
    //   - Drop above/below a chat in a DIFFERENT container -> blocked (folder
    //     membership only changes via explicit folder drop or right-click menu).
    //   - This works in any view (All Chats, Unfiled, or a specific folder).
    const targetFolder = findFolderForChat(targetCtxid, this.tree?.folders || []);
    const draggedFolder = findFolderForChat(draggedCtxid, this.tree?.folders || []);
    const targetFolderId = targetFolder?.id || "";
    const draggedFolderId = draggedFolder?.id || "";

    if (draggedFolderId !== targetFolderId) {
      // Cross-container: do not silently move folder membership.
      if (typeof toastFrontendInfo === 'function') {
        toastFrontendInfo("Drop on a folder row to move the chat to a folder.", "Chat Organizer");
      }
      return;
    }

    // Same container: reorder.
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
