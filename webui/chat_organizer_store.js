import { createStore } from "/js/AlpineStore.js";
import { callJsonApi } from "/js/api.js";
import { toastFrontendError, toastFrontendSuccess, toastFrontendInfo } from "/components/notifications/notification-store.js";

const PLUGIN = "chat_organizer";
const CHAT_DRAG_TYPE = "application/x-chat-organizer-ctxid";
const VISIBLE_ORDER_KEY = "chat_organizer.visible_order.v1";
const EXPANDED_KEY = "chat_organizer.expanded.v1";
const PANEL_HEIGHT_KEY = "chat_organizer.panel_height.v1";

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

function collectFolderChatIds(folder, out = []) {
  for (const id of folder?.chat_ids || []) out.push(id);
  for (const child of folder?.children || []) collectFolderChatIds(child, out);
  return out;
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
  panelHeight: null,
  activeFilter: null,
  draggedCtxid: null,
  dragOverFolderId: null,
  dragOverChatId: null,
  dragOverChatPosition: null,
  pointerDrag: null,
  dragGhost: null,
  dropMarker: null,
  suppressClickOnce: false,
  _active: false,
  _attachmentOverlayPatched: false,

  init() {
    if (!this.tree) this.loadTree();
  },

  onOpen() {
    this._active = true;
    this.loadTree();
    this._startObserver();
    this._restorePanelHeight();
  },

  cleanup() {
    this._active = false;
    this.contextMenu = null;
    this.chatContextMenu = null;
    this.draggedCtxid = null;
    this.dragOverFolderId = null;
    this.dragOverChatId = null;
    this.dragOverChatPosition = null;
    this._abortPointerDrag();
    this._hideAttachmentOverlay();
    this._stopObserver();
    this._clearFilter();
    this._removeChatInteractions();
  },

  // ── Resizable folder panel divider ──
  _loadPanelHeight() {
    try {
      const raw = localStorage.getItem(PANEL_HEIGHT_KEY);
      const value = raw ? parseFloat(raw) : NaN;
      return Number.isFinite(value) && value >= 40 ? value : null;
    } catch (_e) {
      return null;
    }
  },

  _savePanelHeight(height) {
    try {
      localStorage.setItem(PANEL_HEIGHT_KEY, String(Math.round(height)));
    } catch (_e) {
      // localStorage unavailable; resize still works for this session.
    }
  },

  _applyPanelHeight() {
    const root = document.querySelector('.chat-organizer-root');
    if (!root) return;
    if (this.panelHeight && this.panelHeight >= 40) {
      root.style.height = this.panelHeight + 'px';
      root.style.maxHeight = 'none';
    }
  },

  _restorePanelHeight() {
    const saved = this._loadPanelHeight();
    if (!saved) return;
    this.panelHeight = saved;
    // Defer DOM mutation in case x-init fires before the element is in the DOM tree.
    setTimeout(() => this._applyPanelHeight(), 0);
  },

  _resetPanelHeight() {
    this.panelHeight = null;
    try { localStorage.removeItem(PANEL_HEIGHT_KEY); } catch (_e) {}
    const root = document.querySelector('.chat-organizer-root');
    if (root) {
      root.style.height = '';
      root.style.maxHeight = '';
    }
  },

  startPanelResize(ev) {
    if (!this._active) return;
    if (ev.button !== undefined && ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();

    const root = document.querySelector('.chat-organizer-root');
    if (!root) return;
    const handle = root.querySelector('.co-resize-handle');
    if (handle) handle.classList.add('co-resizing');
    document.body.classList.add('co-resizing-folder-panel');

    const startY = ev.clientY;
    const startHeight = root.getBoundingClientRect().height;
    const section = root.closest('#chats-section') || root.parentElement;
    const sectionRect = section ? section.getBoundingClientRect() : null;
    const minHeight = 60;
    // Leave at least ~140px for the chats header + visible chats below.
    const chatsReserve = 140;
    const maxHeight = sectionRect
      ? Math.max(minHeight + 60, sectionRect.height - chatsReserve)
      : 800;

    const onMove = (event) => {
      event.preventDefault();
      const dy = event.clientY - startY;
      const next = Math.max(minHeight, Math.min(maxHeight, startHeight + dy));
      root.style.height = next + 'px';
      root.style.maxHeight = 'none';
      this.panelHeight = next;
    };
    const onUp = (event) => {
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('pointercancel', onUp, true);
      if (handle) handle.classList.remove('co-resizing');
      document.body.classList.remove('co-resizing-folder-panel');
      if (this.panelHeight) this._savePanelHeight(this.panelHeight);
    };
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onUp, true);
  },

    _loadExpandedState() {
    try {
      const raw = localStorage.getItem(EXPANDED_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (_e) {
      return null;
    }
  },

  _saveExpandedState() {
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify(this.expanded || {}));
    } catch (_e) {
      // localStorage unavailable/quota; expansion still works for this session.
    }
  },

  _defaultExpandedForFolders(folders, out = {}) {
    for (const folder of folders || []) {
      if ((folder.children || []).length > 0) out[folder.id] = true;
      this._defaultExpandedForFolders(folder.children || [], out);
    }
    return out;
  },

  _restoreOrDefaultExpanded() {
    const saved = this._loadExpandedState();
    if (saved) {
      // Keep only saved IDs that still exist in the current tree.
      const valid = new Set();
      walkFolders(this.tree?.folders || [], f => valid.add(f.id));
      const cleaned = {};
      for (const [id, value] of Object.entries(saved)) {
        if (valid.has(id)) cleaned[id] = !!value;
      }
      this.expanded = cleaned;
      this._saveExpandedState();
      return;
    }

    // First run / no saved state: make nested structure visible by default.
    this.expanded = this._defaultExpandedForFolders(this.tree?.folders || [], {});
    this._saveExpandedState();
  },

  async loadTree() {
    try {
      this.tree = await api("get_tree");
      this.tree.folders ||= [];
      this.tree.orphan_order ||= [];
      this.tree.visible_order ||= [];
      if (this.tree.visible_order.length === 0) {
        const localOrder = this._loadLocalVisibleOrder();
        if (localOrder.length > 0) this.tree.visible_order = localOrder;
      }
      this._restoreOrDefaultExpanded();
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
      const newFolderId = res?.folder?.id || null;

      // Reload first, then expand. Expanding before the fresh tree arrives can
      // fail visually for the first child folder because the x-for rows have not
      // been rebuilt yet. Expanding after loadTree guarantees the newly created
      // subfolder is visible immediately.
      await this.loadTree();
      if (parentId) this.expandFolderPath(parentId);
      if (newFolderId) {
        this.expanded = { ...this.expanded, [newFolderId]: true };
        this._saveExpandedState();
      }
      if (!parentId && newFolderId) this.expandFolderPath(newFolderId);

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

  expandFolderPath(folderId) {
    if (!folderId) return;
    const path = [];
    const findPath = (folders, targetId, acc = []) => {
      for (const folder of folders || []) {
        const next = [...acc, folder.id];
        if (folder.id === targetId) return next;
        const childPath = findPath(folder.children || [], targetId, next);
        if (childPath) return childPath;
      }
      return null;
    };
    const found = findPath(this.tree?.folders || [], folderId, []);
    if (found) {
      for (const id of found) path.push(id);
    } else {
      path.push(folderId);
    }
    const nextExpanded = { ...this.expanded };
    for (const id of path) nextExpanded[id] = true;
    this.expanded = nextExpanded;
    this._saveExpandedState();
  },

  toggleFolder(id) {
    this.expanded = { ...this.expanded, [id]: !this.expanded[id] };
    this._saveExpandedState();
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

  _loadLocalVisibleOrder() {
    try {
      const raw = localStorage.getItem(VISIBLE_ORDER_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    } catch (_e) {
      return [];
    }
  },

  _saveLocalVisibleOrder(ctxids) {
    try {
      localStorage.setItem(VISIBLE_ORDER_KEY, JSON.stringify((ctxids || []).filter(Boolean)));
    } catch (_e) {
      // localStorage unavailable/quota; backend persistence still attempted.
    }
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
    // visually persists. Folder membership is NEVER changed here.
    //
    // Strategy: if a unified visible_order is saved (from drag-reorder in the
    // sidebar), use it directly. Otherwise fall back to: orphan_order first,
    // then folder chats in folder order. Untracked/new chats are appended.
    const chats = this.getChatsStore();
    if (!chats?.contexts?.length || !this.tree) return;

    const current = chats.contexts;
    const byId = new Map(current.map(ctx => [ctx.id, ctx]));
    const used = new Set();
    const ordered = [];

    const visibleOrder = (this.tree?.visible_order?.length ? this.tree.visible_order : this._loadLocalVisibleOrder()) || [];
    if (visibleOrder.length > 0) {
      // Use the unified saved order
      for (const id of visibleOrder) {
        if (byId.has(id) && !used.has(id)) {
          ordered.push(byId.get(id));
          used.add(id);
        }
      }
    } else {
      // Fallback: orphans first, then folder chats
      for (const id of this.getOrphanIds()) {
        if (byId.has(id) && !used.has(id)) {
          ordered.push(byId.get(id));
          used.add(id);
        }
      }
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
    }

    // Anything not yet placed (brand-new chats) appended at end
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
    // "All Chats" view: show everything (clear styles on both li wrappers and chat-containers).
    if (!this.activeFilter && this.activeFilter !== "") {
      items.forEach(el => {
        el.style.display = '';
        const li = el.closest('li');
        if (li) li.style.display = '';
      });
      return;
    }
    // Filtered view (specific folder or Unfiled): hide non-matching items by their
    // parent <li> wrapper so hidden rows do not leave empty space in the sidebar.
    const folder = this.activeFilter ? findFolder(this.activeFilter, this.tree?.folders || []) : null;
    // Parent folders show every chat contained anywhere inside that folder tree,
    // including chats in child/grandchild folders. This is filtering only; it
    // does not change folder membership or direct folder chat_ids.
    const visibleIds = folder ? new Set(collectFolderChatIds(folder)) : new Set(this.getOrphanIds());
    items.forEach(el => {
      const ctxid = el.getAttribute('data-ctxid');
      const visible = visibleIds.has(ctxid);
      el.style.display = visible ? '' : 'none';
      const li = el.closest('li');
      if (li) li.style.display = visible ? '' : 'none';
    });
  },

  _clearFilter() {
    const list = document.querySelector('.chats-config-list');
    if (!list) return;
    list.querySelectorAll('.chat-container').forEach(el => {
      el.style.display = '';
      const li = el.closest('li');
      if (li) li.style.display = '';
    });
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
        if (!self._active) return;
        self._startPointerDrag(ev, el);
      });

      // Prevent the synthetic click after a drag from selecting/opening the wrong chat.
      el.addEventListener('click', function(ev) {
        if (!self._active) return;
        if (self.suppressClickOnce) {
          ev.preventDefault();
          ev.stopPropagation();
          if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
        }
      }, true);

      // Right-click context menu on chat.
      el.addEventListener('contextmenu', function(ev) {
        if (!self._active) return;
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
      startTime: Date.now(),
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
    const distance = Math.hypot(dx, dy);
    const elapsed = Date.now() - (drag.startTime || 0);
    // Activate drag only when the user has clearly committed to it: either moved
    // a meaningful distance (10px) or held the pointer for 150ms with some movement.
    // This prevents normal clicks with slight pointer drift from being treated as drags.
    if (!drag.active) {
      const shouldActivate = distance >= 10 || (elapsed >= 150 && distance >= 4);
      if (!shouldActivate) return;
    }

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
      const hadAction = (drag.targetCtxid && drag.targetCtxid !== drag.ctxid) ||
                        (drag.targetFolderId !== null && drag.targetFolderId !== undefined);
      // Only suppress the upcoming synthetic click if we are actually committing
      // a drag action. If the user activated drag but released over nothing, let
      // the click pass through so they can still navigate normally.
      if (hadAction) {
        ev.preventDefault();
        ev.stopPropagation();
        this.suppressClickOnce = true;
        setTimeout(() => { this.suppressClickOnce = false; }, 120);
      }

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
    // Reorder by drag persists a unified visible_order so the dragged chat
    // moves to ITS EXACT visual position in the sidebar — regardless of which
    // containers (folder/unfiled) the dragged and target chats belong to.
    //
    // Folder membership is NEVER changed here. It only changes via explicit
    // folder-row drop or right-click chat context menu.
    const list = document.querySelector('.chats-config-list');
    if (!list) return;

    // Read the full current sidebar order from the Alpine chats store, not just
    // visible DOM rows. This preserves hidden rows when reordering inside a
    // folder/Unfiled filtered view and prevents incomplete visible_order saves.
    const targetEl = Array.from(list.querySelectorAll('.chat-container'))
      .find(el => el.getAttribute('data-ctxid') === targetCtxid);
    const targetLi = targetEl?.closest('li');
    if (!targetEl || targetEl.offsetParent === null || targetLi?.style.display === 'none') {
      if (typeof toastFrontendInfo === 'function') {
        toastFrontendInfo("Drop target not visible, nothing reordered.", "Chat Organizer");
      }
      return;
    }

    const allIds = this.getAllChats().map(ctx => ctx.id).filter(Boolean);

    // Remove dragged from current full order, then re-insert at drop point.
    const withoutDragged = allIds.filter(id => id !== draggedCtxid);
    let targetIndex = withoutDragged.indexOf(targetCtxid);
    if (targetIndex < 0) {
      if (typeof toastFrontendInfo === 'function') {
        toastFrontendInfo("Drop target not visible, nothing reordered.", "Chat Organizer");
      }
      return;
    }
    if (position === 'after') targetIndex += 1;
    const newVisibleOrder = [
      ...withoutDragged.slice(0, targetIndex),
      draggedCtxid,
      ...withoutDragged.slice(targetIndex),
    ];

    // Optimistically apply immediately so the row visibly moves even before
    // backend persistence completes (or before Agent Zero has restarted with
    // the latest backend handler). Folder membership unchanged.
    this.tree ||= { folders: [], orphan_order: [], visible_order: [] };
    this.tree.visible_order = newVisibleOrder;
    this._saveLocalVisibleOrder(newVisibleOrder);
    this._syncChatsStoreOrder();
    this._applyFilter();

    try {
      await api("set_visible_order", { ctxids: newVisibleOrder });
      // Reload server tree; loadTree preserves local fallback if the running
      // backend is old and does not yet return visible_order.
      await this.loadTree();
      toastFrontendSuccess("Chats reordered", "Chat Organizer");
    } catch (e) {
      console.warn("ChatOrganizer: server visible_order persistence failed; using local fallback until restart", e);
      if (typeof toastFrontendInfo === 'function') {
        toastFrontendInfo("Chats reordered locally. Restart Agent Zero to enable server-side persistence.", "Chat Organizer");
      } else {
        toastFrontendSuccess("Chats reordered", "Chat Organizer");
      }
    }
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
