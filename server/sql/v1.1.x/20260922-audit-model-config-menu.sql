-- ============================================================
-- v1.1.x 模型配置页菜单（侧边栏独立入口）
--
-- 背景：模型链原先藏在「审计项目」页右上角的一个弹窗里，入口太深、用户找不到，
--       且备用模型的降级顺序无法调整 —— 表现就是「明明只想用第 3 个模型，
--       却每次都要先等前两个各失败一次（各 5 分钟）」。
--       现独立出 /pc/ai-model-config.html：可排序、可停用、可一键"只用此模型"。
--
-- 执行：node server/scripts/exec-sql.js server/sql/v1.1.x/20260922-audit-model-config-menu.sql
-- 回滚：DELETE FROM `sl_sys_menu` WHERE `page_key` = 'audit-model-config';
-- ============================================================

-- 侧边栏菜单（id 沿用审计模块 100+ 约定；106 未被占用，105 = 清标分析）
-- is_builtin=1：内置菜单，不在「菜单管理」中被误删
INSERT IGNORE INTO `sl_sys_menu`
  (`id`, `page_key`, `menu_name`, `menu_icon`, `menu_url`, `sort_no`, `is_enabled`, `is_builtin`)
VALUES
  (106, 'audit-model-config', '模型配置', '🤖', '/pc/ai-model-config.html', 96, 1, 1);
