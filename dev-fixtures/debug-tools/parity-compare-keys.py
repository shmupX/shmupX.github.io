"""For the formation keys whose round trip changed, list what the cart and the export spawned under them."""
import json, sys, collections
cart = json.load(open(sys.argv[1] + "/panes/saturn.survey.json", encoding="utf-8"))
exp = json.load(open(sys.argv[2] + "/panes/saturn.survey.json", encoding="utf-8"))
rush = json.load(open(sys.argv[1] + "/rush.json", encoding="utf-8"))
roster = {}
for k, d in rush["enemyData"].items():
    dz = d.get("dezaemon") or {}
    if dz.get("stage") != 0: continue
    f = (dz.get("behavior") or {}).get("fire") or {}
    roster[dz.get("placementId")] = dict(letter=k[len("enemy"):], rec=dz.get("record"), name=d.get("name"), fire=f.get("enabled"), mode=f.get("mode"), hp=(dz.get("behavior") or {}).get("hp"))
def dist(S, key):
    c = collections.Counter(); spans = []
    for b in S["births"]:
        if b.get("key") != key or not (99 <= (b.get("slot") or 0) <= 248): continue
        c[(b.get("spr"), b.get("hp"), b.get("atk"), b.get("attr"))] += 1
        spans.append(b.get("scroll"))
    return c, (min(spans), max(spans)) if spans else None
for key in [141, 131, 133, 129, 128, 130, 162, 163, 164, 135, 136, 132, 137, 160, 177, 0]:
    print("key %d  roster: %s" % (key, roster.get(key)))
    for nm, S in (("cart  ", cart), ("export", exp)):
        c, span = dist(S, key)
        items = sorted(c.items(), key=lambda kv: -kv[1])[:6]
        print("   %s n=%-4d scroll %s  (spr,hp,atk,attr):n %s" % (nm, sum(c.values()), span, items))
print()
print("placement ids in the stage-0 roster but never seen on either side:", sorted(set(roster) - {b.get("key") for b in cart["births"]} - {b.get("key") for b in exp["births"]}))
print("rush.json enemyData with fire mode 3 (big shots):", [(v["letter"], k, v["name"]) for k, v in roster.items() if v["mode"] == 3])
# ship weapons: which p1 shot sprites, and the pods
for nm, S in (("cart  ", cart), ("export", exp)):
    shots = collections.Counter(b["spr"] for b in S["births"] if 4 <= b["slot"] <= 33)
    pods = collections.Counter(b["spr"] for b in S["births"] if 64 <= b["slot"] <= 71 or 80 <= b["slot"] <= 83)
    print(nm, "p1 shot sprites:", dict(shots), " pod-slot sprites:", dict(pods))
