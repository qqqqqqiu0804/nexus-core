#!/usr/bin/env python3
"""把收藏夹导出文件导进 videos.db（带噪音过滤）

用法：
    python3 import_favorites.py <导出.json> [--collection 收藏夹名] [--dry-run] [--keep-noise]

流程：
    读 JSON → 过滤噪音 → 入库 → 打印统计

为什么 --dry-run 是默认推荐先跑一次：
    导入前先看清楚"会剔掉哪几条"，别导完才发现误杀了想留的内容。
    DB 入库是按 aweme_id upsert 的，重复导入安全，但心里有数更好。
"""

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from video_db import VideoDB          # noqa: E402
from filter_noise import filter_items  # noqa: E402

DB_PATH = HERE.parent / 'videos.db'


def main():
    ap = argparse.ArgumentParser(description='收藏夹导出 → videos.db')
    ap.add_argument('json_file', help='篡改猴导出的 JSON')
    ap.add_argument('--collection', default='', help='收藏夹名（会写进 DB）')
    ap.add_argument('--db', default=str(DB_PATH), help='数据库路径')
    ap.add_argument('--dry-run', action='store_true', help='只看结果，不写库')
    ap.add_argument('--keep-noise', action='store_true', help='不过滤，全部入库')
    args = ap.parse_args()

    path = Path(args.json_file)
    if not path.exists():
        print('文件不存在: ' + str(path))
        return 1

    data = json.loads(path.read_text(encoding='utf-8'))
    items = data.get('items', [])
    if not items:
        print('导出文件里没有 items')
        return 1

    print('读取 %s' % path.name)
    print('  导出版本: %s' % data.get('version', '?'))
    print('  条目数:   %d' % len(items))
    print('  收藏夹:   %s' % (args.collection or '(未指定)'))
    print()

    # ---- 过滤 ----
    if args.keep_noise:
        kept, dropped = items, []
        print('（--keep-noise：跳过过滤）')
    else:
        kept, dropped = filter_items(items)
        print('过滤结果：保留 %d / 剔除 %d' % (len(kept), len(dropped)))
        if dropped:
            print()
            print('  被剔除的：')
            for d in dropped:
                desc = (d.get('desc') or '(无文案)').replace('\n', ' ')[:44]
                print('    · %-30s %s' % (d['_reason'][:30], desc))
    print()

    if args.dry_run:
        print('（--dry-run：没有写库）')
        return 0

    # ---- 入库 ----
    db = VideoDB(str(args.db))
    try:
        r = db.import_favorites(kept, collection=args.collection)
        print('入库完成：')
        print('  新增 %d 条' % r['new'])
        print('  已有 %d 条（已更新元信息，转写/摘要未动）' % r['existing'])
        print('  本次共 %d 条' % r['total'])
        print()
        s = db.stats()
        print('数据库现状：')
        print('  视频总数 %d' % s['videos'])
        print('  已转写   %d' % s['transcribed'])
        print('  已摘要   %d' % s['summarized'])
        print('  ASR 累计 %.2f 小时' % (s['asr_seconds_total'] / 3600))
        if s.get('collections'):
            print('  收藏夹分布：')
            for c in s['collections']:
                print('    %-16s %d 条' % (c['collection'] or '(未分类)', c['n']))
    finally:
        db.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
