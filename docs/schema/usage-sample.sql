-- Fox Agent — agent usage tables: DDL + sample rows
-- Source: the e2e test stack, MariaDB 10.11.19 (mock model, test users, no real data). Generated 2026-10-26 14:32 +0700.
-- Whole test database: steps=95, turns=44, turn_tools=42, ingest=2. Sample: 11 turns (9 with tools, 2 without), every model step of those turns
-- + 3 Data Studio pipeline steps, every per-tool row of those turns, both ingest offsets.
-- No json columns, no json_* functions. No foreign keys (by design; integrity kept by the gateway).
-- `at` is when it happened (UTC, ms); created_at / updated_at are when the row was written (server time).

-- ===== DDL =====
CREATE TABLE `discovery_usage_steps` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `at` datetime(3) NOT NULL,
  `ms` int(11) NOT NULL,
  `user_id` int(11) NOT NULL DEFAULT 0,
  `session_id` varchar(64) NOT NULL,
  `flow` varchar(32) NOT NULL DEFAULT '',
  `project_id` varchar(36) DEFAULT NULL,
  `model` varchar(128) NOT NULL,
  `turn` int(11) NOT NULL,
  `step` int(11) NOT NULL,
  `purpose` varchar(16) NOT NULL,
  `outcome` varchar(32) NOT NULL,
  `input_tokens` int(11) NOT NULL,
  `output_tokens` int(11) NOT NULL,
  `cache_read_tokens` int(11) DEFAULT NULL,
  `reasoning_tokens` int(11) DEFAULT NULL,
  `estimated` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `usage_steps_call_idx` (`session_id`,`turn`,`step`,`purpose`),
  KEY `usage_steps_at_idx` (`at`),
  KEY `usage_steps_user_id_at_idx` (`user_id`,`at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `discovery_usage_turns` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `at` datetime(3) NOT NULL,
  `ms` int(11) NOT NULL,
  `user_id` int(11) NOT NULL DEFAULT 0,
  `session_id` varchar(64) NOT NULL,
  `flow` varchar(32) NOT NULL DEFAULT '',
  `project_id` varchar(36) DEFAULT NULL,
  `turn` int(11) NOT NULL,
  `reason` varchar(32) NOT NULL,
  `steps` int(11) NOT NULL,
  `tool_calls` int(11) NOT NULL,
  `tool_errors` int(11) NOT NULL,
  `attachments` int(11) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `usage_turns_turn_idx` (`session_id`,`turn`),
  KEY `usage_turns_at_idx` (`at`),
  KEY `usage_turns_user_id_at_idx` (`user_id`,`at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `discovery_usage_turn_tools` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `at` datetime(3) NOT NULL,
  `session_id` varchar(64) NOT NULL,
  `turn` int(11) NOT NULL,
  `tool` varchar(64) NOT NULL,
  `calls` int(11) NOT NULL,
  `errors` int(11) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `usage_turn_tools_idx` (`session_id`,`turn`,`tool`),
  KEY `usage_turn_tools_at_idx` (`at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `discovery_usage_ingest` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `file` varchar(255) NOT NULL,
  `read_offset` bigint(20) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `file` (`file`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===== sample rows =====
INSERT INTO `discovery_usage_steps` VALUES (8,'2026-10-26 07:32:08.419',33,2,'9e7a2832-22db-4ef3-addf-3dd330c466fb','default',NULL,'mock',1,1,'turn','ok',10,5,NULL,NULL,0,'2026-10-26 07:32:10','2026-10-26 07:32:10');
INSERT INTO `discovery_usage_steps` VALUES (51,'2026-10-26 07:32:11.940',9,2,'eae5b062-00d8-4296-b915-81b607381e69','default',NULL,'mock',20,1,'turn','ok',10,5,NULL,NULL,0,'2026-10-26 07:32:12','2026-10-26 07:32:12');
INSERT INTO `discovery_usage_steps` VALUES (52,'2026-10-26 07:32:11.958',7,2,'eae5b062-00d8-4296-b915-81b607381e69','default',NULL,'mock',20,2,'turn','ok',10,5,NULL,NULL,0,'2026-10-26 07:32:12','2026-10-26 07:32:12');
INSERT INTO `discovery_usage_steps` VALUES (79,'2026-10-26 07:32:12.542',10,2,'eae5b062-00d8-4296-b915-81b607381e69','default',NULL,'mock',29,1,'turn','ok',10,5,NULL,NULL,0,'2026-10-26 07:32:14','2026-10-26 07:32:14');
INSERT INTO `discovery_usage_steps` VALUES (80,'2026-10-26 07:32:12.562',8,2,'eae5b062-00d8-4296-b915-81b607381e69','default',NULL,'mock',29,2,'turn','ok',10,5,NULL,NULL,0,'2026-10-26 07:32:14','2026-10-26 07:32:14');
INSERT INTO `discovery_usage_steps` VALUES (81,'2026-10-26 07:32:12.628',8,2,'eae5b062-00d8-4296-b915-81b607381e69','default',NULL,'mock',30,1,'turn','ok',10,5,NULL,NULL,0,'2026-10-26 07:32:14','2026-10-26 07:32:14');
INSERT INTO `discovery_usage_steps` VALUES (82,'2026-10-26 07:32:12.671',9,2,'eae5b062-00d8-4296-b915-81b607381e69','default',NULL,'mock',30,2,'turn','ok',10,5,NULL,NULL,0,'2026-10-26 07:32:14','2026-10-26 07:32:14');
INSERT INTO `discovery_usage_steps` VALUES (83,'2026-10-26 07:32:12.744',8,2,'eae5b062-00d8-4296-b915-81b607381e69','default',NULL,'mock',31,1,'turn','ok',10,5,NULL,NULL,0,'2026-10-26 07:32:14','2026-10-26 07:32:14');
INSERT INTO `discovery_usage_steps` VALUES (84,'2026-10-26 07:32:12.761',10,2,'eae5b062-00d8-4296-b915-81b607381e69','default',NULL,'mock',31,2,'turn','ok',10,5,NULL,NULL,0,'2026-10-26 07:32:14','2026-10-26 07:32:14');
INSERT INTO `discovery_usage_steps` VALUES (87,'2026-10-26 07:32:12.886',9,2,'eae5b062-00d8-4296-b915-81b607381e69','default',NULL,'mock',33,1,'turn','ok',10,5,NULL,NULL,0,'2026-10-26 07:32:14','2026-10-26 07:32:14');
INSERT INTO `discovery_usage_steps` VALUES (88,'2026-10-26 07:32:12.902',7,2,'eae5b062-00d8-4296-b915-81b607381e69','default',NULL,'mock',33,2,'turn','ok',10,5,NULL,NULL,0,'2026-10-26 07:32:14','2026-10-26 07:32:14');
INSERT INTO `discovery_usage_steps` VALUES (89,'2026-10-26 07:32:12.915',9,2,'eae5b062-00d8-4296-b915-81b607381e69','default',NULL,'mock',34,1,'turn','ok',10,5,NULL,NULL,0,'2026-10-26 07:32:14','2026-10-26 07:32:14');
INSERT INTO `discovery_usage_steps` VALUES (90,'2026-10-26 07:32:12.934',7,2,'eae5b062-00d8-4296-b915-81b607381e69','default',NULL,'mock',34,2,'turn','ok',10,5,NULL,NULL,0,'2026-10-26 07:32:14','2026-10-26 07:32:14');
INSERT INTO `discovery_usage_steps` VALUES (93,'2026-10-26 07:32:13.062',8,2,'eae5b062-00d8-4296-b915-81b607381e69','default',NULL,'mock',36,1,'turn','ok',10,5,NULL,NULL,0,'2026-10-26 07:32:14','2026-10-26 07:32:14');
INSERT INTO `discovery_usage_steps` VALUES (94,'2026-10-26 07:32:13.109',8,2,'eae5b062-00d8-4296-b915-81b607381e69','default',NULL,'mock',36,2,'turn','ok',10,5,NULL,NULL,0,'2026-10-26 07:32:14','2026-10-26 07:32:14');
INSERT INTO `discovery_usage_steps` VALUES (95,'2026-10-26 07:32:13.336',13,4,'fb7a9b26-5868-4350-925c-a9c1f5011c59','default',NULL,'mock',1,1,'turn','ok',10,5,NULL,NULL,0,'2026-10-26 07:32:14','2026-10-26 07:32:14');
INSERT INTO `discovery_usage_steps` VALUES (96,'2026-10-26 07:32:13.357',9,4,'fb7a9b26-5868-4350-925c-a9c1f5011c59','default',NULL,'mock',1,2,'turn','ok',10,5,NULL,NULL,0,'2026-10-26 07:32:14','2026-10-26 07:32:14');
INSERT INTO `discovery_usage_steps` VALUES (97,'2026-10-26 07:32:13.372',8,4,'fb7a9b26-5868-4350-925c-a9c1f5011c59','default',NULL,'mock',2,1,'turn','ok',10,5,NULL,NULL,0,'2026-10-26 07:32:14','2026-10-26 07:32:14');
INSERT INTO `discovery_usage_steps` VALUES (98,'2026-10-26 07:32:13.415',8,4,'34c2b1b3-abbf-4cf9-b3cc-a66f367ecf93','data-studio',NULL,'mock',1,1,'turn','ok',10,5,NULL,NULL,0,'2026-10-26 07:32:14','2026-10-26 07:32:14');
INSERT INTO `discovery_usage_steps` VALUES (105,'2026-10-26 07:32:18.039',26,4,'34c2b1b3-abbf-4cf9-b3cc-a66f367ecf93','data-studio',NULL,'mock',1,1000,'data-studio','ok',10,5,NULL,NULL,0,'2026-10-26 07:32:18','2026-10-26 07:32:18');
INSERT INTO `discovery_usage_steps` VALUES (106,'2026-10-26 07:32:18.061',4,4,'34c2b1b3-abbf-4cf9-b3cc-a66f367ecf93','data-studio',NULL,'mock',1,1001,'data-studio','ok',0,0,NULL,NULL,0,'2026-10-26 07:32:18','2026-10-26 07:32:18');
INSERT INTO `discovery_usage_steps` VALUES (107,'2026-10-26 07:32:18.063',2,4,'34c2b1b3-abbf-4cf9-b3cc-a66f367ecf93','data-studio',NULL,'mock',1,1002,'data-studio','ok',0,0,NULL,NULL,0,'2026-10-26 07:32:18','2026-10-26 07:32:18');
INSERT INTO `discovery_usage_steps` VALUES (108,'2026-10-26 07:32:18.063',2,4,'34c2b1b3-abbf-4cf9-b3cc-a66f367ecf93','data-studio',NULL,'mock',1,1003,'data-studio','ok',10,5,NULL,NULL,0,'2026-10-26 07:32:18','2026-10-26 07:32:18');
INSERT INTO `discovery_usage_steps` VALUES (109,'2026-10-26 07:32:18.061',4,4,'34c2b1b3-abbf-4cf9-b3cc-a66f367ecf93','data-studio',NULL,'mock',1,1004,'data-studio','ok',0,0,NULL,NULL,0,'2026-10-26 07:32:18','2026-10-26 07:32:18');
INSERT INTO `discovery_usage_steps` VALUES (110,'2026-10-26 07:32:18.063',2,4,'34c2b1b3-abbf-4cf9-b3cc-a66f367ecf93','data-studio',NULL,'mock',1,1005,'data-studio','ok',0,0,NULL,NULL,0,'2026-10-26 07:32:18','2026-10-26 07:32:18');
INSERT INTO `discovery_usage_steps` VALUES (111,'2026-10-26 07:32:18.063',2,4,'34c2b1b3-abbf-4cf9-b3cc-a66f367ecf93','data-studio',NULL,'mock',1,1006,'data-studio','ok',10,5,NULL,NULL,0,'2026-10-26 07:32:18','2026-10-26 07:32:18');
INSERT INTO `discovery_usage_steps` VALUES (112,'2026-10-26 07:32:18.060',5,4,'34c2b1b3-abbf-4cf9-b3cc-a66f367ecf93','data-studio',NULL,'mock',1,1007,'data-studio','ok',0,0,NULL,NULL,0,'2026-10-26 07:32:18','2026-10-26 07:32:18');
INSERT INTO `discovery_usage_steps` VALUES (113,'2026-10-26 07:32:18.063',2,4,'34c2b1b3-abbf-4cf9-b3cc-a66f367ecf93','data-studio',NULL,'mock',1,1008,'data-studio','ok',0,0,NULL,NULL,0,'2026-10-26 07:32:18','2026-10-26 07:32:18');
INSERT INTO `discovery_usage_steps` VALUES (114,'2026-10-26 07:32:18.071',7,4,'34c2b1b3-abbf-4cf9-b3cc-a66f367ecf93','data-studio',NULL,'mock',1,2,'turn','ok',10,5,NULL,NULL,0,'2026-10-26 07:32:18','2026-10-26 07:32:18');
INSERT INTO `discovery_usage_turns` VALUES (4,'2026-10-26 07:32:08.365',88,2,'9e7a2832-22db-4ef3-addf-3dd330c466fb','default',NULL,1,'completed',1,0,0,0,'2026-10-26 07:32:10','2026-10-26 07:32:10');
INSERT INTO `discovery_usage_turns` VALUES (27,'2026-10-26 07:32:11.935',31,2,'eae5b062-00d8-4296-b915-81b607381e69','default',NULL,20,'completed',2,1,1,0,'2026-10-26 07:32:12','2026-10-26 07:32:12');
INSERT INTO `discovery_usage_turns` VALUES (41,'2026-10-26 07:32:12.535',36,2,'eae5b062-00d8-4296-b915-81b607381e69','default',NULL,29,'completed',2,1,1,0,'2026-10-26 07:32:14','2026-10-26 07:32:14');
INSERT INTO `discovery_usage_turns` VALUES (42,'2026-10-26 07:32:12.623',57,2,'eae5b062-00d8-4296-b915-81b607381e69','default',NULL,30,'completed',2,1,1,0,'2026-10-26 07:32:14','2026-10-26 07:32:14');
INSERT INTO `discovery_usage_turns` VALUES (43,'2026-10-26 07:32:12.737',34,2,'eae5b062-00d8-4296-b915-81b607381e69','default',NULL,31,'completed',2,1,1,0,'2026-10-26 07:32:14','2026-10-26 07:32:14');
INSERT INTO `discovery_usage_turns` VALUES (45,'2026-10-26 07:32:12.879',30,2,'eae5b062-00d8-4296-b915-81b607381e69','default',NULL,33,'completed',2,1,1,0,'2026-10-26 07:32:14','2026-10-26 07:32:14');
INSERT INTO `discovery_usage_turns` VALUES (46,'2026-10-26 07:32:12.910',31,2,'eae5b062-00d8-4296-b915-81b607381e69','default',NULL,34,'completed',2,1,1,0,'2026-10-26 07:32:14','2026-10-26 07:32:14');
INSERT INTO `discovery_usage_turns` VALUES (48,'2026-10-26 07:32:13.057',60,2,'eae5b062-00d8-4296-b915-81b607381e69','default',NULL,36,'completed',2,1,1,0,'2026-10-26 07:32:14','2026-10-26 07:32:14');
INSERT INTO `discovery_usage_turns` VALUES (49,'2026-10-26 07:32:13.313',54,4,'fb7a9b26-5868-4350-925c-a9c1f5011c59','default',NULL,1,'completed',2,1,1,0,'2026-10-26 07:32:14','2026-10-26 07:32:14');
INSERT INTO `discovery_usage_turns` VALUES (50,'2026-10-26 07:32:13.368',12,4,'fb7a9b26-5868-4350-925c-a9c1f5011c59','default',NULL,2,'completed',1,0,0,0,'2026-10-26 07:32:14','2026-10-26 07:32:14');
INSERT INTO `discovery_usage_turns` VALUES (53,'2026-10-26 07:32:13.403',4675,4,'34c2b1b3-abbf-4cf9-b3cc-a66f367ecf93','data-studio',NULL,1,'completed',2,1,1,0,'2026-10-26 07:32:18','2026-10-26 07:32:18');
INSERT INTO `discovery_usage_turn_tools` VALUES (25,'2026-10-26 07:32:11.935','eae5b062-00d8-4296-b915-81b607381e69',20,'file_manage',1,1,'2026-10-26 07:32:12','2026-10-26 07:32:12');
INSERT INTO `discovery_usage_turn_tools` VALUES (39,'2026-10-26 07:32:12.535','eae5b062-00d8-4296-b915-81b607381e69',29,'file_manage',1,1,'2026-10-26 07:32:14','2026-10-26 07:32:14');
INSERT INTO `discovery_usage_turn_tools` VALUES (40,'2026-10-26 07:32:12.623','eae5b062-00d8-4296-b915-81b607381e69',30,'file_manage',1,1,'2026-10-26 07:32:14','2026-10-26 07:32:14');
INSERT INTO `discovery_usage_turn_tools` VALUES (41,'2026-10-26 07:32:12.737','eae5b062-00d8-4296-b915-81b607381e69',31,'file_manage',1,1,'2026-10-26 07:32:14','2026-10-26 07:32:14');
INSERT INTO `discovery_usage_turn_tools` VALUES (43,'2026-10-26 07:32:12.879','eae5b062-00d8-4296-b915-81b607381e69',33,'file_manage',1,1,'2026-10-26 07:32:14','2026-10-26 07:32:14');
INSERT INTO `discovery_usage_turn_tools` VALUES (44,'2026-10-26 07:32:12.910','eae5b062-00d8-4296-b915-81b607381e69',34,'file_manage',1,1,'2026-10-26 07:32:14','2026-10-26 07:32:14');
INSERT INTO `discovery_usage_turn_tools` VALUES (46,'2026-10-26 07:32:13.057','eae5b062-00d8-4296-b915-81b607381e69',36,'file_manage',1,1,'2026-10-26 07:32:14','2026-10-26 07:32:14');
INSERT INTO `discovery_usage_turn_tools` VALUES (47,'2026-10-26 07:32:13.313','fb7a9b26-5868-4350-925c-a9c1f5011c59',1,'read',1,1,'2026-10-26 07:32:14','2026-10-26 07:32:14');
INSERT INTO `discovery_usage_turn_tools` VALUES (51,'2026-10-26 07:32:13.403','34c2b1b3-abbf-4cf9-b3cc-a66f367ecf93',1,'analyze_data',1,1,'2026-10-26 07:32:18','2026-10-26 07:32:18');
INSERT INTO `discovery_usage_ingest` VALUES (1,'shard-0/2026-10-26.jsonl',29057,'2026-10-26 07:32:10','2026-10-26 07:32:20');
INSERT INTO `discovery_usage_ingest` VALUES (2,'shard-1/2026-10-26.jsonl',1058,'2026-10-26 07:32:10','2026-10-26 07:32:20');

-- ===== the dashboard's main queries (run against the rows above) =====
-- per day at UTC+07:00 (fixed offset in SQL, no MariaDB time-zone tables needed)
-- select date(at + interval 420 minute) d, count(*) turns, sum(tool_calls), sum(tool_errors) from discovery_usage_turns where at >= ? and at < ? group by d;
-- tool ranking
-- select tool, sum(calls) calls, sum(errors) errors from discovery_usage_turn_tools where at >= ? and at < ? group by tool order by calls desc limit 20;
-- tokens per model
-- select model, sum(input_tokens), sum(output_tokens), count(*) from discovery_usage_steps where at >= ? and at < ? group by model;
-- daily retention (USAGE_RETENTION_DAYS, default 400)
-- delete from discovery_usage_steps where at < ?; delete from discovery_usage_turns where at < ?; delete from discovery_usage_turn_tools where at < ?;
