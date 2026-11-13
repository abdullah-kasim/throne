ALTER TABLE `locks` ADD `command_process_id` integer;--> statement-breakpoint
ALTER TABLE `locks` ADD `command_started_at` integer;--> statement-breakpoint
ALTER TABLE `locks` ADD `command_line` text;