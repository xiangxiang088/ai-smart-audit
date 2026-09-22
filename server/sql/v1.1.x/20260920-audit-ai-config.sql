-- ============================================================
-- v1.1.x 审计 Agent 模型配置表（主模型 + 备用模型自动故障切换）
-- 用户可在页面上决定当前使用哪个模型；apiKey/baseUrl 留空时回退 .env 的 ARK_API_KEY / ARK_BASE_URL
-- 执行：node server/scripts/exec-sql.js server/sql/v1.1.x/20260920-audit-ai-config.sql
--
-- ⚠️ 本表已被统一配置中心取代：后续 20260922-unified-config-store.sql 会把 config_json
--    迁入 sl_sys_config 的 audit.ai 域（键 model_chain），arkClient 改用 configStore 读写。
--    本表仅作为回滚快照保留，新代码不再读写；确认稳定后可手动 DROP。
-- ============================================================

CREATE TABLE IF NOT EXISTS `audit_ai_config` (
  `id` tinyint UNSIGNED NOT NULL DEFAULT 1 COMMENT '固定单行 id=1',
  `config_json` mediumtext NOT NULL COMMENT '模型链配置JSON（activeModel/failoverEnabled/models[]）',
  `updated_by` bigint UNSIGNED DEFAULT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='审计Agent模型配置（主备故障切换）';

INSERT INTO `audit_ai_config` (`id`, `config_json`)
VALUES (1, '{"failoverEnabled":true,"activeModel":"doubao-seed-evolving","models":[{"key":"seed-evolving","label":"Doubao-Seed-Evolving（投稿口径 = Seed-2.1-pro-0915）","model":"doubao-seed-evolving","baseUrl":"","apiKey":"","role":"primary","enabled":true,"supportsTools":true,"supportsVision":true,"freeQuota":"50万tokens免费额度","note":"活动指定模型，工具调用/多模态/Agent 能力最强"},{"key":"seed-21-turbo","label":"Doubao-Seed-2.1-turbo（备用1）","model":"doubao-seed-2-1-turbo-260628","baseUrl":"","apiKey":"","role":"backup","enabled":true,"supportsTools":true,"supportsVision":true,"freeQuota":"50万tokens免费额度","note":"同代 turbo，效果与成本均衡，主模型欠费/限流时自动顶上"},{"key":"seed-20-lite","label":"Doubao-Seed-2.0-lite（备用2）","model":"doubao-seed-2-0-lite-260215","baseUrl":"","apiKey":"","role":"backup","enabled":true,"supportsTools":true,"supportsVision":true,"freeQuota":"免费额度","note":"再兜底，轻量低成本"}]}')
ON DUPLICATE KEY UPDATE `id` = `id`;
