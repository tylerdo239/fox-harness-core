-- Per-user skills (docs/skill-transfer-plan.md, giai đoạn 2). Owned by
-- services/gateway; services/orchestrator only ever receives the rendered
-- files for a session, never owner_id.
--
-- Limits mirror services/gateway/src/skills.ts (name ≤ 64, description ≤ 280;
-- content ≤ 64 KB is checked there, mediumtext just has to hold it).
create table if not exists custom_skills (
  owner_id int not null,
  name varchar(64) not null,
  description varchar(280) not null,
  content mediumtext not null,
  created_at datetime not null default current_timestamp,
  updated_at datetime not null default current_timestamp,
  primary key (owner_id, name),
  constraint custom_skills_owner_id_fkey foreign key (owner_id) references users (id) on delete cascade
) engine=innodb;
