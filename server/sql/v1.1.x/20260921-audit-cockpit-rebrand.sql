-- =============================================================
-- v1.1.x 20260921 审计驾驶舱改造：登录页/首页由旧教育产品改为工程审计
-- 1) 旧「学习首页」(id=1) 更名为「审计驾驶舱」，仍指向 /pc/index.html
-- 2) 兜底禁用所有旧教育菜单（多数已禁用，确保新装/历史库一致）
-- 注意：执行后浏览器需 sessionStorage.removeItem('sidebarMenus') 或重新登录
-- =============================================================

UPDATE `sl_sys_menu`
   SET `menu_name` = '审计驾驶舱', `menu_icon` = '🧭'
 WHERE `id` = 1;

UPDATE `sl_sys_menu`
   SET `is_enabled` = 0
 WHERE `parent_id` = 0
   AND `page_key` IN ('assessment','learning','profile','errors','tutoring',
                      'analytics','wrongbook','memory','favorites')
   AND `is_enabled` = 1;
