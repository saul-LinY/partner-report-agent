import {
  ClipboardCheck,
  FileStack,
  LayoutDashboard,
  ScanSearch,
  ServerCog,
  Settings2,
  TableProperties,
  UserRound,
} from "lucide-react";

// Navigation groups describe presentation only; page routes and permissions stay
// with the existing router and API.
export const navigationGroups = [
  {
    label: "进展与成果",
    items: [
      { label: "项目进展", href: "/admin", icon: LayoutDashboard },
      { label: "周报与工作卡", href: "/admin/reports", icon: FileStack },
    ],
  },
  {
    label: "采集与管理",
    items: [
      { label: "贡献记录", href: "/admin/facts", icon: TableProperties },
      { label: "工作卡审核", href: "/admin/reviews", icon: ClipboardCheck },
      { label: "团队管理", href: "/admin/team-settings", icon: Settings2 },
    ],
  },
  {
    label: "监控与排障",
    items: [
      { label: "用户日志", href: "/admin/user-logs", icon: UserRound },
      { label: "系统日志", href: "/admin/system-logs", icon: ServerCog },
      { label: "异常巡检", href: "/admin/inspection", icon: ScanSearch },
    ],
  },
];

export function isNavigationActive(location: string, href: string) {
  if (href === "/admin/reviews")
    return location === href || location.startsWith("/partner/review/");
  if (href === "/admin/reports")
    return location === href || location.startsWith("/admin/team-reports/");
  return location === href;
}

export function navigationGroupLabel(location: string) {
  return navigationGroups.find((group) =>
    group.items.some((item) => isNavigationActive(location, item.href)),
  )?.label;
}
