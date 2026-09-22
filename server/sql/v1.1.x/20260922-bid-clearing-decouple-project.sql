-- =====================================================================
-- 清标分析解绑项目：改为独立功能
-- 执行：node server/scripts/exec-sql.js sql/v1.1.x/20260922-bid-clearing-decouple-project.sql
-- =====================================================================

-- 1. audit_bid_session.project_id 改为可选
ALTER TABLE `audit_bid_session`
  MODIFY COLUMN `project_id` bigint UNSIGNED DEFAULT NULL COMMENT '所属审计项目（可选，NULL 表示独立清标任务）';

-- 2. audit_document.project_id 改为可选
--    【关键】清标分析上传资料复用 /api/audit/documents/upload 管线，
--    该管线在 project_id 为空时写入 NULL；若此列仍为 NOT NULL，
--    上传会直接失败：Column 'project_id' cannot be null。
ALTER TABLE `audit_document`
  MODIFY COLUMN `project_id` bigint UNSIGNED DEFAULT NULL COMMENT '所属审计项目ID（可选，NULL 表示不绑定项目的独立资料，如清标分析）';

-- 3. audit_element.project_id 改为可选
--    【关键】解析流水线 parseService 会为每个解析要素写入 doc.project_id；
--    清标独立资料的 project_id 为 NULL，若此列仍为 NOT NULL，
--    解析会立即失败：Column 'project_id' cannot be null（表现为"解析瞬间全部失败"）。
--    清标分析读取解析内容走 parseService.loadResult(documentId)（按 document_id），不依赖 project_id。
ALTER TABLE `audit_element`
  MODIFY COLUMN `project_id` bigint UNSIGNED DEFAULT NULL COMMENT '所属审计项目ID（可选，NULL 表示不绑定项目的独立资料要素）';

-- 4. 索引调整：保留索引但允许 NULL
-- MySQL 会自动处理 NULL 值的索引，无需修改

-- 5. 说明：audit_check_program / audit_check_item / audit_finding / audit_chat_session /
--    audit_chat_message 仍保持 NOT NULL —— 这些表只由“项目维度”的核对、疑点、问答流程写入，
--    这些流程依然强制关联项目，不在此次解绑范围内。
