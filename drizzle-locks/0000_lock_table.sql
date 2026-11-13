CREATE TABLE `locks` (
	`name` text PRIMARY KEY NOT NULL,
	`holder_process_id` integer NOT NULL,
	`holder_started_at` integer,
	`taken_at` integer NOT NULL
);
