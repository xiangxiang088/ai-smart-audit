/**
 * 流式 JSON 字符串字段增量解码器
 *
 * 场景：成稿阶段要求模型输出强约束 JSON（{"answer":"...","citationEids":[...]}），
 * 但又想让用户边生成边看到正文。直接把 SSE 原文推给前端会暴露 JSON 外壳，
 * 也会把「半个转义序列」（如结尾正好是 \ 或 \u4e2）渲染成乱码。
 *
 * 本模块在服务端按字符推进状态机，只把 answer 字段**已确定完整**的部分吐出来：
 *   - 反斜杠后字符还没到 → 停住等下一块（不吐半截）
 *   - \uXXXX 不足 4 位十六进制 → 停住等下一块
 *   - 遇到未转义的结束引号 → 标记完成，之后不再产出
 *   - 值里出现代理对（\ud83d\ude00）时两段独立解码后天然拼成完整字符
 *
 * @param {string} field 要提取的字段名，如 'answer'
 * @returns {{push:(chunk:string)=>string, value:()=>string, isDone:()=>boolean, reset:()=>void}}
 *          push 返回「本次新增的明文片段」，无新增返回空串
 */
function createJsonFieldStreamer(field) {
  const needle = new RegExp(`"${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*"`);
  const ESC = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
  // 键名迟迟不出现就别再扫了：说明模型没按约定先输出该字段。
  // 让 done 事件里的最终答案兜底，避免在这里空转到流结束。
  const GIVE_UP_AT = 2000;

  let buf = '';            // 已收到的原始流文本
  let scan = 0;            // 找键名时的游标（避免每次从头重扫）
  let pos = -1;            // 值内容的读取位置；-1 表示还没定位到
  let out = '';            // 已解码出的明文
  let pushed = 0;          // 已吐出的长度
  let done = false;        // 是否已读到值的结束引号
  let gaveUp = false;

  function reset() {
    buf = ''; scan = 0; pos = -1; out = ''; pushed = 0; done = false; gaveUp = false;
  }

  /** 定位 `"answer" : "` 的起始，返回值第一个字符的下标；未出现返回 -1 */
  function locate() {
    for (;;) {
      const m = needle.exec(buf.slice(scan));
      if (m) return scan + m.index + m[0].length;
      // 没匹配到：把游标退回到可能被截断的键名开头，等下一块拼上再来
      scan = Math.max(0, buf.length - 32);
      return -1;
    }
  }

  /** 从 pos 起逐字符解码，遇不完整转义即中断等待 */
  function decode() {
    let i = pos;
    for (; i < buf.length; i++) {
      const ch = buf[i];
      if (ch === '\\') {
        const next = buf[i + 1];
        if (next === undefined) break;                 // 转义序列跨块，等
        if (next === 'u') {
          if (i + 6 > buf.length) break;               // \uXXXX 不足 4 位，等
          const hex = buf.slice(i + 2, i + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 5;
            pos = i + 1;
            continue;
          }
          // 非法 \u 序列：按普通字符容错，不卡死
          out += 'u';
          i += 1;
          pos = i + 1;
          continue;
        }
        const mapped = ESC[next];
        if (mapped !== undefined) {
          out += mapped;
          i += 1;
          pos = i + 1;
          continue;
        }
        // 未知转义：保留原字符，避免整段卡住
        out += next;
        i += 1;
        pos = i + 1;
        continue;
      }
      if (ch === '"') {                                // 值结束
        done = true;
        pos = i + 1;
        return;
      }
      out += ch;
      pos = i + 1;
    }
  }

  function push(chunk) {
    if (done || gaveUp || !chunk) return '';
    buf += chunk;
    if (pos < 0) {
      const at = locate();
      if (at < 0) {
        if (buf.length > GIVE_UP_AT) gaveUp = true;
        return '';
      }
      pos = at;
    }
    decode();
    if (out.length <= pushed) return '';
    const delta = out.slice(pushed);
    pushed = out.length;
    return delta;
  }

  return {
    push,
    value: () => out,
    isDone: () => done,
    reset
  };
}

module.exports = { createJsonFieldStreamer };
