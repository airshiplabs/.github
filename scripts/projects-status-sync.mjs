// Projects status sync: adds every issue and PR on the source projects to the
// roll-up project, and copies each item's Status (source projects are never
// written). No dependencies; Node 18+.
//
// Env: GITHUB_TOKEN (required), ROLLUP_PROJECT_NUMBER, SOURCE_PROJECT_NUMBERS
// (comma-separated, earlier wins if an item is on several), DRY_RUN=true to
// only read and log what would change.
//
// Logs are counts only: this runs in a public repo, so it never prints titles.

const ORG = process.env.ORG || "airshiplabs";
const ROLLUP = Number(process.env.ROLLUP_PROJECT_NUMBER);
const SOURCES = (process.env.SOURCE_PROJECT_NUMBERS || "").split(",").map(Number).filter(Boolean);
const DRY_RUN = process.env.DRY_RUN === "true";
const TOKEN = process.env.GITHUB_TOKEN;
const ROLLUP_STATUSES = ["Todo", "In Progress", "Done"]; // anything else maps to Todo

if (!TOKEN || !ROLLUP || SOURCES.length === 0) {
  throw new Error("GITHUB_TOKEN, ROLLUP_PROJECT_NUMBER and SOURCE_PROJECT_NUMBERS are required");
}

async function gql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) throw new Error(`GraphQL ${res.status}: ${JSON.stringify(body.errors ?? body)}`);
  return body.data;
}

const ITEMS = `query($org: String!, $number: Int!, $after: String) {
  organization(login: $org) { projectV2(number: $number) {
    id
    field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } }
    items(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id type isArchived
        content { ... on Issue { id } ... on PullRequest { id } }
        fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
      }
    }
  } }
}`;

async function loadProject(number) {
  let project, after = null;
  const items = [];
  do {
    const p = (await gql(ITEMS, { org: ORG, number, after })).organization.projectV2;
    if (!p) throw new Error(`Project #${number} not found or not accessible`);
    project = p;
    items.push(...p.items.nodes);
    after = p.items.pageInfo.hasNextPage ? p.items.pageInfo.endCursor : null;
  } while (after);
  return { id: project.id, field: project.field, items };
}

// Source Status name -> roll-up Status name (case-insensitive; else Todo).
function mapStatus(name) {
  const match = ROLLUP_STATUSES.find((s) => s.toLowerCase() === (name || "").trim().toLowerCase());
  return match || "Todo";
}

const stats = { added: 0, statusChanged: 0, unchanged: 0, draftsSkipped: 0, noAccessSkipped: 0, archivedSkipped: 0, onSeveralProjects: 0 };

// 1. Desired Status per issue/PR, from the source projects (read-only).
const desired = new Map(); // content id -> roll-up Status name
for (const number of SOURCES) {
  const { items } = await loadProject(number);
  for (const item of items) {
    if (item.type === "DRAFT_ISSUE") { stats.draftsSkipped++; continue; }
    if (!item.content?.id) { stats.noAccessSkipped++; continue; } // REDACTED: token can't see the repo
    if (desired.has(item.content.id)) { stats.onSeveralProjects++; continue; }
    desired.set(item.content.id, mapStatus(item.fieldValueByName?.name));
  }
  console.log(`Source project #${number}: ${items.length} items`);
}

// 2. Current roll-up state.
const rollup = await loadProject(ROLLUP);
const optionId = Object.fromEntries((rollup.field?.options || []).map((o) => [o.name, o.id]));
for (const s of ROLLUP_STATUSES) {
  if (!optionId[s]) throw new Error(`Roll-up project #${ROLLUP} has no Status option "${s}"`);
}
const current = new Map(); // content id -> { itemId, status, isArchived }
for (const item of rollup.items) {
  if (item.content?.id) current.set(item.content.id, { itemId: item.id, status: item.fieldValueByName?.name ?? null, isArchived: item.isArchived });
}
console.log(`Roll-up project #${ROLLUP}: ${rollup.items.length} items`);

// 3. Add missing items, then set Status only where it differs.
const ADD = `mutation($project: ID!, $content: ID!) {
  addProjectV2ItemById(input: { projectId: $project, contentId: $content }) {
    item { id isArchived fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } }
  }
}`;
const SET = `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } }
}`;

for (const [contentId, status] of desired) {
  let target = current.get(contentId);
  if (!target) {
    stats.added++;
    if (DRY_RUN) { stats.statusChanged++; continue; }
    const item = (await gql(ADD, { project: rollup.id, content: contentId })).addProjectV2ItemById.item;
    target = { itemId: item.id, status: item.fieldValueByName?.name ?? null, isArchived: item.isArchived };
  }
  if (target.isArchived) { stats.archivedSkipped++; continue; }
  if (target.status === status) { stats.unchanged++; continue; }
  stats.statusChanged++;
  if (!DRY_RUN) await gql(SET, { project: rollup.id, item: target.itemId, field: rollup.field.id, option: optionId[status] });
}

console.log(`${DRY_RUN ? "DRY RUN (nothing written): would have " : ""}added ${stats.added}, statuses changed ${stats.statusChanged}, drafts skipped ${stats.draftsSkipped}`);
console.log(`Also: unchanged ${stats.unchanged}, not accessible ${stats.noAccessSkipped}, archived in roll-up ${stats.archivedSkipped}, on several source projects ${stats.onSeveralProjects}`);
