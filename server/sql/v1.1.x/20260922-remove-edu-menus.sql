-- =====================================================================
-- 删除教育模块菜单（彻底清理，代码种子已同步移除）
-- page_key: assessment, learning, profile, errors, tutoring, analytics, wrongbook, favorites, memory, home
-- 执行方式: node server/scripts/exec-sql.js sql/v1.1.x/20260922-remove-edu-menus.sql
-- =====================================================================

DELETE FROM `sl_sys_menu` WHERE `page_key` IN (
  'home', 'assessment', 'learning', 'profile', 'errors',
  'tutoring', 'analytics', 'wrongbook', 'favorites', 'memory'
);
