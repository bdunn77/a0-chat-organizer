import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "webui", "chat_organizer_store.js"), "utf8");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Could not locate ${name}`);
  let depth = 0;
  let started = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") {
      depth += 1;
      started = true;
    } else if (ch === "}") {
      depth -= 1;
      if (started && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Could not extract ${name}`);
}

const helpers = [
  extractFunction("walkFolders"),
  extractFunction("collectAssignedIds"),
  extractFunction("isTopLevelChat"),
  extractFunction("countableChatIds"),
  extractFunction("countTotalChats"),
  extractFunction("countUnfiledChats"),
].join("\n\n");

const {
  countableChatIds,
  countTotalChats,
  countUnfiledChats,
} = Function(`${helpers}\nreturn { countableChatIds, countTotalChats, countUnfiledChats };`)();

function assertEqual(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
  console.log(`PASS: ${label}`);
}

const chats = [
  { id: "parent-a" },
  { id: "child-a", parent_context_id: "parent-a" },
  { id: "orphan-child", parent_context_id: "deleted-parent" },
  { id: "parent-b" },
  { id: "filed-child", parent_context_id: "parent-b" },
];

const folders = [
  {
    id: "folder-1",
    chat_ids: ["parent-a", "child-a", "orphan-child"],
    children: [
      { id: "folder-2", chat_ids: ["filed-child"], children: [] },
    ],
  },
];

assertEqual("all chats ignore nested and leftover child contexts", countableChatIds(chats).size, 2);
assertEqual("folder count ignores nested children even if they are filed", countTotalChats(folders[0], countableChatIds(chats)), 1);
assertEqual("unfiled count is remaining top-level chats", countUnfiledChats(chats, folders), 1);
assertEqual("stale stored IDs do not inflate folder counts", countTotalChats({
  chat_ids: ["parent-a", "deleted-chat", "child-a"],
  children: [],
}, countableChatIds(chats)), 1);

console.log("All chat counting checks passed.");
