/**
 * 日志记录模块
 * - recordLoginLog: 记录登录/登出日志
 * - recordLogoutLog: 记录登出日志
 * - operLog: 操作日志中间件，自动记录请求信息、响应结果、耗时
 * - resolveIpLocation: IP归属地解析（带缓存）
 */
const db = require('./db');
const snowflake = require('./utils/snowflake');

// IP归属地缓存（内存缓存，避免重复请求API）
const ipLocationCache = new Map();
const IP_CACHE_MAX_SIZE = 1000;
const IP_CACHE_TTL = 24 * 60 * 60 * 1000; // 24小时过期

/**
 * 解析IP归属地（内网IP直接返回，外网IP调用免费API）
 * 降级策略：ip2location.io(精度高，免费1000/天) → ip-api.com(中文国际覆盖)
 */
async function resolveIpLocation(ip) {
  if (!ip) return '';

  // 内网IP/本地IP处理
  if (ip === '::1' || ip === '127.0.0.1' || ip === 'localhost' || ip.startsWith('192.168.') ||
      ip.startsWith('10.') || ip.startsWith('172.16.') || ip.startsWith('172.17.') ||
      ip.startsWith('172.18.') || ip.startsWith('172.19.') || ip.startsWith('172.2') ||
      ip.startsWith('172.30.') || ip.startsWith('172.31.') || ip.startsWith('127.')) {
    return '内网IP';
  }

  // 检查缓存
  const cacheKey = ip;
  const cached = ipLocationCache.get(cacheKey);
  if (cached && Date.now() - cached.time < IP_CACHE_TTL) {
    return cached.location;
  }

  // 缓存写入辅助函数
  const setCache = (location) => {
    if (ipLocationCache.size >= IP_CACHE_MAX_SIZE) {
      const firstKey = ipLocationCache.keys().next().value;
      ipLocationCache.delete(firstKey);
    }
    ipLocationCache.set(cacheKey, { location, time: Date.now() });
  };

  // 通用 fetch 超时函数
  const fetchWithTimeout = async (url, timeoutMs = 3003) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      return resp;
    } catch (e) {
      clearTimeout(timeout);
      throw e;
    }
  };

  // 中国省份英文→中文映射（ip2location返回英文名）
  const PROVINCE_CN = {
    'Beijing': '北京', 'Shanghai': '上海', 'Tianjin': '天津', 'Chongqing': '重庆',
    'Guangdong': '广东', 'Zhejiang': '浙江', 'Jiangsu': '江苏', 'Shandong': '山东',
    'Henan': '河南', 'Hebei': '河北', 'Hubei': '湖北', 'Hunan': '湖南',
    'Sichuan': '四川', 'Fujian': '福建', 'Anhui': '安徽', 'Jiangxi': '江西',
    'Liaoning': '辽宁', 'Heilongjiang': '黑龙江', 'Jilin': '吉林', 'Shanxi': '山西',
    'Shaanxi': '陕西', 'Yunnan': '云南', 'Guizhou': '贵州', 'Gansu': '甘肃',
    'Qinghai': '青海', 'Hainan': '海南', 'Taiwan': '台湾',
    'Inner Mongolia': '内蒙古', 'Nei Mongol': '内蒙古',
    'Guangxi': '广西', 'Tibet': '西藏', 'Xizang': '西藏', 'Ningxia': '宁夏',
    'Xinjiang': '新疆', 'Hong Kong': '香港', 'Macau': '澳门',
  };
  // 常见城市英文→中文映射
  const CITY_CN = {
    'Beijing': '北京', 'Shanghai': '上海', 'Tianjin': '天津', 'Chongqing': '重庆',
    'Guangzhou': '广州', 'Shenzhen': '深圳', 'Dongguan': '东莞', 'Foshan': '佛山',
    'Zhuhai': '珠海', 'Zhongshan': '中山', 'Huizhou': '惠州', 'Jiangmen': '江门',
    'Hangzhou': '杭州', 'Ningbo': '宁波', 'Wenzhou': '温州', 'Jinhua': '金华',
    'Nanjing': '南京', 'Suzhou': '苏州', 'Wuxi': '无锡', 'Changzhou': '常州',
    'Jinan': '济南', 'Qingdao': '青岛', 'Yantai': '烟台', 'Weifang': '潍坊',
    'Zhengzhou': '郑州', 'Luoyang': '洛阳', 'Kaifeng': '开封',
    'Wuhan': '武汉', 'Yichang': '宜昌', 'Xiangyang': '襄阳',
    'Changsha': '长沙', 'Zhuzhou': '株洲', 'Xiangtan': '湘潭',
    'Chengdu': '成都', 'Mianyang': '绵阳', 'Leshan': '乐山',
    'Fuzhou': '福州', 'Xiamen': '厦门', 'Quanzhou': '泉州',
    'Hefei': '合肥', 'Wuhu': '芜湖',
    'Nanchang': '南昌', 'Jiujiang': '九江', 'Ganzhou': '赣州',
    'Shenyang': '沈阳', 'Dalian': '大连', 'Anshan': '鞍山',
    'Harbin': '哈尔滨', 'Daqing': '大庆',
    'Changchun': '长春', 'Jilin City': '吉林',
    'Taiyuan': '太原', 'Datong': '大同',
    "Xi'an": '西安', "Xi'an": '西安', 'Xian': '西安', 'Baoji': '宝鸡',
    'Kunming': '昆明', 'Qujing': '曲靖', 'Dali': '大理', 'Lijiang': '丽江',
    'Guiyang': '贵阳', 'Zunyi': '遵义',
    'Lanzhou': '兰州', 'Tianshui': '天水',
    'Xining': '西宁',
    'Haikou': '海口', 'Sanya': '三亚',
    'Taipei': '台北', 'Kaohsiung': '高雄', 'Taichung': '台中',
    'Hohhot': '呼和浩特', 'Baotou': '包头',
    'Nanning': '南宁', 'Guilin': '桂林', 'Liuzhou': '柳州',
    'Lhasa': '拉萨',
    'Yinchuan': '银川',
    'Urumqi': '乌鲁木齐',
    'Hong Kong': '香港',
    'Macau': '澳门', 'Macao': '澳门',
  };
  // 国家英文→中文（常见国家）
  const COUNTRY_CN = {
    'China': '中国', 'United States': '美国', 'Japan': '日本', 'Korea, Republic of': '韩国',
    'South Korea': '韩国', 'Korea': '韩国', 'North Korea': '朝鲜',
    'United Kingdom': '英国', 'Germany': '德国', 'France': '法国', 'Italy': '意大利',
    'Spain': '西班牙', 'Portugal': '葡萄牙', 'Netherlands': '荷兰', 'Belgium': '比利时',
    'Switzerland': '瑞士', 'Sweden': '瑞典', 'Norway': '挪威', 'Finland': '芬兰',
    'Denmark': '丹麦', 'Russia': '俄罗斯', 'Canada': '加拿大', 'Australia': '澳大利亚',
    'New Zealand': '新西兰', 'Singapore': '新加坡', 'Malaysia': '马来西亚',
    'Thailand': '泰国', 'Vietnam': '越南', 'Philippines': '菲律宾', 'Indonesia': '印度尼西亚',
    'India': '印度', 'Pakistan': '巴基斯坦', 'Brazil': '巴西', 'Argentina': '阿根廷',
    'Mexico': '墨西哥', 'South Africa': '南非', 'Egypt': '埃及', 'Turkey': '土耳其',
    'Israel': '以色列', 'Saudi Arabia': '沙特阿拉伯', 'United Arab Emirates': '阿联酋',
  };
  const toCN = (name, map) => (name && map[name]) ? map[name] : name;

  // ISP名称统一中文
  const cleanIsp = (isp) => {
    if (!isp) return '';
    const ispMap = {
      'China Mobile communications corporation': '中国移动',
      'China Mobile Communications Corporation': '中国移动',
      'China Mobile': '中国移动',
      'China Unicom': '中国联通',
      'China Telecom': '中国电信',
      'China Tietong': '中国铁通',
      'CHINANET BACKBONE': '中国电信',
      'Chinanet': '中国电信',
      'CHINANET': '中国电信',
      'Alibaba': '阿里云', 'Tencent': '腾讯云', 'Huawei': '华为云',
      'Amazon': 'AWS', 'Cloudflare': 'Cloudflare', 'Google': 'Google',
      'Tencent Cloud': '腾讯云', 'Baidu': '百度',
    };
    // ip2location返回 "AS4134 China Telecom" 格式，去掉AS前缀
    const asMatch = isp.match(/^AS\d+\s+(.+)$/);
    if (asMatch) isp = asMatch[1];
    for (const [key, val] of Object.entries(ispMap)) {
      if (isp.includes(key)) return val;
    }
    return isp.trim();
  };

  let location = '';

  // 主接口：ip2location.io（经测试对国内IP城市精度最高，免费1000次/天无需注册）
  try {
    const resp = await fetchWithTimeout(`https://api.ip2location.io/?ip=${ip}`);
    if (resp.ok) {
      const data = await resp.json();
      if (data.country_code) {
        const parts = [];
        // 国家：中国转中文，其他国家尽量转中文否则保留英文
        const countryCN = toCN(data.country_name, COUNTRY_CN) || data.country_name;
        parts.push(countryCN);
        // 省份：中国省份转中文
        if (data.region_name && data.region_name !== data.country_name) {
          parts.push(toCN(data.region_name, PROVINCE_CN) || data.region_name);
        }
        // 城市：中国城市转中文
        if (data.city_name && data.city_name !== data.region_name) {
          parts.push(toCN(data.city_name, CITY_CN) || data.city_name);
        }
        location = parts.join(' ');
        // 运营商
        if (data.as) {
          const isp = cleanIsp(data.as);
          if (isp && !location.includes(isp)) location += ' ' + isp;
        }
        location = location.trim();

        if (location) {
          setCache(location);
          return location;
        }
      }
    }
  } catch (err) {
    // ip2location 失败，继续尝试备用
  }

  // 备用接口：ip-api.com（支持中文lang=zh-CN，国际IP覆盖好）
  try {
    const resp = await fetchWithTimeout(`http://ip-api.com/json/${ip}?lang=zh-CN&fields=status,country,regionName,city,isp`);
    if (resp.ok) {
      const data = await resp.json();
      if (data.status === 'success') {
        const parts = [];
        if (data.country) parts.push(data.country);
        if (data.regionName && data.regionName !== data.city) parts.push(data.regionName);
        if (data.city) parts.push(data.city);
        location = parts.join(' ');
        if (data.isp) location += ' ' + cleanIsp(data.isp);
        location = location.trim();
      }

      setCache(location);
      return location;
    }
  } catch (err) {
    // 所有接口都失败，缓存空结果避免重复请求
    setCache('');
  }

  return '';
}

