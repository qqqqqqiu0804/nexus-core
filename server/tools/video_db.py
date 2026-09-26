#!/usr/bin/env python3
"""视频学习模块的数据层 —— 收藏夹条目 + 转写 + 观点分析

设计要点（为什么这么设计，别随手改）：

1. **以 aweme_id 为主键**，不是 URL
   同一条视频可能有多个链接形式（分享短链 / 完整链接），
   aweme_id 才是唯一身份。用 id 做键才能"下次不用重跑"。

2. **分表存三个层次的东西**，不是一个 JSON 大字段
   - videos     元信息（标题/作者/时长）—— 从收藏夹导出就有，不用花钱
   - transcripts 转写稿 —— 花钱（ASR），**最贵的部分，必须能复用**
   - summaries  观点分析 —— 花钱（LLM），换模型要能重跑

   分开存的意义：想换摘要模型时，不用重跑 ASR。
   ASR 是 0.6 元/小时，LLM 是每百万 token 几毛钱 —— ASR 贵得多。

3. **status 状态机**，而不是"有/没有"
   pending → transcribed → summarized
   中途失败能看出卡在哪一步，不用从头再来。

4. **model 字段记下是谁跑的**，换模型时能对比效果。

用法：
    db = VideoDB('/root/nexus-core/server/videos.db')
    db.upsert_video(aweme_id, desc=..., author=..., ...)
    db.get_transcript(aweme_id)      # 有就返回，省一次 ASR
    db.save_transcript(aweme_id, text, seconds)
"""

import sqlite3
import json
from pathlib import Path
from datetime import datetime, timezone


SCHEMA = """
CREATE TABLE IF NOT EXISTS videos (
    aweme_id      TEXT PRIMARY KEY,
    url           TEXT,
    desc          TEXT,
    author        TEXT,
    duration_ms   INTEGER DEFAULT 0,
    create_time   INTEGER DEFAULT 0,
    aweme_type    TEXT,
    digg_count    INTEGER DEFAULT 0,
    -- 从哪个收藏夹来的（用户手动开记录时所在的夹）
    collection    TEXT,
    -- 分类标签（人工或自动）
    tags          TEXT DEFAULT '[]',
    -- 处理状态：pending / transcribed / summarized / failed
    status        TEXT DEFAULT 'pending',
    -- 用户在界面上看没看过
    seen          INTEGER DEFAULT 0,
    created_at    TEXT,
    updated_at    TEXT
);

CREATE TABLE IF NOT EXISTS transcripts (
    aweme_id      TEXT PRIMARY KEY,
    text          TEXT NOT NULL,
    chars         INTEGER DEFAULT 0,
    -- ASR 计费秒数，用于对账
    asr_seconds   INTEGER DEFAULT 0,
    asr_model     TEXT,
    -- 视频总时长（毫秒），用于估算
    duration_ms   INTEGER DEFAULT 0,
    created_at    TEXT,
    FOREIGN KEY (aweme_id) REFERENCES videos(aweme_id)
);

CREATE TABLE IF NOT EXISTS summaries (
    aweme_id      TEXT PRIMARY KEY,
    point         TEXT,             -- 一句话观点
    points        TEXT DEFAULT '[]',-- 3 个要点（JSON 数组）
    model         TEXT,             -- 哪个模型跑的，换模型可对比
    created_at    TEXT,
    FOREIGN KEY (aweme_id) REFERENCES videos(aweme_id)
);

CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
CREATE INDEX IF NOT EXISTS idx_videos_collection ON videos(collection);
CREATE INDEX IF NOT EXISTS idx_videos_seen ON videos(seen);
"""


def _now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def _short_id(url):
    """从 URL 里抠出 aweme_id（兜底用，正常情况下调用方直接给）"""
    import re
    m = re.search(r'/(?:video|note)/(\d{6,})', str(url or ''))
    return m.group(1) if m else ''


