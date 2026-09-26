#!/usr/bin/env python3
"""收藏夹噪音过滤 —— 把"不该进学习库"的条目挡在外面

为什么需要这一步：
    抖音的 `/aweme/v1/web/aweme/favorite/` 是"混合流"接口，
    不管你站在哪个收藏夹页面，它都会把推荐/关注流的内容一起吐出来。
    所以即使加了记录开关，还是会漏进娱乐、追星、带货内容。

设计原则（别随手改）：

1. **两级判断，不是一刀切**
   - 硬黑名单（作者名 / 强特征词）→ 直接剔除
   - 软黑名单（弱特征词）→ 需要 2 个命中才剔除
   为什么：单个词容易误伤。比如 "吃" 字命中「独居过日子」这种成长向内容。

2. **宁可放过，不可错杀**
   这是学习库，漏一条成长内容比混进一条广告更亏。
   所以软规则阈值设保守，判定结果全部可审计（返回 reason，不是只返回 bool）。

3. **规则外置成数据，不是写死在 if 里**
   用户以后要加词，改文件顶部的列表就行，不用碰逻辑。

用法：
    from filter_noise import classify, filter_items

    verdict = classify({'desc': '...', 'author': '...'})
    # → {'keep': False, 'reason': '作者黑名单: 黄婷婷'}

    kept, dropped = filter_items(items)
"""

import re

# ---------------------------------------------------------------- 硬黑名单

# 作者名 —— 命中即剔除（精确包含匹配，大小写无关）
# 这些是已验证的娱乐/追星/带货账号
AUTHOR_BLACKLIST = [
    '黄婷婷',
]

# 强特征词 —— 命中即剔除。这些词出现在文案里，几乎不可能是成长内容
HARD_WORDS = [
    '演唱会', '点歌', '歌迷', '万人合唱',
    '上脚', '球鞋', '板鞋', '配色', '开箱',
    '抽奖', '福利', '秒杀', '下单', '优惠券', '领券',
    '带货', '橱窗', '好物推荐',
    '打榜', '应援', '超话', '控评',
]

# ---------------------------------------------------------------- 软黑名单

# 弱特征词 —— 命中 >= SOFT_THRESHOLD 个才算噪音
SOFT_WORDS = [
    '明星', '偶像', '代言', '同款',
    '美食', '探店', '食谱', '菜谱', '好吃',
    '游戏', '对局', '段位', '上分', '开黑',
    '小说', '追更', '连载',
    'ootd', '穿搭', '美妆', '口红',
]

SOFT_THRESHOLD = 2

# ---------------------------------------------------------------- 保护名单

# 成长/学习强特征词 —— 命中即豁免，即使软词超标也保留
# 防止 "讲如何克服焦虑的穿搭博主" 这类被误杀
KEEP_WORDS = [
    '心理', '成长', '认知', '情绪', '内耗', '焦虑', '抑郁',
    '自我', '原生家庭', '疗愈', '边界感', '课题分离',
    '安全感', '价值感', '配得感', '主体性', '内核',
    '执行力', '自律', '复盘', '思维', '格局', '人性',
    '女性', '独立',
    'ai', 'AI', '大模型', '提示词', 'Agent', 'agent',
    '编程', '代码', 'python', '编程',
    '学习方法', '读书', '书单',
]


def _norm(s):
    """统一成小写，方便匹配"""
    return (s or '').lower()


def classify(item):
    """判断一条收藏该不该留

    返回 {'keep': bool, 'reason': str}
    reason 永远有值，方便审计（不能只看 bool，出问题查不出来）
    """
    desc = _norm(item.get('desc'))
    author = _norm(item.get('author'))
    blob = desc + ' ' + author

    # 1. 作者黑名单
    for w in AUTHOR_BLACKLIST:
        if _norm(w) in author:
            return {'keep': False, 'reason': '作者黑名单: ' + w}

    # 2. 强特征词
    for w in HARD_WORDS:
        if _norm(w) in blob:
            return {'keep': False, 'reason': '强特征词: ' + w}

    # 3. 保护名单 —— 命中即豁免
    for w in KEEP_WORDS:
        if _norm(w) in blob:
            return {'keep': True, 'reason': '保护词: ' + w}

    # 4. 软特征词 —— 累计到阈值才剔除
    hits = [w for w in SOFT_WORDS if _norm(w) in blob]
    if len(hits) >= SOFT_THRESHOLD:
        return {'keep': False, 'reason': '软特征词 x%d: %s' % (len(hits), '/'.join(hits))}
    if hits:
        return {'keep': True, 'reason': '软特征词 x%d（未达阈值）: %s' % (len(hits), '/'.join(hits))}

    # 5. 都没命中 —— 默认保留（宁可放过）
    return {'keep': True, 'reason': '无特征命中，默认保留'}


def filter_items(items):
    """批量过滤

    返回 (kept, dropped)
    dropped 里每条带 _reason 字段，方便用户复核
    """
    kept, dropped = [], []
    for it in items:
        v = classify(it)
        if v['keep']:
            kept.append(it)
        else:
            d = dict(it)
            d['_reason'] = v['reason']
            dropped.append(d)
    return kept, dropped


# ---------------------------------------------------------------- 自测

if __name__ == '__main__':
    import json
    import sys
    from pathlib import Path

    path = sys.argv[1] if len(sys.argv) > 1 else None
    if not path:
        print('用法: python3 filter_noise.py <导出文件.json>')
        sys.exit(1)

    data = json.loads(Path(path).read_text(encoding='utf-8'))
    items = data.get('items', [])
    kept, dropped = filter_items(items)

    print('=== 共 %d 条 ===' % len(items))
    print('保留 %d 条' % len(kept))
    print('剔除 %d 条' % len(dropped))
    print()
    print('=== 被剔除的（逐条看，确认没误杀）===')
    for d in dropped:
        desc = (d.get('desc') or '(无文案)').replace('\n', ' ')[:46]
        print('  [%-10s] %-14s %s' % (d['_reason'][:10], d['author'][:12], desc))
    print()
    print('=== 保留的里，作者 Top 15 ===')
    import collections
    for a, n in collections.Counter(k['author'] for k in kept).most_common(15):
        print('  %3d  %s' % (n, a))
