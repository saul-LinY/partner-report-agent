import type { List, ListItem, Root, RootContent, Table } from "mdast";

type ProjectIdentity = {
  partnerId: string;
  partnerName: string;
  projectName: string;
};

function plain(node?: { value?: string; children?: unknown[] }): string {
  return (
    node?.value ??
    (node?.children ?? []).map((child) => plain(child as typeof node)).join("")
  );
}

function mergeOwners(table: Table, identities: ProjectIdentity[]) {
  const [header, ...rows] = table.children;
  const labels = header?.children.map(plain);
  if (
    !labels ||
    ![
      ["项目负责人", "项目名称", "较上周进展"],
      ["成员", "项目", "本周工作明细"],
    ].some((expected) =>
      expected.every((label, i) => labels[i]?.trim() === label),
    )
  )
    return;

  const groups = new Map<string, typeof rows>();
  rows.forEach((row, i) => {
    const name = plain(row.children[0]!).trim();
    const project = plain(row.children[1]!).trim();
    const ids = new Set(
      identities
        .filter(
          (item) => item.partnerName === name && item.projectName === project,
        )
        .map((item) => item.partnerId),
    );
    const key =
      ids.size === 1
        ? `id:${[...ids][0]}`
        : ids.size > 1 || !name || name === "-"
          ? `row:${i}`
          : `name:${name}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  });
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.forEach((row, i) => {
      const cell = row.children[0]!;
      cell.data = {
        ...cell.data,
        hProperties: i === 0 ? { rowSpan: group.length } : { hidden: true },
      };
    });
  }
  table.children = [header!, ...[...groups.values()].flat()];
}

const label = (value: string): ListItem => ({
  type: "listItem",
  spread: false,
  children: [
    {
      type: "paragraph",
      children: [{ type: "strong", children: [{ type: "text", value }] }],
    },
  ],
});
const list = (): List => ({
  type: "list",
  ordered: false,
  spread: false,
  children: [],
});

// Earlier reports combined owner and project in one bullet; retain their text.
function nestLegacyBlockers(source: List) {
  const entries = source.children.map((item) => {
    const first = item.children[0];
    if (first?.type !== "paragraph") return null;
    const match = plain(first).match(
      /^([^·\n]+?)\s*·\s*([^:：\n]+?)(?:[:：]\s*([\s\S]*))?$/u,
    );
    if (!match) return null;
    return {
      owner: match[1]!.trim(),
      project: match[2]!.trim(),
      content: match[3]?.trim(),
      rest: item.children.slice(1),
    };
  });
  if (!entries.length || entries.some((entry) => !entry)) return;
  const owners = new Map<string, ListItem>();
  for (const entry of entries) {
    if (!entry) continue;
    let owner = owners.get(entry.owner);
    if (!owner) {
      owner = label(entry.owner);
      owner.children.push(list());
      owners.set(entry.owner, owner);
    }
    const project = label(entry.project);
    const details = list();
    if (entry.content)
      details.children.push({
        type: "listItem",
        spread: false,
        children: [
          {
            type: "paragraph",
            children: [{ type: "text", value: entry.content }],
          },
        ],
      });
    for (const child of entry.rest) {
      if (child.type === "list") details.children.push(...child.children);
      else
        details.children.push({
          type: "listItem",
          spread: false,
          children: [child],
        });
    }
    if (details.children.length) project.children.push(details);
    (owner.children[1] as List).children.push(project);
  }
  source.children = [...owners.values()];
}

export function remarkReportLayout(
  options: { projectProgress?: ProjectIdentity[] } = {},
) {
  return (tree: Root) => {
    let section = "";
    for (const node of tree.children as RootContent[]) {
      if (node.type === "heading" && node.depth <= 2)
        section = plain(node).trim();
      if (node.type === "table")
        mergeOwners(node, options.projectProgress ?? []);
      if (node.type === "list" && ["项目阻塞", "风险与阻塞"].includes(section))
        nestLegacyBlockers(node);
    }
  };
}
