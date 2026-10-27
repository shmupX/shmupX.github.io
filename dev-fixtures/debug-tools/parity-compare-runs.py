"""Compare the Saturn survey of the cart run with the Saturn survey of the round-trip (export) run.

usage: python -I compare-saturn-runs.py <cart-out-dir> <export-out-dir>
Prints the survey layout, then for each sprite kind which slot class it lives in on each side,
then the enemy-pool births by formation key and by sprite on each side.
"""
import json, sys, collections

def load(d):
    return json.load(open(d + "/panes/saturn.survey.json", encoding="utf-8"))

def slot_class(s):
    if s == 2: return "ship"
    if 4 <= s <= 33: return "p1shot"
    if 34 <= s <= 63: return "p2shot"
    if 64 <= s <= 67 or 80 <= s <= 83: return "pod"
    if s == 98: return "bosscore"
    if 99 <= s <= 248: return "enemy"
    return "other%d" % s

a, b = load(sys.argv[1]), load(sys.argv[2])
print("top keys:", sorted(a.keys()))
print("first birth:", json.dumps(a["births"][0])[:300])
print("first sample keys:", sorted(a["samples"][0].keys()), "first obj:", a["samples"][0]["objs"][:1])

def by_kind(S):
    out = collections.defaultdict(collections.Counter)
    for bb in S["births"]:
        spr = bb.get("spr"); slot = bb.get("slot")
        if spr is None or slot is None: continue
        out["spr%d" % spr][slot_class(slot)] += 1
    return out

ka, kb = by_kind(a), by_kind(b)
keys = sorted(set(ka) | set(kb), key=lambda k: -(sum(ka[k].values()) + sum(kb[k].values())))
print("\nkind      cart (by slot class)                    export (by slot class)")
for k in keys:
    print("%-8s  %-40s %-40s" % (k, dict(ka[k]), dict(kb[k])))

def enemy_births(S):
    keys = collections.Counter(); sprs = collections.Counter(); first = {}
    for bb in S["births"]:
        slot = bb.get("slot")
        if slot is None or not (99 <= slot <= 248): continue
        keys[bb.get("key")] += 1; sprs[bb.get("spr")] += 1
        k = bb.get("key")
        if k not in first: first[k] = (bb.get("scroll"), bb.get("spr"), bb.get("hp"), bb.get("atk"), bb.get("attr"))
    return keys, sprs, first

ea, sa, fa = enemy_births(a); eb, sb, fb = enemy_births(b)
print("\nenemy-pool births: cart %d (%d keys), export %d (%d keys)" % (sum(ea.values()), len(ea), sum(eb.values()), len(eb)))
print("key    cart export   first(scroll,spr,hp,atk,attr) cart | export")
for k in sorted(set(ea) | set(eb), key=lambda k: (fa.get(k) or fb.get(k) or (0,))[0] if (fa.get(k) or fb.get(k) or (0,))[0] is not None else -1):
    print("%-6s %4d %6d   %s | %s" % (k, ea.get(k, 0), eb.get(k, 0), fa.get(k), fb.get(k)))
print("\nenemy-pool sprites only on one side:")
for s in sorted(set(sa) ^ set(sb)): print("  spr%s cart=%d export=%d" % (s, sa.get(s, 0), sb.get(s, 0)))
