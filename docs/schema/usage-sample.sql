-- Fox Agent — agent usage tables: DDL + sample rows
-- Source: the e2e test stack, MariaDB 10.11.19 (mock model, test users, no real data). Generated 2026-10-26 14:22 +0700.
-- Whole test database: steps=348, turns=201, turn_tools=120, ingest=2. Sample: 12 turns (9 with tools, 3 without), every model step of those turns
-- + 3 Data Studio pipeline steps, every per-tool row of those turns, both ingest offsets.
-- No json columns, no json_* functions. No foreign keys (by design; integrity kept by the gateway). `at` is UTC.

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
INSERT INTO `discovery_usage_steps` VALUES (184,'2026-10-26 07:19:42.179',13,2,'1ef0c3fe-aac5-44a5-bed0-8a8d2c2b1cfb','default',NULL,'mock',2,1,'turn','ok',10,5,NULL,NULL,0);
INSERT INTO `discovery_usage_steps` VALUES (304,'2026-10-26 07:20:32.412',9,17,'820b63e8-942b-43ee-bece-c823b1025382','default',NULL,'mock',2,1,'turn','ok',10,5,NULL,NULL,0);
INSERT INTO `discovery_usage_steps` VALUES (366,'2026-10-26 07:21:40.375',7,18,'c2cbb20e-75c8-42ea-8b2b-b0aad158f70f','default',NULL,'mock',20,1,'turn','ok',10,5,NULL,NULL,0);
INSERT INTO `discovery_usage_steps` VALUES (367,'2026-10-26 07:21:40.391',8,18,'c2cbb20e-75c8-42ea-8b2b-b0aad158f70f','default',NULL,'mock',20,2,'turn','ok',10,5,NULL,NULL,0);
INSERT INTO `discovery_usage_steps` VALUES (386,'2026-10-26 07:21:41.794',14,20,'0204541e-0b36-4dbb-8517-024773117e45','default',NULL,'mock',1,1,'turn','ok',10,5,NULL,NULL,0);
INSERT INTO `discovery_usage_steps` VALUES (387,'2026-10-26 07:21:41.817',8,20,'0204541e-0b36-4dbb-8517-024773117e45','default',NULL,'mock',1,2,'turn','ok',10,5,NULL,NULL,0);
INSERT INTO `discovery_usage_steps` VALUES (388,'2026-10-26 07:21:41.833',7,20,'0204541e-0b36-4dbb-8517-024773117e45','default',NULL,'mock',2,1,'turn','ok',10,5,NULL,NULL,0);
INSERT INTO `discovery_usage_steps` VALUES (389,'2026-10-26 07:21:41.921',11,20,'78fb6d38-f850-4060-a0d8-e724b7a95220','data-studio',NULL,'mock',1,1,'turn','ok',10,5,NULL,NULL,0);
INSERT INTO `discovery_usage_steps` VALUES (407,'2026-10-26 07:21:40.938',8,18,'c2cbb20e-75c8-42ea-8b2b-b0aad158f70f','default',NULL,'mock',29,1,'turn','ok',10,5,NULL,NULL,0);
INSERT INTO `discovery_usage_steps` VALUES (408,'2026-10-26 07:21:40.957',7,18,'c2cbb20e-75c8-42ea-8b2b-b0aad158f70f','default',NULL,'mock',29,2,'turn','ok',10,5,NULL,NULL,0);
INSERT INTO `discovery_usage_steps` VALUES (409,'2026-10-26 07:21:41.019',8,18,'c2cbb20e-75c8-42ea-8b2b-b0aad158f70f','default',NULL,'mock',30,1,'turn','ok',10,5,NULL,NULL,0);
INSERT INTO `discovery_usage_steps` VALUES (410,'2026-10-26 07:21:41.067',10,18,'c2cbb20e-75c8-42ea-8b2b-b0aad158f70f','default',NULL,'mock',30,2,'turn','ok',10,5,NULL,NULL,0);
INSERT INTO `discovery_usage_steps` VALUES (411,'2026-10-26 07:21:41.141',8,18,'c2cbb20e-75c8-42ea-8b2b-b0aad158f70f','default',NULL,'mock',31,1,'turn','ok',10,5,NULL,NULL,0);
INSERT INTO `discovery_usage_steps` VALUES (412,'2026-10-26 07:21:41.157',7,18,'c2cbb20e-75c8-42ea-8b2b-b0aad158f70f','default',NULL,'mock',31,2,'turn','ok',10,5,NULL,NULL,0);
INSERT INTO `discovery_usage_steps` VALUES (415,'2026-10-26 07:21:41.284',8,18,'c2cbb20e-75c8-42ea-8b2b-b0aad158f70f','default',NULL,'mock',33,1,'turn','ok',10,5,NULL,NULL,0);
INSERT INTO `discovery_usage_steps` VALUES (416,'2026-10-26 07:21:41.298',8,18,'c2cbb20e-75c8-42ea-8b2b-b0aad158f70f','default',NULL,'mock',33,2,'turn','ok',10,5,NULL,NULL,0);
INSERT INTO `discovery_usage_steps` VALUES (417,'2026-10-26 07:21:41.313',8,18,'c2cbb20e-75c8-42ea-8b2b-b0aad158f70f','default',NULL,'mock',34,1,'turn','ok',10,5,NULL,NULL,0);
INSERT INTO `discovery_usage_steps` VALUES (418,'2026-10-26 07:21:41.329',9,18,'c2cbb20e-75c8-42ea-8b2b-b0aad158f70f','default',NULL,'mock',34,2,'turn','ok',10,5,NULL,NULL,0);
INSERT INTO `discovery_usage_steps` VALUES (421,'2026-10-26 07:21:41.457',9,18,'c2cbb20e-75c8-42ea-8b2b-b0aad158f70f','default',NULL,'mock',36,1,'turn','ok',10,5,NULL,NULL,0);
INSERT INTO `discovery_usage_steps` VALUES (422,'2026-10-26 07:21:41.502',9,18,'c2cbb20e-75c8-42ea-8b2b-b0aad158f70f','default',NULL,'mock',36,2,'turn','ok',10,5,NULL,NULL,0);
INSERT INTO `discovery_usage_steps` VALUES (424,'2026-10-26 07:21:43.650',14,20,'78fb6d38-f850-4060-a0d8-e724b7a95220','data-studio',NULL,'mock',1,1000,'data-studio','ok',10,5,NULL,NULL,0);
INSERT INTO `discovery_usage_steps` VALUES (425,'2026-10-26 07:21:43.659',5,20,'78fb6d38-f850-4060-a0d8-e724b7a95220','data-studio',NULL,'mock',1,1001,'data-studio','ok',0,0,NULL,NULL,0);
INSERT INTO `discovery_usage_steps` VALUES (426,'2026-10-26 07:21:43.663',1,20,'78fb6d38-f850-4060-a0d8-e724b7a95220','data-studio',NULL,'mock',1,1002,'data-studio','ok',0,0,NULL,NULL,0);
INSERT INTO `discovery_usage_steps` VALUES (427,'2026-10-26 07:21:43.662',2,20,'78fb6d38-f850-4060-a0d8-e724b7a95220','data-studio',NULL,'mock',1,1003,'data-studio','ok',10,5,NULL,NULL,0);
INSERT INTO `discovery_usage_steps` VALUES (428,'2026-10-26 07:21:43.659',5,20,'78fb6d38-f850-4060-a0d8-e724b7a95220','data-studio',NULL,'mock',1,1004,'data-studio','ok',0,0,NULL,NULL,0);
INSERT INTO `discovery_usage_steps` VALUES (429,'2026-10-26 07:21:43.663',1,20,'78fb6d38-f850-4060-a0d8-e724b7a95220','data-studio',NULL,'mock',1,1005,'data-studio','ok',0,0,NULL,NULL,0);
INSERT INTO `discovery_usage_steps` VALUES (430,'2026-10-26 07:21:43.662',2,20,'78fb6d38-f850-4060-a0d8-e724b7a95220','data-studio',NULL,'mock',1,1006,'data-studio','ok',10,5,NULL,NULL,0);
INSERT INTO `discovery_usage_steps` VALUES (431,'2026-10-26 07:21:43.660',4,20,'78fb6d38-f850-4060-a0d8-e724b7a95220','data-studio',NULL,'mock',1,1007,'data-studio','ok',0,0,NULL,NULL,0);
INSERT INTO `discovery_usage_steps` VALUES (432,'2026-10-26 07:21:43.662',2,20,'78fb6d38-f850-4060-a0d8-e724b7a95220','data-studio',NULL,'mock',1,1008,'data-studio','ok',0,0,NULL,NULL,0);
INSERT INTO `discovery_usage_steps` VALUES (433,'2026-10-26 07:21:43.710',7,20,'78fb6d38-f850-4060-a0d8-e724b7a95220','data-studio',NULL,'mock',1,2,'turn','ok',10,5,NULL,NULL,0);
INSERT INTO `discovery_usage_turns` VALUES (119,'2026-10-26 07:19:42.153',40,2,'1ef0c3fe-aac5-44a5-bed0-8a8d2c2b1cfb','default',NULL,2,'completed',1,0,0,0);
INSERT INTO `discovery_usage_turns` VALUES (177,'2026-10-26 07:20:32.407',15,17,'820b63e8-942b-43ee-bece-c823b1025382','default',NULL,2,'completed',1,0,0,0);
INSERT INTO `discovery_usage_turns` VALUES (204,'2026-10-26 07:21:40.370',30,18,'c2cbb20e-75c8-42ea-8b2b-b0aad158f70f','default',NULL,20,'completed',2,1,1,0);
INSERT INTO `discovery_usage_turns` VALUES (213,'2026-10-26 07:21:41.718',108,20,'0204541e-0b36-4dbb-8517-024773117e45','default',NULL,1,'completed',2,1,1,0);
INSERT INTO `discovery_usage_turns` VALUES (214,'2026-10-26 07:21:41.828',13,20,'0204541e-0b36-4dbb-8517-024773117e45','default',NULL,2,'completed',1,0,0,0);
INSERT INTO `discovery_usage_turns` VALUES (223,'2026-10-26 07:21:40.932',32,18,'c2cbb20e-75c8-42ea-8b2b-b0aad158f70f','default',NULL,29,'completed',2,1,1,0);
INSERT INTO `discovery_usage_turns` VALUES (224,'2026-10-26 07:21:41.014',63,18,'c2cbb20e-75c8-42ea-8b2b-b0aad158f70f','default',NULL,30,'completed',2,1,1,0);
INSERT INTO `discovery_usage_turns` VALUES (225,'2026-10-26 07:21:41.135',30,18,'c2cbb20e-75c8-42ea-8b2b-b0aad158f70f','default',NULL,31,'completed',2,1,1,0);
INSERT INTO `discovery_usage_turns` VALUES (227,'2026-10-26 07:21:41.275',31,18,'c2cbb20e-75c8-42ea-8b2b-b0aad158f70f','default',NULL,33,'completed',2,1,1,0);
INSERT INTO `discovery_usage_turns` VALUES (228,'2026-10-26 07:21:41.308',31,18,'c2cbb20e-75c8-42ea-8b2b-b0aad158f70f','default',NULL,34,'completed',2,1,1,0);
INSERT INTO `discovery_usage_turns` VALUES (230,'2026-10-26 07:21:41.451',61,18,'c2cbb20e-75c8-42ea-8b2b-b0aad158f70f','default',NULL,36,'completed',2,1,1,0);
INSERT INTO `discovery_usage_turns` VALUES (231,'2026-10-26 07:21:41.858',1860,20,'78fb6d38-f850-4060-a0d8-e724b7a95220','data-studio',NULL,1,'completed',2,1,1,0);
INSERT INTO `discovery_usage_turn_tools` VALUES (124,'2026-10-26 07:21:40.370','c2cbb20e-75c8-42ea-8b2b-b0aad158f70f',20,'file_manage',1,1);
INSERT INTO `discovery_usage_turn_tools` VALUES (133,'2026-10-26 07:21:41.718','0204541e-0b36-4dbb-8517-024773117e45',1,'read',1,1);
INSERT INTO `discovery_usage_turn_tools` VALUES (141,'2026-10-26 07:21:40.932','c2cbb20e-75c8-42ea-8b2b-b0aad158f70f',29,'file_manage',1,1);
INSERT INTO `discovery_usage_turn_tools` VALUES (142,'2026-10-26 07:21:41.014','c2cbb20e-75c8-42ea-8b2b-b0aad158f70f',30,'file_manage',1,1);
INSERT INTO `discovery_usage_turn_tools` VALUES (143,'2026-10-26 07:21:41.135','c2cbb20e-75c8-42ea-8b2b-b0aad158f70f',31,'file_manage',1,1);
INSERT INTO `discovery_usage_turn_tools` VALUES (145,'2026-10-26 07:21:41.275','c2cbb20e-75c8-42ea-8b2b-b0aad158f70f',33,'file_manage',1,1);
INSERT INTO `discovery_usage_turn_tools` VALUES (146,'2026-10-26 07:21:41.308','c2cbb20e-75c8-42ea-8b2b-b0aad158f70f',34,'file_manage',1,1);
INSERT INTO `discovery_usage_turn_tools` VALUES (148,'2026-10-26 07:21:41.451','c2cbb20e-75c8-42ea-8b2b-b0aad158f70f',36,'file_manage',1,1);
INSERT INTO `discovery_usage_turn_tools` VALUES (149,'2026-10-26 07:21:41.858','78fb6d38-f850-4060-a0d8-e724b7a95220',1,'analyze_data',1,1);
INSERT INTO `discovery_usage_ingest` VALUES (1,'shard-0/2026-10-26.jsonl',16860,'2026-10-26 07:18:19','2026-10-26 07:21:46');
INSERT INTO `discovery_usage_ingest` VALUES (2,'shard-1/2026-10-26.jsonl',100153,'2026-10-26 07:18:19','2026-10-26 07:21:46');

-- ===== the dashboard's main queries (run against the rows above) =====
-- per day at UTC+07:00 (fixed offset in SQL, no MariaDB time-zone tables needed)
-- select date(at + interval 420 minute) d, count(*) turns, sum(tool_calls), sum(tool_errors) from discovery_usage_turns where at >= ? and at < ? group by d;
-- tool ranking
-- select tool, sum(calls) calls, sum(errors) errors from discovery_usage_turn_tools where at >= ? and at < ? group by tool order by calls desc limit 20;
-- tokens per model
-- select model, sum(input_tokens), sum(output_tokens), count(*) from discovery_usage_steps where at >= ? and at < ? group by model;
-- daily retention (USAGE_RETENTION_DAYS, default 400)
-- delete from discovery_usage_steps where at < ?; delete from discovery_usage_turns where at < ?; delete from discovery_usage_turn_tools where at < ?;
