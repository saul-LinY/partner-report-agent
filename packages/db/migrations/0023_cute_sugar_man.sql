ALTER TABLE "work_item_facts" DROP CONSTRAINT "work_item_facts_work_item_id_work_items_id_fk";
--> statement-breakpoint
ALTER TABLE "work_item_facts" ADD CONSTRAINT "work_item_facts_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;