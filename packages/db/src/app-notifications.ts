import { randomUUID } from "node:crypto";
import { sqlClient as sql } from "./index.js";

const copy: Record<string, { title: string; body: string; target: string }> = {
  "project_scope.candidates.changed": {
    title: "新项目采集审批",
    body: "发现新项目，请确认是否允许采集会话。",
    target: "projects",
  },
  "project_scope.period.review_ready": {
    title: "项目权限待确认",
    body: "请在 App 中确认本期项目采集权限。",
    target: "projects",
  },
  "project_scope.delivery.requested": {
    title: "项目权限待确认",
    body: "请在 App 中确认项目采集权限。",
    target: "projects",
  },
  "project_scope.reminder.requested": {
    title: "项目审批提醒",
    body: "你还有未处理的项目采集权限。",
    target: "projects",
  },
  "work_items.draft.created": {
    title: "工作卡片待审核",
    body: "工作卡片已生成，请在 App 中审核。",
    target: "review",
  },
  "work_items.regeneration.failed": {
    title: "卡片更新失败",
    body: "工作卡片未能更新，请在 App 中查看并重试。",
    target: "review",
  },
  "review.reopened": {
    title: "工作卡片重新开放",
    body: "工作卡片已重新开放审核。",
    target: "review",
  },
  "review.reminder.requested": {
    title: "工作卡片审核提醒",
    body: "你还有未审核的工作卡片。",
    target: "review",
  },
  "work_items.snapshot.approved": {
    title: "工作卡片审核完成",
    body: "审核结果已保存，将用于本期报告汇总。",
    target: "review",
  },
  "work_items.all_dismissed": {
    title: "工作卡片审核完成",
    body: "本期工作卡片均已忽略。",
    target: "review",
  },
  "plugin.binding.recovery.requested": {
    title: "连接需要恢复",
    body: "旧连接已申请恢复，请在 App 中使用名字和绑定码重新绑定。",
    target: "app",
  },
};
export const suppressedAppNotificationKinds = [
  "team_report.ready",
  "team_report.locked",
];
const consumed = [
  ...Object.keys(copy),
  ...suppressedAppNotificationKinds,
  "work_item.review.changed",
  "review.change.applied",
];

/** Persist notifications and advance the outbox atomically; never calls an external messenger. */
export async function dispatchAppNotifications(limit = 100, tenantId?: string) {
  return sql.begin(async (tx) => {
    const events = await tx<any[]>`
      select * from outbox_events where published_at is null and event_type in ${tx(consumed)}
        and (${tenantId ?? null}::uuid is null or tenant_id=${tenantId ?? null})
      order by created_at,id limit ${limit} for update skip locked
    `;
    let queued = 0;
    for (const event of events) {
      const message = copy[event.event_type];
      let recipients: any[] = [];
      if (message?.target === "projects") {
        recipients =
          await tx`select tenant_id,team_id,partner_id,id::text as target_id,null::integer as version
          from plugin_instances pi where id::text=${event.aggregate_id} and tenant_id=${event.tenant_id} and status in ('active','collector')
            and exists (select 1 from project_scope_entries e where e.plugin_instance_id=pi.id and e.status='pending')`;
      } else if (message?.target === "review") {
        recipients =
          await tx`select r.tenant_id,r.team_id,r.partner_id,r.id::text as target_id,r.version
          from reviews r where r.tenant_id=${event.tenant_id} and
          (r.id::text=${event.aggregate_id} or r.id=(select review_id from work_item_snapshots where id::text=${event.aggregate_id} and tenant_id=${event.tenant_id} limit 1))`;
      } else if (message?.target === "app") {
        recipients =
          await tx`select tenant_id,team_id,partner_id,id::text as target_id,null::integer as version
          from plugin_device_authorizations where id::text=${event.aggregate_id} and tenant_id=${event.tenant_id}
            and partner_id is not null and status='pending' and expires_at>now()`;
      }
      for (const recipient of recipients) {
        const inserted = await tx`insert into app_notifications
          (id,tenant_id,team_id,partner_id,source_event_id,kind,title,body,target_type,target_id,review_version)
          values (${randomUUID()},${recipient.tenant_id},${recipient.team_id},${recipient.partner_id},${event.id},${event.event_type},${message!.title},${message!.body},${message!.target},${recipient.target_id},${recipient.version})
          on conflict (source_event_id,partner_id) do nothing returning id`;
        queued += inserted.length;
      }
      await tx`update outbox_events set published_at=now() where id=${event.id}`;
    }
    return { processed: events.length, queued };
  });
}
