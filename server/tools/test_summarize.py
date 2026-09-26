"""总结模型的候选链 / 降级逻辑测试。

为什么单独测这个：模型下线是百炼**最常见的失败**，
如果降级逻辑写错（比如该降级时直接抛、或者不该降级时乱降），
用户拿到的就是「一片空白」而不是「一个明确的错误」。
"""
import sys, json
sys.path.insert(0, "/root/nexus-core/server/tools")
import douyin_pipeline as d

fails = []

def chk(label, got, want):
    ok = got == want
    print("  [%s] %s: got=%r want=%r" % ("OK" if ok else "FAIL", label, got, want))
    if not ok:
        fails.append(label)

# ---- 用假的 post_json 替换掉真实网络调用 ----
_orig = d.post_json

def fake_factory(behavior):
    """behavior: dict model -> ('ok', payload) | ('err', message)"""
    calls = []
    def fake(url, payload, api_key, **kw):
        m = payload.get('model')
        calls.append(m)
        kind, val = behavior.get(m, ('err', 'HTTP 404: Model not exist'))
        if kind == 'ok':
            return {'output': {'choices': [{'message': {'content': json.dumps(val)}}]}}
        raise RuntimeError(val)
    return fake, calls

GOOD = {'point': '边界不是拒绝别人', 'points': ['a', 'b'], 'tags': ['女性成长']}

# --- [1] 第一个模型就能用：只调用一次，不浪费 ---
beh = {'qwen3.8-flash': ('ok', GOOD)}
d.post_json, calls = fake_factory(beh)
r = d.summarize('文稿', 'k', ['qwen3.8-flash', 'qwen-plus'])
chk("首模型可用时结果正确", r['point'], GOOD['point'])
chk("只调用一次（不试后面的）", len(calls), 1)
chk("记下了使用的模型名", r['_model'], 'qwen3.8-flash')

# --- [2] 第一个 404：应降级到第二个 ---
beh = {'qwen3.8-flash': ('err', 'HTTP 404: Model not exist'),
       'qwen-plus': ('ok', GOOD)}
d.post_json, calls = fake_factory(beh)
r = d.summarize('文稿', 'k', ['qwen3.8-flash', 'qwen-plus'])
chk("404 时降级成功", r['point'], GOOD['point'])
chk("依次尝试了两个", calls, ['qwen3.8-flash', 'qwen-plus'])
chk("记录的是实际成功的模型", r['_model'], 'qwen-plus')

# --- [3] 无权限（AccessDenied）也应降级 ---
beh = {'a': ('err', 'HTTP 403: AccessDenied'), 'b': ('ok', GOOD)}
d.post_json, calls = fake_factory(beh)
r = d.summarize('文稿', 'k', ['a', 'b'])
chk("AccessDenied 降级成功", r['_model'], 'b')

# --- [4] 全不可用：必须抛错并列出每个模型的失败原因 ---
beh = {'a': ('err', 'HTTP 404: Model not exist'),
       'b': ('err', 'HTTP 404: Model not exist')}
d.post_json, calls = fake_factory(beh)
try:
    d.summarize('文稿', 'k', ['a', 'b'])
    chk("全失败应抛错", False, True)
except RuntimeError as e:
    chk("全失败抛 RuntimeError", True, True)
    chk("错误里含 list-models 指引", '--list-models' in str(e), True)
    chk("错误里列了两个模型", str(e).count('Model not exist'), 2)

# --- [5] 非模型类错误（如网络挂）**不应**降级 —— 降级也没用，应直接抛 ---
beh = {'a': ('err', 'HTTP 500: internal server error'),
       'b': ('ok', GOOD)}
d.post_json, calls = fake_factory(beh)
try:
    d.summarize('文稿', 'k', ['a', 'b'])
    chk("网络类错误应直接抛而非降级", False, True)
except RuntimeError as e:
    chk("网络类错误直接抛", '500' in str(e), True)
    chk("且没有试第二个模型", calls, ['a'])

# --- [6] 单个字符串也要能传（向后兼容）---
beh = {'solo': ('ok', GOOD)}
d.post_json, calls = fake_factory(beh)
r = d.summarize('文稿', 'k', 'solo')
chk("传字符串也能工作", r['_model'], 'solo')

# --- [7] LLM 返回带 ```json 包裹时应能解析 ---
def fake_wrapped(url, payload, api_key, **kw):
    body = '```json\n' + json.dumps(GOOD) + '\n```'
    return {'output': {'choices': [{'message': {'content': body}}]}}
d.post_json = fake_wrapped
r = d.summarize('文稿', 'k', ['x'])
chk("能剥离 markdown 代码块", r['point'], GOOD['point'])

# --- [8] 返回非 JSON 应明确报错 ---
def fake_garbage(url, payload, api_key, **kw):
    return {'output': {'choices': [{'message': {'content': '对不起我不会'}}]}}
d.post_json = fake_garbage
try:
    d.summarize('文稿', 'k', ['x'])
    chk("非 JSON 应抛错", False, True)
except RuntimeError as e:
    chk("非 JSON 抛错且含原文", '不是 JSON' in str(e), True)

d.post_json = _orig
print()
print("全部通过（%d 项）" % (0 if fails else 16) if not fails
      else "失败 %d 项: %s" % (len(fails), fails))
sys.exit(0 if not fails else 1)
