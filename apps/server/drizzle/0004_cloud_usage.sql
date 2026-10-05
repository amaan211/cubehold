CREATE TABLE `cloud_usage` (
	`host_id` text NOT NULL,
	`day` text NOT NULL,
	`host_name` text NOT NULL,
	`account_id` text,
	`provider` text NOT NULL,
	`region` text,
	`size` text NOT NULL,
	`running` real DEFAULT 0 NOT NULL,
	`stopped` real DEFAULT 0 NOT NULL,
	`hibernated` real DEFAULT 0 NOT NULL,
	`snapshot_gb_hours` real DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`host_id`, `day`)
);
--> statement-breakpoint
CREATE INDEX `cloud_usage_day_idx` ON `cloud_usage` (`day`);