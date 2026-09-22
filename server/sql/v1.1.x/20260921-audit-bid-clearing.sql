-- =====================================================================
-- 工程审计 · 清标分析模块（bid-clearing）
-- 1) audit_bid_session   清标任务：一个项目下可有多次清标，聚合「1 份招标控制价 + N 家投标方」
-- 2) audit_bid_party     投标方
-- 3) audit_bid_party_doc 投标方 ↔ 资料（audit_document）关联
-- 4) 侧边栏菜单：清标分析（id=105，沿用审计模块固定 id 100+ 约定）
-- 适用：MySQL 5.7+ / 8.0；执行方式 node server/scripts/exec-sql.js sql/v1.1.x/20260921-audit-bid-clearing.sql
-- =====================================================================

-- ---------------------------------------------------------------------
-- 清标任务
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `audit_bid_session` (
  `id`              bigint UNSIGNED NOT NULL COMMENT '清标任务ID（雪花算法）',
  `project_id`      bigint UNSIGNED NOT NULL COMMENT '所属审计项目',
  `title`           varchar(200) NOT NULL COMMENT '任务名称',
  `control_doc_id`  bigint UNSIGNED DEFAULT NULL COMMENT '招标控制价资料ID（audit_document.id）',
  `status`          varchar(20) NOT NULL DEFAULT 'draft'
                    COMMENT 'draft 草稿 / analyzing 分析中 / done 已完成 / failed 失败',
  `report_md`       mediumtext COMMENT 'AI 生成的 Markdown 清标报告',
  `model_info`      varchar(255) DEFAULT NULL COMMENT '实际应答模型',
  `usage_json`      varchar(1000) DEFAULT NULL COMMENT 'token 用量 JSON',
  `error_msg`       varchar(2000) DEFAULT NULL COMMENT '分析失败原因',
  `analyzed_at`     datetime(3) DEFAULT NULL COMMENT '最近分析完成时间',
  `del_flag`        tinyint NOT NULL DEFAULT 0,
  `created_by`      bigint UNSIGNED DEFAULT NULL,
  `created_at`      datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_by`      bigint UNSIGNED DEFAULT NULL,
  `updated_at`      datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `remark`          varchar(500) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_project` (`project_id`, `del_flag`),
  KEY `idx_control` (`control_doc_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='清标分析任务表';

-- ---------------------------------------------------------------------
-- 投标方
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `audit_bid_party` (
  `id`          bigint UNSIGNED NOT NULL COMMENT '投标方ID（雪花算法）',
  `session_id`  bigint UNSIGNED NOT NULL COMMENT '所属清标任务',
  `party_name`  varchar(200) NOT NULL COMMENT '投标单位名称',
  `sort_no`     int NOT NULL DEFAULT 0,
  `del_flag`    tinyint NOT NULL DEFAULT 0,
  `created_by`  bigint UNSIGNED DEFAULT NULL,
  `created_at`  datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_by`  bigint UNSIGNED DEFAULT NULL,
  `updated_at`  datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `remark`      varchar(500) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_session` (`session_id`, `del_flag`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='清标投标方表';

-- ---------------------------------------------------------------------
-- 投标方 ↔ 资料关联
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `audit_bid_party_doc` (
  `id`          bigint UNSIGNED NOT NULL COMMENT '关联ID（雪花算法）',
  `party_id`    bigint UNSIGNED NOT NULL,
  `document_id` bigint UNSIGNED NOT NULL COMMENT 'audit_document.id',
  `created_by`  bigint UNSIGNED DEFAULT NULL,
  `created_at`  datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_party_doc` (`party_id`, `document_id`),
  KEY `idx_document` (`document_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='清标投标方资料关联表';

-- ---------------------------------------------------------------------
-- 侧边栏菜单（管理员自动可见；普通角色需在角色管理中配权）
-- ---------------------------------------------------------------------
INSERT IGNORE INTO `sl_sys_menu`
  (`id`, `page_key`, `menu_name`, `menu_icon`, `menu_url`, `sort_no`, `is_enabled`, `is_builtin`)
VALUES
  (105, 'audit-bid-clearing', '清标分析', '🧹', '/pc/audit-bid-clearing.html', 95, 1, 1);
