-- ============================================================
# v1.1.x 后台管理审计化：停用学科/知识点/题库相关菜单与权限节点
# 说明：后台管理已移除教育三 tab，角色配权树中不再展示对应分组与按钮
# 执行方式：node server/scripts/exec-sql.js server/sql/v1.1.x/20260921-audit-admin-rebrand.sql
-- ============================================================

-- 停用三个教育功能分组
UPDATE `sl_sys_menu` SET `is_enabled` = 0
WHERE `page_key` IN ('grp_subject', 'grp_node', 'grp_question')
  AND `is_enabled` = 1;

-- 停用 subject:* / knowledge_node:* / question:* 按钮权限节点
UPDATE `sl_sys_menu` SET `is_enabled` = 0
WHERE `perm_key` LIKE 'subject:%'
   OR `perm_key` LIKE 'knowledge_node:%'
   OR `perm_key` LIKE 'question:%';