/**
 * 解析User-Agent获取浏览器、操作系统、设备类型
 */
function parseUserAgent(ua) {
  if (!ua) return { browser: 'unknown', os: 'unknown', device_type: 'other' };

  let browser = 'unknown';
  let os = 'unknown';
  let device_type = 'pc';

  // 浏览器识别
  if (ua.includes('MicroMessenger')) browser = '微信';
  else if (ua.includes('Edg/')) browser = 'Edge';
  else if (ua.includes('Chrome/')) browser = 'Chrome';
  else if (ua.includes('Firefox/')) browser = 'Firefox';
  else if (ua.includes('Safari/')) browser = 'Safari';
  else if (ua.includes('MSIE') || ua.includes('Trident/')) browser = 'IE';

  // 操作系统识别
  if (ua.includes('Windows NT')) {
    os = 'Windows';
    if (ua.includes('Windows NT 10')) os = 'Windows 10/11';
    else if (ua.includes('Windows NT 6.3')) os = 'Windows 8.1';
    else if (ua.includes('Windows NT 6.1')) os = 'Windows 7';
  }
  else if (ua.includes('Mac OS X')) os = 'macOS';
  else if (ua.includes('Android')) {
    os = 'Android';
    const match = ua.match(/Android\s([\d.]+)/);
    if (match) os = 'Android ' + match[1];
  }
  else if (ua.includes('iPhone')) os = 'iOS';
  else if (ua.includes('iPad')) os = 'iOS(iPad)';
  else if (ua.includes('Linux')) os = 'Linux';

  // 设备类型
  if (ua.includes('Mobile') || ua.includes('Android') || ua.includes('iPhone')) {
    device_type = 'mobile';
  } else if (ua.includes('iPad') || ua.includes('Tablet')) {
    device_type = 'tablet';
  }

  return { browser, os, device_type };
}