class VideoDB:
    def __init__(self, path):
        self.path = str(path)
        self.conn = sqlite3.connect(self.path)
        self.conn.row_factory = sqlite3.Row
        # WAL 模式：读写不互相阻塞（前台在查、后台在写）
        self.conn.execute('PRAGMA journal_mode=WAL')
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    # ---------------- 元信息 ----------------
    def upsert_video(self, aweme_id, **kw):
        """插入或更新视频元信息。已存在时只更新提供的字段。"""
        if not aweme_id:
            raise ValueError('aweme_id 不能为空')
        cur = self.conn.execute(
            'SELECT aweme_id FROM videos WHERE aweme_id=?', (aweme_id,))
        if cur.fetchone() is None:
            self.conn.execute(
                'INSERT INTO videos (aweme_id, url, desc, author, duration_ms,'
                ' create_time, aweme_type, digg_count, collection, tags,'
                ' status, created_at, updated_at)'
                ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                (aweme_id, kw.get('url', ''), kw.get('desc', ''),
                 kw.get('author', ''), kw.get('duration_ms', 0),
                 kw.get('create_time', 0), str(kw.get('aweme_type', '')),
                 kw.get('digg_count', 0), kw.get('collection', ''),
                 json.dumps(kw.get('tags', []), ensure_ascii=False),
                 kw.get('status', 'pending'), _now(), _now()))
        else:
            fields, vals = [], []
            for k in ('url', 'desc', 'author', 'duration_ms', 'create_time',
                      'aweme_type', 'digg_count', 'collection'):
                if k in kw:
                    fields.append(k + '=?')
                    vals.append(kw[k])
            if 'tags' in kw:
                fields.append('tags=?')
                vals.append(json.dumps(kw['tags'], ensure_ascii=False))
            if 'status' in kw:
                fields.append('status=?')
                vals.append(kw['status'])
            if fields:
                fields.append('updated_at=?')
                vals.append(_now())
                vals.append(aweme_id)
                self.conn.execute(
                    'UPDATE videos SET ' + ','.join(fields) +
                    ' WHERE aweme_id=?', vals)
        self.conn.commit()

    def import_favorites(self, items, collection=''):
        """把收藏夹导出的 items 批量入库。已存在的不覆盖转写/摘要。"""
        n_new = n_skip = 0
        for it in items:
            aid = str(it.get('aweme_id') or '')
            if not aid:
                continue
            exists = self.conn.execute(
                'SELECT 1 FROM videos WHERE aweme_id=?', (aid,)).fetchone()
            self.upsert_video(
                aid,
                url=it.get('url', ''),
                desc=it.get('desc', ''),
                author=it.get('author', ''),
                duration_ms=it.get('duration_ms', 0),
                create_time=it.get('create_time', 0),
                aweme_type=it.get('aweme_type', ''),
                digg_count=it.get('digg_count', 0),
                collection=collection,
            )
            if exists:
                n_skip += 1
            else:
                n_new += 1
        return {'new': n_new, 'existing': n_skip, 'total': len(items)}

    # ---------------- 转写（最贵，最需要复用）----------------
    def get_transcript(self, aweme_id):
        """有就返回文本，没有返回 None —— 调用方据此跳过 ASR。"""
        r = self.conn.execute(
            'SELECT text FROM transcripts WHERE aweme_id=?',
            (aweme_id,)).fetchone()
        return r['text'] if r else None

    def save_transcript(self, aweme_id, text, asr_seconds=0,
                        asr_model='', duration_ms=0):
        self.conn.execute(
            'INSERT OR REPLACE INTO transcripts'
            ' (aweme_id, text, chars, asr_seconds, asr_model, duration_ms,'
            '  created_at) VALUES (?,?,?,?,?,?,?)',
            (aweme_id, text, len(text or ''), asr_seconds, asr_model,
             duration_ms, _now()))
        self.conn.execute(
            "UPDATE videos SET status='transcribed', updated_at=? "
            'WHERE aweme_id=? AND status IN (\'pending\',\'failed\')',
            (_now(), aweme_id))
        self.conn.commit()

    # ---------------- 摘要 ----------------
    def get_summary(self, aweme_id):
        r = self.conn.execute(
            'SELECT point, points, model FROM summaries WHERE aweme_id=?',
            (aweme_id,)).fetchone()
        if not r:
            return None
        return {'point': r['point'],
                'points': json.loads(r['points'] or '[]'),
                'model': r['model']}

    def save_summary(self, aweme_id, point, points, model='', tags=None):
        """存摘要。tags 顺带写进 videos 表 —— 标签属于"这条视频是什么"，
        不属于"某次摘要跑出了什么"，所以放 videos 而不是 summaries。
        这样换摘要模型时标签不会丢。"""
        self.conn.execute(
            'INSERT OR REPLACE INTO summaries'
            ' (aweme_id, point, points, model, created_at) VALUES (?,?,?,?,?)',
            (aweme_id, point, json.dumps(points or [], ensure_ascii=False),
             model, _now()))
        if tags is not None:
            self.conn.execute(
                'UPDATE videos SET status=?, tags=?, updated_at=? WHERE aweme_id=?',
                ('summarized',
                 json.dumps(tags, ensure_ascii=False), _now(), aweme_id))
        else:
            self.conn.execute(
                "UPDATE videos SET status='summarized', updated_at=? "
                'WHERE aweme_id=?', (_now(), aweme_id))
        self.conn.commit()

    def get_video(self, aweme_id):
        """取单条视频的元信息（含 tags、status、collection）"""
        r = self.conn.execute(
            'SELECT * FROM videos WHERE aweme_id=?', (aweme_id,)).fetchone()
        return dict(r) if r else None

    # ---------------- 查询 ----------------
    def todo(self, limit=0, collection=''):
        """还没摘要的（按收藏时间倒序，新的先做）"""
        sql = ("SELECT aweme_id, url, desc, duration_ms, collection, status"
               " FROM videos WHERE status != 'summarized'")
        args = []
        if collection:
            sql += ' AND collection=?'
            args.append(collection)
        sql += ' ORDER BY create_time DESC'
        if limit:
            sql += ' LIMIT ?'
            args.append(limit)
        return [dict(r) for r in self.conn.execute(sql, args)]

    def stats(self):
        def one(sql, *a):
            return self.conn.execute(sql, a).fetchone()[0]
        return {
            'videos': one('SELECT COUNT(*) FROM videos'),
            'transcribed': one('SELECT COUNT(*) FROM transcripts'),
            'summarized': one('SELECT COUNT(*) FROM summaries'),
            'asr_seconds_total': one(
                'SELECT COALESCE(SUM(asr_seconds),0) FROM transcripts'),
            'collections': [dict(r) for r in self.conn.execute(
                'SELECT collection, COUNT(*) n FROM videos'
                ' GROUP BY collection ORDER BY n DESC')],
        }

    def close(self):
        self.conn.close()
