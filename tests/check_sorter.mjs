import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "webui", "chat_organizer_store.js"), "utf8");
const start = source.indexOf("  _sortChatRows(items) {");
const end = source.indexOf("\n  },", start);
if (start < 0 || end < 0) throw new Error("Could not locate _sortChatRows in plugin source");

const method = source.slice(start, end + 5).trim().replace(/,$/, "");
const store = {
  _loadLocalVisibleOrder() { return []; },
  ["_sortChatRows"]: Function(`return ({${method}})._sortChatRows`)(),
};

function assertIds(label, items, expected) {
  const actual = store._sortChatRows(items).map((item) => item.id);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
  console.log(`PASS: ${label}`);
}

store.tree = { visible_order: [] };
assertIds("native order without a saved order", [{ id: "new2" }, { id: "new1" }], ["new2", "new1"]);
store.tree = { visible_order: ["oldA", "oldB"] };
assertIds("one new chat precedes saved chats", [{ id: "new" }, { id: "oldB" }, { id: "oldA" }], ["new", "oldA", "oldB"]);
assertIds("multiple new chats retain native newest-first order", [{ id: "new2" }, { id: "oldB" }, { id: "new1" }, { id: "oldA" }], ["new2", "new1", "oldA", "oldB"]);
console.log("All sorter behavior checks passed.");
