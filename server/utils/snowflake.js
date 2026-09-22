/**
 * 雪花算法ID生成器
 * 参考 ruoyi-vue-plus 的 Sequence 实现
 *
 * ID结构（64位Long）：
 *   0 - 41位时间戳 - 5位数据中心ID - 5位机器ID - 12位序列号
 *
 * 优点：
 *   - 生成18-19位数字ID，无法猜测记录数量和顺序
 *   - 分布式环境下不重复
 *   - 趋势递增，有利于索引性能
 */

// 起始时间戳 (2024-01-01 00:00:00)
const EPOCH = 1704067200000n;

// 各部分位数
const WORKER_ID_BITS = 5n;
const DATACENTER_ID_BITS = 5n;
const SEQUENCE_BITS = 12n;

// 最大值
const MAX_WORKER_ID = (1n << WORKER_ID_BITS) - 1n;        // 31
const MAX_DATACENTER_ID = (1n << DATACENTER_ID_BITS) - 1n; // 31
const SEQUENCE_MASK = (1n << SEQUENCE_BITS) - 1n;         // 4095

// 位移量
const WORKER_ID_SHIFT = SEQUENCE_BITS;                     // 12
const DATACENTER_ID_SHIFT = SEQUENCE_BITS + WORKER_ID_BITS; // 17
const TIMESTAMP_SHIFT = SEQUENCE_BITS + WORKER_ID_BITS + DATACENTER_ID_BITS; // 22

class Snowflake {
  /**
   * @param {number} workerId 工作机器ID (0-31)
   * @param {number} datacenterId 数据中心ID (0-31)
   */
  constructor(workerId = 1, datacenterId = 1) {
    if (workerId > MAX_WORKER_ID || workerId < 0) {
      throw new Error(`workerId must be between 0 and ${MAX_WORKER_ID}`);
    }
    if (datacenterId > MAX_DATACENTER_ID || datacenterId < 0) {
      throw new Error(`datacenterId must be between 0 and ${MAX_DATACENTER_ID}`);
    }
    this.workerId = BigInt(workerId);
    this.datacenterId = BigInt(datacenterId);
    this.sequence = 0n;
    this.lastTimestamp = -1n;
  }

  /**
   * 获取当前时间戳（毫秒）
   */
  #currentTime() {
    return BigInt(Date.now());
  }

  /**
   * 等待到下一毫秒
   */
  #waitNextMillis(lastTimestamp) {
    let timestamp = this.#currentTime();
    while (timestamp <= lastTimestamp) {
      timestamp = this.#currentTime();
    }
    return timestamp;
  }

  /**
   * 生成下一个ID
   * @returns {string} 字符串形式的ID（避免JS大数精度丢失）
   */
  nextId() {
    let timestamp = this.#currentTime();

    if (timestamp < this.lastTimestamp) {
      // 时钟回拨，抛出异常
      throw new Error(
        `Clock moved backwards. Refusing to generate id for ${this.lastTimestamp - timestamp}ms`
      );
    }

    if (timestamp === this.lastTimestamp) {
      // 同一毫秒内，序列号自增
      this.sequence = (this.sequence + 1n) & SEQUENCE_MASK;
      if (this.sequence === 0n) {
        // 序列号溢出，等待下一毫秒
        timestamp = this.#waitNextMillis(this.lastTimestamp);
      }
    } else {
      // 不同毫秒，序列号重置为0
      this.sequence = 0n;
    }

    this.lastTimestamp = timestamp;

    // 拼装ID
    const id =
      ((timestamp - EPOCH) << TIMESTAMP_SHIFT) |
      (this.datacenterId << DATACENTER_ID_SHIFT) |
      (this.workerId << WORKER_ID_SHIFT) |
      this.sequence;

    return id.toString();
  }

  /**
   * 生成下一个ID，返回BigInt
   * @returns {bigint}
   */
  nextIdBigInt() {
    return BigInt(this.nextId());
  }

  /**
   * 批量生成ID
   * @param {number} count
   * @returns {string[]}
   */
  nextIds(count) {
    const ids = [];
    for (let i = 0; i < count; i++) {
      ids.push(this.nextId());
    }
    return ids;
  }
}

// 默认单例实例（可根据环境变量配置workerId和datacenterId）
const workerId = parseInt(process.env.SNOWFLAKE_WORKER_ID || '1');
const datacenterId = parseInt(process.env.SNOWFLAKE_DATACENTER_ID || '1');
const snowflake = new Snowflake(workerId, datacenterId);

module.exports = snowflake;
module.exports.Snowflake = Snowflake;