/**
 * 获取客户端IP地址
 * 支持 Nginx 等反向代理场景，优先从代理头中读取真实IP
 */
function getClientIp(req) {
  let ip = '';

  // 1. 优先从 X-Forwarded-For 获取（格式: client, proxy1, proxy2，取第一个真实客户端IP）
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const firstIp = xff.split(',')[0]?.trim();
    if (firstIp) ip = firstIp;
  }

  // 2. 其次 X-Real-IP（Nginx 常用配置）
  if (!ip) {
    ip = req.headers['x-real-ip'] || '';
  }

  // 3. Express 提供的 req.ip（开启 trust proxy 后会自动从代理头解析）
  if (!ip) {
    ip = req.ip || '';
  }

  // 4. 最后兜底取 socket 远端地址
  if (!ip) {
    ip = req.socket?.remoteAddress || '';
  }

  // 处理 IPv6 映射的 IPv4 地址 (::ffff:192.168.1.1 -> 192.168.1.1)
  if (ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }

  // IPv6 回环地址转 IPv4
  if (ip === '::1') {
    ip = '127.0.0.1';
  }

  return ip;
}

/**
 * 记录登录日志
 * @param {Object} params
 * @param {string} params.username - 登录用户名
 * @param {number|null} params.userId - 用户ID（成功时有值）
 * @param {string} params.status - '0'成功 '1'失败
 * @param {string} params.msg - 消息
 * @param {Object} params.req - Express request对象
 */
