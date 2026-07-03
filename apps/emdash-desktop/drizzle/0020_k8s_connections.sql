CREATE TABLE `k8s_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`context` text NOT NULL,
	`namespace` text NOT NULL,
	`pod_name` text NOT NULL,
	`container_name` text,
	`kubeconfig_path` text,
	`metadata` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE `projects` ADD `k8s_connection_id` text REFERENCES k8s_connections(id);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_k8s_connections_name` ON `k8s_connections` (`name`);--> statement-breakpoint
CREATE INDEX `idx_projects_k8s_connection_id` ON `projects` (`k8s_connection_id`);
