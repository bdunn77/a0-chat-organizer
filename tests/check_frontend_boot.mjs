import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new Error(message);
}

function pass(message) {
  console.log(`PASS: ${message}`);
}

function require(condition, message) {
  if (!condition) fail(message);
  pass(message);
}

// Minimal DOM so the store's boot/filter code can run outside a browser. This is
// a logic harness for plugin behaviour, not a full HTML engine.
class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...c) { c.forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    if (force === undefined) { this.set.has(c) ? this.set.delete(c) : this.set.add(c); }
    else if (force) this.set.add(c);
    else this.set.delete(c);
    return this.set.has(c);
  }
}

class FakeEl {
  constructor(tag, cls = [], attrs = {}) {
    this.tag = tag;
    this.classList = new FakeClassList();
    cls.forEach((c) => this.classList.add(c));
    this.attrs = { ...attrs };
    this.style = {};
    this.children = [];
    this.parent = null;
  }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  removeAttribute(n) { delete this.attrs[n]; }
  get offsetParent() { return this.attrs["data-hidden"] ? null : {}; }
  closest(sel) {
    const name = sel.trim();
    let node = this;
    while (node) {
      if ((name.startsWith(".") && node.classList.contains(name.slice(1))) || node.tag === name) return node;
      node = node.parent;
    }
    return null;
  }
  querySelector(sel) { return queryAll(this, sel)[0] || null; }
  querySelectorAll(sel) { return queryAll(this, sel); }
}

function descendants(el) {
  const out = [];
  const walk = (n) => { for (const c of n.children) { out.push(c); walk(c); } };
  walk(el);
  return out;
}

function matchesSimple(el, token) {
  const t = token.trim();
  if (!t || t === ":scope") return false;
  if (t.startsWith(".")) return t.slice(1).split(".").every((c) => el.classList.contains(c));
  return el.tag === t;
}

function matchesChain(el, selector) {
  const parts = selector.trim().split(">").map((s) => s.trim());
  if (!matchesSimple(el, parts[parts.length - 1])) return false;
  let node = el.parent;
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    if (!matchesSimple(node, parts[i])) return false;
    node = node.parent;
  }
  return true;
}

function collectChain(node, parts, out) {
  if (!matchesSimple(node, parts[0])) return;
  if (parts.length === 1) { out.add(node); return; }
  for (const c of node.children) collectChain(c, parts.slice(1), out);
}

function queryAll(scope, selector) {
  const out = new Set();
  for (const raw of selector.split(",")) {
    const sel = raw.trim();
    if (sel.startsWith(":scope >")) {
      const parts = sel.slice(":scope >".length).trim().split(">").map((s) => s.trim());
      for (const child of scope.children) collectChain(child, parts, out);
    } else {
      for (const el of descendants(scope)) if (matchesChain(el, sel)) out.add(el);
    }
  }
  return [...out];
}

function buildDom() {
  const list = new FakeEl("ul", ["config-list", "chats-config-list"]);
  const treeItem = new FakeEl("li", ["chat-tree-item"]);
  const parentRow = new FakeEl("div", ["chat-container"], { "data-ctxid": "parent" });
  const childList = new FakeEl("ul", ["chat-child-list"]);
  const childLi = new FakeEl("li");
  const childRow = new FakeEl("div", ["chat-container"], { "data-ctxid": "child" });

  list.children.push(treeItem);
  treeItem.parent = list;
  treeItem.children.push(parentRow, childList);
  parentRow.parent = treeItem;
  childList.parent = treeItem;
  childList.children.push(childLi);
  childLi.parent = childList;
  childLi.children.push(childRow);
  childRow.parent = childLi;

  return { list, treeItem, parentRow, childList, childLi, childRow };
}

function installGlobals(dom, chatsStore) {
  globalThis.Alpine = { store: (name) => (name === "chats" ? chatsStore : undefined) };
  globalThis.window = globalThis;
  globalThis.localStorage = {
    _d: new Map(),
    getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
    setItem(k, v) { this._d.set(k, String(v)); },
    removeItem(k) { this._d.delete(k); },
  };
  globalThis.document = {
    body: new FakeEl("body"),
    querySelector: (sel) => (sel === ".chats-config-list" ? dom.list : null),
    querySelectorAll: (sel) => (sel === ".chats-config-list" ? [dom.list] : []),
  };
}

