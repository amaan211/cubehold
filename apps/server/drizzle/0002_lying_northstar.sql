CREATE TABLE `player_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` text NOT NULL,
	`name` text NOT NULL,
	`joined_at` text NOT NULL,
	`left_at` text,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `player_sessions_server_name_idx` ON `player_sessions` (`server_id`,`name`);--> statement-breakpoint
ALTER TABLE `backups` ADD `scope` text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE `backups` ADD `state` text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE `backups` ADD `error` text;--> statement-breakpoint
ALTER TABLE `backups` ADD `file_count` integer;--> statement-breakpoint
ALTER TABLE `backups` ADD `mc_version` text;--> statement-breakpoint
ALTER TABLE `schedules` ADD `warn_seconds` integer;--> statement-breakpoint
ALTER TABLE `schedules` ADD `last_result` text;--> statement-breakpoint
ALTER TABLE `schedules` ADD `last_message` text;