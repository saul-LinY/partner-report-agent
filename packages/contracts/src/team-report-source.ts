export type TeamReportSourceProject = {
  id: string;
  name: string;
  description: string;
};

export type TeamReportSourceIndividualReport = {
  partnerId: string;
  partnerName: string;
  reportId: string;
  payload: unknown;
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

export function buildTeamReportIndividualReports(
  reports: TeamReportSourceIndividualReport[],
  projects: TeamReportSourceProject[],
) {
  const approvedProjects = new Map(
    projects.map((project) => [project.id, project]),
  );

  return reports.map((report) => {
    const workItems = Array.isArray(report.workItemSnapshot?.workItems)
      ? report.workItemSnapshot.workItems
      : [];
    return {
      partnerId: report.partnerId,
      partnerName: report.partnerName,
      reportId: report.reportId,
      payload: report.payload,
      noReportableActivity:
        report.workItemSnapshot?.noReportableActivity === true,
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