async function recordLoginLog({ username, userId = null, status = '0', msg = '', req }) {
  try {
    const ua = req.headers['user-agent'] || '';
    const { browser, os, device_type } = parseUserAgent(ua);
    const ipaddr = getClientIp(req);
    const location = await resolveIpLocation(ipaddr);

    const logId = snowflake.nextId();
    await db.query(
      `INSERT INTO sl_sys_login_log (id, user_name, user_id, ipaddr, login_location, browser, os, device_type, status, msg, login_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [logId, username, userId, ipaddr, location.substring(0, 255), browser, os, device_type, status, msg.substring(0, 255)]
    );
  } catch (err) {
    console.error('[logger] 记录登录日志失败:', err.message);
  }
}

/**
 * 记录登出日志
 */
async function recordLogoutLog(req, userId, username) {
  try {
    const ua = req.headers['user-agent'] || '';
    const { browser, os, device_type } = parseUserAgent(ua);
    const ipaddr = getClientIp(req);
    const location = await resolveIpLocation(ipaddr);

    const logId = snowflake.nextId();
    await db.query(
      `INSERT INTO sl_sys_login_log (id, user_name, user_id, ipaddr, login_location, browser, os, device_type, status, msg, login_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '0', '退出登录', NOW())`,
      [logId, username || '', userId, ipaddr, location.substring(0, 255), browser, os, device_type]
    );
  } catch (err) {
    console.error('[logger] 记录登出日志失败:', err.message);
  }
}

/**
 * 操作日志中间件工厂
 * @param {string} title - 模块标题，如"账本管理"、"记录管理"
 * @param {number} businessType - 业务类型：0其它 1新增 2修改 3删除
 * @returns Express middleware
 */
/**
 * 写一条操作日志。
 * 从 operLog 中间件里抽出来，供「不走 res.json 的接口」复用——
 * 典型是 SSE 流式接口（智能问答），响应是 res.write 的，中间件捕捉不到。
 * @param {object} p
 * @param {string} p.title 模块标题，如「智能问答」
 * @param {number} [p.businessType] 0其它 1新增 2修改 3删除
 * @param {object} p.req Express 请求对象（取 IP / UA / 参数 / 登录用户）
 * @param {*} [p.result] 响应数据，仅截断保存前 4000 字符
 * @param {number} [p.statusCode] HTTP 状态码
 * @param {number} [p.costTime] 耗时（毫秒）
 * @param {string} [p.errorMsg] 自定义失败说明（流式接口无 JSON 响应体时使用）
 */
async function recordOperLog({ title, businessType = 0, req, result = null, statusCode = 200, costTime = 0, errorMsg = '' }) {
  try {
    const ua = req.headers['user-agent'] || '';
    const { device_type } = parseUserAgent(ua);
    const ipaddr = getClientIp(req);
    const location = await resolveIpLocation(ipaddr);

    const operatorType = device_type === 'mobile' ? 2 : 1;

    // 请求参数（过滤敏感字段）
    let operParam = '';
    try {
      const params = { ...req.params, ...req.query, ...req.body };
      delete params.password;
      delete params.old_password;
      delete params.new_password;
      delete params.token;
      delete params.image_base64; // OCR图片base64太大，不记录
      operParam = JSON.stringify(params).substring(0, 4000);
    } catch (e) {}

    // 响应结果
    let jsonResult = '';
    let status = 0;
    let failMsg = errorMsg;
    try {
      jsonResult = JSON.stringify(result).substring(0, 4000);
      if (failMsg || (result && result.error) || statusCode >= 400) {
        status = 1;
        failMsg = failMsg || (result && result.error) || '请求失败';
      }
    } catch (e) {}

    const operLogId = snowflake.nextId();
    await db.query(
      `INSERT INTO sl_sys_oper_log
       (id, title, business_type, method, request_method, operator_type, oper_name, user_id,
        oper_url, oper_ip, oper_location, oper_param, json_result, status, error_msg, cost_time, oper_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        operLogId,
        title,
        businessType,
        req.route?.path || req.path,
        req.method,
        operatorType,
        req.user?.username || '',
        req.userId || null,
        req.originalUrl?.substring(0, 255) || '',
        ipaddr,
        location.substring(0, 255),
        operParam,
        jsonResult,
        status,
        String(failMsg || '').substring(0, 4000),
        costTime
      ]
    );
  } catch (err) {
    console.error('[logger] 记录操作日志失败:', err.message);
  }
}

function operLog(title, businessType = 0) {
  return async (req, res, next) => {
    const startTime = Date.now();
    const originalJson = res.json.bind(res);

    res.json = function (data) {
      const costTime = Date.now() - startTime;

      // 异步记录日志，不阻塞响应
      setImmediate(() => recordOperLog({
        title, businessType, req, result: data, statusCode: res.statusCode, costTime
      }));

      return originalJson(data);
    };

    next();
  };
}

module.exports = { recordLoginLog, recordLogoutLog, operLog, recordOperLog, resolveIpLocation };
