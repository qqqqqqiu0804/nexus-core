import sys, json, os
sys.path.insert(0, "/root/nexus-core/server/tools")
import douyin_pipeline as d

fails = []

def chk(label, got, want):
    ok = got == want
    print("  [%s] %s: got=%r want=%r" % ("OK" if ok else "FAIL", label, got, want))
    if not ok:
        fails.append(label)

def reset(seconds=0, month=None):
    """把账本重置到已知状态。

    为什么每个用例前都要重置：precheck_budget 读的是**全局账本文件**，
    如果前一个用例留下了用量，后一个用例的期望值就全错了。
    我第一版就是这么挂的 —— 「正好10小时放行」失败了，但代码是对的，
    是上一条用例残留的 350 秒把总和顶过了预算线。
    教训：测「读数」的逻辑，必须先把那个数控制住。
    """
    open(d.USAGE_FILE, "w").write(
        json.dumps({"month": month or d._this_month(), "asr_seconds": seconds}))

# --- [3] 跨月归零 ---
reset(35000, month="2026-08")
u = d.load_usage()
chk("跨月归零（上月35000秒不算本月）", u["asr_seconds"], 0)
chk("月份已更新为本月", u["month"], d._this_month())

# --- [5] 账本损坏容错 ---
open(d.USAGE_FILE, "w").write("bad json {{{")
u = d.load_usage()
chk("损坏账本容错为0", u["asr_seconds"], 0)

# --- [6] 正常累加 ---
reset(100)
d.add_usage(200)
chk("累加 100+200", d.load_usage()["asr_seconds"], 300)

# --- [7] add_usage 返回值 ---
chk("add_usage 返回值", d.add_usage(50)["asr_seconds"], 350)

# --- [8] 未超额时不报警 ---
rep = d.cost_report({"month": d._this_month(), "asr_seconds": 3600})
chk("未超额无警告字样", "超出" not in rep, True)

# --- [9] 超额时算出正确金额 ---
rep = d.cost_report({"month": d._this_month(), "asr_seconds": 12 * 3600})
chk("超2小时算出1.20元", "1.20 元" in rep, True)

# --- [10] 恰好用满 10 小时应放行（账本必须是干净的）---
reset(0)
ok, _ = d.precheck_budget(300, 120, 3600 * 10)
chk("正好10小时放行", ok, True)

# --- [11] 超 1 条就该拦 ---
reset(0)
ok, _ = d.precheck_budget(301, 120, 3600 * 10)
chk("超一点点也拦", ok, False)

# --- [12] budget=0 表示不限制 ---
reset(0)
ok, _ = d.precheck_budget(99999, 600, 0)
chk("budget=0不限制", ok, True)

# --- [13] 已有用量再跑，应叠加判断 ---
reset(9 * 3600)
ok, why = d.precheck_budget(100, 120, 3600 * 10)   # 9h + 3.3h = 12.3h > 10h
chk("已有9小时再跑100条应被拦", ok, False)
chk("拦截信息里含当前用量", "9.00 小时" in why, True)

# --- [14] 余额刚好够 1 条时，不该被拦 ---
reset(3600 * 10 - 120)          # 只剩 120 秒额度
ok, _ = d.precheck_budget(1, 120, 3600 * 10)
chk("余额刚好够1条放行", ok, True)

if os.path.exists(d.USAGE_FILE):
    os.remove(d.USAGE_FILE)
print()
print("全部通过（14 项）" if not fails else "失败 %d 项: %s" % (len(fails), fails))
sys.exit(0 if not fails else 1)
