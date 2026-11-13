CREATE TABLE `content` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`section_id` integer NOT NULL,
	`kind` text NOT NULL,
	`code` text,
	`links` text,
	`work_kind` text,
	`where_it_stands` text,
	`free_lines` text DEFAULT '' NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`written_date_is_estimate` integer DEFAULT false NOT NULL,
	`written_at` integer NOT NULL,
	`written_by` text NOT NULL,
	`changed_at` integer NOT NULL,
	`changed_by` text NOT NULL,
	`archived_at` integer,
	`archived_by` text,
	FOREIGN KEY (`section_id`) REFERENCES `section`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `content_section` ON `content` (`section_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `one_live_work_row_per_code` ON `content` (`code`) WHERE "content"."kind" = 'work' and "content"."archived_at" is null;--> statement-breakpoint
CREATE TABLE `journal` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`writer` text NOT NULL,
	`action` text NOT NULL,
	`item` text NOT NULL,
	`before` text,
	`after` text
);
--> statement-breakpoint
CREATE TABLE `section` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tab_id` integer NOT NULL,
	`parent_id` integer,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`written_at` integer NOT NULL,
	`written_by` text NOT NULL,
	`changed_at` integer NOT NULL,
	`changed_by` text NOT NULL,
	`archived_at` integer,
	`archived_by` text,
	FOREIGN KEY (`tab_id`) REFERENCES `tab`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_id`) REFERENCES `section`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `section_tab` ON `section` (`tab_id`);--> statement-breakpoint
CREATE TABLE `tab` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`written_at` integer NOT NULL,
	`written_by` text NOT NULL,
	`changed_at` integer NOT NULL,
	`changed_by` text NOT NULL,
	`archived_at` integer,
	`archived_by` text
);
--> statement-breakpoint
DROP TABLE `database_proof`;