// 共用于侧栏、收集脚本和后台。各计薪方式独立比较，不推算实习天数或年终奖。
var BOSS_SALARY = (() => {
  const units = { month: 'K/月', day: '元/天', year: '万/年' };
  function config(cfg = {}) {
    const period = cfg.salaryPeriod || '';
    if (!period) return { period: '' };
    if (!units[period]) throw new Error('请选择有效的计薪方式');
    function bound(value) {
      if (value === undefined || value === null || String(value).trim() === '') return null;
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) throw new Error('薪资请输入大于或等于 0 的数字');
      return n;
    }
    const min = bound(cfg.salaryMin), max = bound(cfg.salaryMax);
    if (min !== null && max !== null && min > max) throw new Error('薪资下限不能高于上限');
    return { period, min, max, includeUnknown: cfg.salaryUnknown !== false };
  }
  function normalize(value) {
    // BOSS 列表 kanzhun 字体：U+E031…U+E03A 显示为 0…9。
    // 2026-10-27 实际卡片 U+E035-U+E036K 与同岗位详情 4-5K 核对。
    // 只转换已知数字区间；其他私有字符不猜测，启用筛选时拒绝放行。
    return String(value || '').normalize('NFKC').replace(/[\ue031-\ue03a]/g, c => String(c.charCodeAt(0) - 0xe031)).trim();
  }
  function parse(value) {
    let text = normalize(value).replace(/\s/g, '').replace(/[—–~～至]/g, '-').toLowerCase();
    // 多薪只属于月薪备注，不当作薪资范围或年薪换算依据。
    text = text.replace(/[·•・.]\d+(?:\.\d+)?薪$/, '');
    const m = text.match(/^(\d+(?:\.\d+)?)(k|千|万|元)?(?:-(\d+(?:\.\d+)?)(k|千|万|元)?)?(以上|以下)?(?:(?:\/|每)(月|天|日|年))?$/);
    if (!m) return null;
    const unit = m[4] || m[2] || '';
    const period = m[6] ? ({ 月: 'month', 天: 'day', 日: 'day', 年: 'year' })[m[6]] : (unit && unit !== '元' ? 'month' : '');
    if (!period) return null;
    const factor = u => ({ k: 1000, 千: 1000, 万: 10000, 元: 1 })[u] || 1;
    let min = Number(m[1]) * factor(m[2] || unit);
    let max = m[3] ? Number(m[3]) * factor(m[4] || unit) : min;
    if (min > max || (m[3] && m[5])) return null;
    if (m[5] === '以上') max = Infinity;
    if (m[5] === '以下') min = 0;
    const scale = period === 'month' ? 1000 : period === 'year' ? 10000 : 1;
    return { period, min: min / scale, max: max / scale };
  }
  function matches(value, filter) {
    if (!filter || !filter.period) return true;
    const salary = parse(value);
    if (!salary) {
      // 未公布与无法解析是两回事。带数字或未知字体的异常格式不能借“保留面议”绕过下限。
      const text = normalize(value).replace(/\s/g, '');
      return !!filter.includeUnknown && /^(?:|(?:薪资|薪酬|工资)?(?:面议|保密|待定|未标明|未公布)|暂无薪资|--?|—)$/.test(text);
    }
    return salary.period === filter.period && salary.max >= (filter.min ?? 0) && salary.min <= (filter.max ?? Infinity);
  }
  function describe(filter) {
    if (!filter.period) return '不限';
    return (filter.min ?? 0) + '–' + (filter.max ?? '不限') + ' ' + units[filter.period]
      + '（区间有交集；' + (filter.includeUnknown ? '保留' : '排除') + '面议／未知薪资）';
  }
  return { config, normalize, parse, matches, describe };
})();
