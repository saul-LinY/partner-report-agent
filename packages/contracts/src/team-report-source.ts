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
) {
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
    };
  });
}
