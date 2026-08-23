export type TeamReportSourceProject = {
  id: string;
  name: string;
  description: string;
};

export type TeamReportSourceWorkCards = {
  partnerId: string;
  partnerName: string;
  snapshotId: string;
  workItemSnapshot: {
    workItems?: unknown;
    noReportableActivity?: boolean;
  } | null;
};

function workItemRecord(item: unknown): Record<string, unknown> {
  return item && typeof item === "object"
    ? (item as Record<string, unknown>)
    : {};
}

export function buildTeamReportWorkCards(
  snapshots: TeamReportSourceWorkCards[],
  projects: TeamReportSourceProject[],
) {
  const approvedProjects = new Map(
    projects.map((project) => [project.id, project]),
  );

  return snapshots.map((snapshot) => {
    const workItems = Array.isArray(snapshot.workItemSnapshot?.workItems)
      ? snapshot.workItemSnapshot.workItems
      : [];
    return {
      partnerId: snapshot.partnerId,
      partnerName: snapshot.partnerName,
      snapshotId: snapshot.snapshotId,
      workItems,
      noReportableActivity:
        snapshot.workItemSnapshot?.noReportableActivity === true,
      projectNames: [
        ...new Set(
          workItems
            .map((item) => workItemRecord(item).title)
            .map((title) => (typeof title === "string" ? title.trim() : ""))
            .filter(Boolean),
        ),
      ],
      projectDescriptions: [
        ...new Map(
          workItems
            .map((item) => {
              const record = workItemRecord(item);
              const project =
                typeof record.project_id === "string"
                  ? approvedProjects.get(record.project_id)
                  : undefined;
              return [
                project?.name ??
                  (typeof record.title === "string" ? record.title.trim() : ""),
                project?.description.trim() ?? "",
              ] as const;
            })
            .filter(([name, description]) => Boolean(name && description)),
        ).entries(),
      ].map(([name, description]) => ({ name, description })),
    };
  });
}