async function loadStore() {
  const source = fs.readFileSync(path.join(root, "webui", "chat_organizer_store.js"), "utf8");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "co-frontend-"));
  fs.mkdirSync(path.join(tmp, "stubs"));

  fs.writeFileSync(path.join(tmp, "stubs", "AlpineStore.js"),
    "export function createStore(name, initialState) { return initialState; }\n");
  fs.writeFileSync(path.join(tmp, "stubs", "api.js"),
    "export async function callJsonApi(endpoint, data) { globalThis.__coApiCalls.push({ endpoint, data }); return { folders: [], orphan_order: [], visible_order: [] }; }\n");
  fs.writeFileSync(path.join(tmp, "stubs", "notification-store.js"),
    "export function toastFrontendError() {}\nexport function toastFrontendSuccess() {}\nexport function toastFrontendInfo() {}\n");
  fs.writeFileSync(path.join(tmp, "stubs", "sidebar-store.js"),
    "export const store = { registered: [], registerRowListExtension(kind, name, extension) { this.registered.push({ kind, name, extension }); } };\n");

  const rewritten = source
    .replace('from "/js/AlpineStore.js"', 'from "./stubs/AlpineStore.js"')
    .replace('from "/js/api.js"', 'from "./stubs/api.js"')
    .replace('from "/components/notifications/notification-store.js"', 'from "./stubs/notification-store.js"')
    .replace('from "/components/sidebar/sidebar-store.js"', 'from "./stubs/sidebar-store.js"');
  if (rewritten === source) fail("store import specifiers were not rewritten; core imports changed");

  const modulePath = path.join(tmp, "chat_organizer_store.mjs");
  fs.writeFileSync(modulePath, rewritten);
  const mod = await import(pathToFileURL(modulePath).href);
  const sidebar = await import(pathToFileURL(path.join(tmp, "stubs", "sidebar-store.js")).href);
  return { store: mod.store, sidebarStore: sidebar.store, tmp };
}

async function main() {
  globalThis.__coApiCalls = [];
  const dom = buildDom();
  const chatsStore = { contexts: [{ id: "parent" }, { id: "child" }], topLevelContexts: () => [{ id: "parent" }], childContexts: () => [{ id: "child" }] };
  installGlobals(dom, chatsStore);

  const { store, sidebarStore, tmp } = await loadStore();

  const methods = ["init", "onOpen", "cleanup", "setFilter", "clearFilter", "showCreateFolder", "finishCreateFolder", "cancelCreateFolder", "_applyFilter", "_registerSorter"];
  require(methods.every((m) => typeof store[m] === "function"), "store module boots with its public API intact");

  store.init();
  require(sidebarStore.registered.some((r) => r.kind === "chat" && r.name === "chat_organizer"), "init registers the chat row-list sorter");

  const sorter = sidebarStore.registered.find((r) => r.kind === "chat").extension.sort;
  store.tree = { folders: [], orphan_order: [], visible_order: ["b", "a"] };
  require(JSON.stringify(sorter([{ id: "a" }, { id: "b" }]).map((c) => c.id)) === JSON.stringify(["b", "a"]), "registered sorter applies the saved order");

  // Defensive boot: a future Agent Zero that drops the extension API must not
  // take the whole folder panel down with it.
  store._sortRegistered = false;
  const originalRegister = sidebarStore.registerRowListExtension;
  delete sidebarStore.registerRowListExtension;
  let threw = false;
  try { store._registerSorter(); } catch (_e) { threw = true; }
  require(!threw, "missing sidebar extension API degrades safely instead of throwing");
  sidebarStore.registerRowListExtension = originalRegister;
  store._sortRegistered = false;
  store._registerSorter();
  require(store._sortRegistered === true, "sorter registration recovers when the API returns");

  store.showCreateFolder(null);
  require(store.creatingFolder === true && store.createParentId === null, "New Folder opens the inline create state");
  store.cancelCreateFolder();
  require(store.creatingFolder === false && store.createValue === "", "cancelling the inline create state resets it");

  globalThis.__coApiCalls.length = 0;
  store.showCreateFolder(null);
  store.createValue = "Work";
  await store.finishCreateFolder();
  const createCall = globalThis.__coApiCalls.find((c) => c.data.action === "create_folder");
  require(createCall && createCall.data.name === "Work", "finishing the inline create calls create_folder with the typed name");
  require(store.creatingFolder === false, "create state closes after submitting");

  // Regression guard: inside a folder filter, a visible parent chat must keep
  // Alpine's own expand/collapse; only orphaned children may be force-opened.
  chatsStore.contexts = [{ id: "parent" }, { id: "child" }];
  store.tree = { folders: [{ id: "f1", name: "F", chat_ids: ["child"], children: [] }], orphan_order: [], visible_order: [] };
  store.activeFilter = "f1";
  store._applyFilter();
  require(dom.childList.classList.contains("co-filter-forced-open"), "leftover child stays visible when its parent is outside the folder");

  chatsStore.contexts = [{ id: "parent" }, { id: "child" }];
  store.tree = { folders: [{ id: "f1", name: "F", chat_ids: ["parent", "child"], children: [] }], orphan_order: [], visible_order: [] };
  store._applyFilter();
  require(!dom.childList.classList.contains("co-filter-forced-open"), "a visible parent chat keeps its own collapse state in a folder");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("All Chat Organizer frontend boot checks passed.");
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => { console.error(`FAIL: ${error.message}`); process.exit(1); });
