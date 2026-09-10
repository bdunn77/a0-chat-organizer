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
  extractFunction("strandedChatIds"),
  extractFunction("collectDescendantChatIds"),
  extractFunction("collectRootChatId"),
  extractFunction("collectFamilyChatIds"),
  extractFunction("findFolderForChat"),
  extractFunction("removeChatFromFolders"),
  extractFunction("syncFamilyMembership"),
].join("\n\n");

const {
  countableChatIds,
  countTotalChats,
  countUnfiledChats,
  strandedChatIds,
  collectDescendantChatIds,
  collectFamilyChatIds,
  syncFamilyMembership,
} = Function(`${helpers}\nreturn { countableChatIds, countTotalChats, countUnfiledChats, strandedChatIds, collectDescendantChatIds, collectFamilyChatIds, syncFamilyMembership };`)();

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

const liveIds = new Set(chats.map((ctx) => ctx.id));
assertEqual("all chats ignore nested and leftover child contexts", countableChatIds(chats).size, 2);
assertEqual("folder count keeps live assigned chats including leftover children", countTotalChats(folders[0], liveIds), 4);
assertEqual("unfiled count is remaining top-level chats", countUnfiledChats(chats, folders), 1);
assertEqual("stale stored IDs do not inflate folder counts", countTotalChats({
  chat_ids: ["parent-a", "deleted-chat", "child-a"],
  children: [],
}, liveIds), 2);
assertEqual(
  "folder filter promotes leftover children of deleted parents",
  strandedChatIds(chats, ["parent-a", "child-a", "orphan-child", "filed-child"]).join(","),
  "orphan-child",
);
assertEqual(
  "nested children of live parents stay nested",
  strandedChatIds(chats, ["child-a", "filed-child"]).join(","),
  "",
);
assertEqual(
  "parent delete collects descendants only",
  collectDescendantChatIds("parent-a", chats).join(","),
  "child-a",
);
assertEqual(
  "child delete does not include the parent",
  collectDescendantChatIds("child-a", chats).join(","),
  "",
);
assertEqual(
  "filing a child includes its live parent and descendants",
  collectFamilyChatIds("child-a", chats.concat([{ id: "grandchild-a", parent_context_id: "child-a" }])).join(","),
  "parent-a,child-a,grandchild-a",
);
assertEqual(
  "filing a parent includes its children",
  collectFamilyChatIds("parent-b", chats).join(","),
  "parent-b,filed-child",
);
{
  const familyFolders = [
    { id: "folder-a", chat_ids: ["child-a"], children: [] },
    { id: "folder-b", chat_ids: [], children: [] },
  ];
  syncFamilyMembership(familyFolders, chats);
  assertEqual(
    "filing a child also files its parent in the same folder",
    familyFolders[0].chat_ids.join(","),
    "child-a,parent-a",
  );
}
{
  const familyFolders = [
    { id: "folder-a", chat_ids: ["parent-b"], children: [] },
  ];
  syncFamilyMembership(familyFolders, chats);
  assertEqual(
    "filing a parent also files its children in the same folder",
    familyFolders[0].chat_ids.join(","),
    "parent-b,filed-child",
  );
}
{
  const familyFolders = [
    { id: "folder-a", chat_ids: ["parent-a"], children: [] },
  ];
  syncFamilyMembership(familyFolders, chats);
  assertEqual(
    "unrelated chats stay out of a family folder",
    familyFolders[0].chat_ids.join(","),
    "parent-a,child-a",
  );
}

console.log("All chat counting checks passed.");
