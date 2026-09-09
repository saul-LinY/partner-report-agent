import {
  ClipboardCheck,
  FileStack,
  HeartPulse,
  LayoutDashboard,
  ListTodo,
  PlugZap,
  TableProperties,
} from "lucide-react";

// Navigation groups describe presentation only; page routes and permissions stay
// with the existing router and API.
export const navigationGroups = [
  {
    label: "团队运营",
    items: [{ label: "运行总览", href: "/admin", icon: LayoutDashboard }],
  },
  {
    label: "贡献与报告",
    items: [
      { label: "贡献预览", href: "/admin/facts", icon: TableProperties },
      { label: "审核队列", href: "/admin/reviews", icon: ClipboardCheck },
      { label: "报告归档", href: "/admin/reports", icon: FileStack },
    ],
  },
  {
    label: "系统运维",
    items: [
      { label: "插件监控", href: "/admin/plugin-logs", icon: PlugZap },
      { label: "异常任务", href: "/admin/jobs", icon: ListTodo },
      { label: "系统监控", href: "/admin/system-monitoring", icon: HeartPulse },
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
