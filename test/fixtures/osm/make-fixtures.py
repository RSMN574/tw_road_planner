# make-fixtures.py — 用 libosmium（pyosmium）產生測試用的 OSM PBF（台中附近的小路網，各種標籤與轉向限制情境）
#   pip install osmium ；python3 test/fixtures/osm/make-fixtures.py
# 產出 tw-mini.osm.pbf（已放在專案裡，測試不需要 Python）
import osmium, os, sys
from osmium.osm.mutable import Node, Way, Relation
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tw-mini.osm.pbf')
if os.path.exists(OUT): os.remove(OUT)
B = 10_000_000_000                       # 超過 2^32 的 OSM id
LAT0, LON0, D = 24.150, 120.650, 0.001
def nid(i, j): return B + i * 100 + j
nodes = {}
def N(id_, lon, lat, **tags): nodes[id_] = Node(id=id_, location=(lon, lat), tags=tags, version=1)
for i in range(5):
    for j in range(5): N(nid(i, j), LON0 + i * D, LAT0 + j * D)
ways, rels = [], []
def Wy(id_, refs, **tags): ways.append(Way(id=id_, nodes=refs, tags=tags, version=1))
def Rl(id_, members, **tags): rels.append(Relation(id=id_, members=members, tags=tags, version=1))
row = lambda j, a=0, b=4: [nid(i, j) for i in range(a, b + 1)]
col = lambda i, a=0, b=4: [nid(i, j) for j in range(a, b + 1)]
# 格子路網：第 2 排、第 2 行在 (2,2) 切開（轉向限制用）；其他是穿過多個路口的長 way
Wy(200, row(0), highway='residential', name='東西0路', width='6 m')
Wy(201, row(1, 0, 3), highway='residential', name='東西1路', maxspeed='50')
Wy(2011, row(1, 3, 4), highway='residential', name='東西1路')
Wy(202, row(2, 0, 2), highway='primary', name='台灣大道', maxspeed='60', ref='台12')
Wy(2021, row(2, 2, 4), highway='primary', name='台灣大道', maxspeed='60', ref='台12')
Wy(203, row(3), highway='residential', name='東西3路', maxspeed='60')
Wy(204, row(4), highway='tertiary', name='東西4路', maxspeed='30 mph', lanes='2', surface='asphalt', lit='yes', sidewalk='both')
Wy(300, col(0), highway='residential', name='南北0路', maxspeed='TW:urban')
Wy(301, col(1), highway='residential', name='南北1路')
Wy(302, col(2, 0, 2), highway='secondary', name='南北2路', maxspeed='50 km/h')
Wy(3021, col(2, 2, 4), highway='secondary', name='南北2路', maxspeed='50 km/h')
Wy(303, col(3), highway='residential', name='南北3路', maxspeed='50')
Wy(304, col(4), highway='residential', name='南北4路', oneway='yes', **{'oneway:bicycle': 'no'})
# 轉向限制
Rl(900, [('w', 202, 'from'), ('n', nid(2, 2), 'via'), ('w', 3021, 'to')], type='restriction', restriction='no_left_turn', **{'except': 'bicycle'})
Rl(901, [('w', 302, 'from'), ('n', nid(2, 2), 'via'), ('w', 3021, 'to')], type='restriction', restriction='only_straight_on')
Rl(902, [('w', 201, 'from'), ('n', nid(3, 1), 'via'), ('w', 303, 'to')], type='restriction', **{'restriction:conditional': 'no_right_turn @ (Mo-Fr 07:00-09:00)'})
Rl(903, [('w', 200, 'from'), ('n', nid(1, 0), 'via'), ('w', 999999, 'to')], type='restriction', restriction='no_left_turn')
Rl(904, [('w', 203, 'from'), ('n', nid(2, 3), 'via'), ('w', 3021, 'to')], type='restriction:motorcar', restriction='no_right_turn')
# 雙向分隔道路＋中央分隔島迴轉道（via way 的禁止迴轉）
y1, y2 = LAT0 - 0.002, LAT0 - 0.0025
P = [B + 1001, B + 1002, B + 1003]; Q = [B + 1011, B + 1012, B + 1013]
for k in range(3): N(P[k], LON0 + k * 0.002, y1); N(Q[k], LON0 + k * 0.002, y2)
Wy(400, [P[0], P[1]], highway='primary', oneway='yes', name='分隔北側')
Wy(4001, [P[1], P[2]], highway='primary', oneway='yes', name='分隔北側')
Wy(401, [Q[2], Q[1]], highway='primary', oneway='yes', name='分隔南側')
Wy(4011, [Q[1], Q[0]], highway='primary', oneway='yes', name='分隔南側')
Wy(402, [P[1], Q[1]], highway='primary', oneway='yes', name='迴轉道')
Wy(403, [P[2], B + 1004, Q[2]], highway='tertiary', name='繞回')
N(B + 1004, LON0 + 0.0045, LAT0 - 0.00225)
Wy(404, [Q[0], nid(0, 0)], highway='residential', name='接格子')
Rl(905, [('w', 400, 'from'), ('w', 402, 'via'), ('w', 4011, 'to')], type='restriction', restriction='no_u_turn')
# 圓環（隱含單行、封閉的 way）
R = [B + 2001, B + 2002, B + 2003, B + 2004]
cx, cy, r = LON0 + 0.0065, LAT0 + 0.002, 0.0005
for k, (dx, dy) in enumerate([(-1, 0), (0, -1), (1, 0), (0, 1)]): N(R[k], cx + dx * r, cy + dy * r)
Wy(500, [R[0], R[1], R[2], R[3], R[0]], highway='tertiary', junction='roundabout', name='圓環')
Wy(501, [nid(4, 2), R[0]], highway='tertiary', name='圓環聯絡道')
# 國道、快速公路
N(B + 3001, LON0 - 0.004, LAT0 - 0.001); N(B + 3002, LON0 + 0.008, LAT0 - 0.001)
Wy(600, [nid(0, 0), B + 3001], highway='motorway', ref='國道1號', name='中山高速公路', oneway='no')
Wy(601, [nid(4, 0), B + 3002], highway='trunk', motorroad='yes', ref='台74', name='快速道路')
# 橋：與平面道路幾何交叉但沒有共用 node（不相接）；端點接平面道路（相接）
N(B + 4001, LON0 - 0.001, LAT0 + 0.0015); N(B + 4002, LON0 + 0.005, LAT0 + 0.0015)
Wy(700, [B + 4001, B + 4002], highway='secondary', bridge='yes', layer='1', name='高架橋')
Wy(702, [nid(0, 1), B + 4001], highway='secondary', name='引道西')
Wy(703, [B + 4002, nid(4, 1)], highway='secondary', name='引道東')
# 資料錯誤：橋（layer 1）與平面道路在中間點共用 node（1,3）→ 不可當成路口
N(B + 4011, LON0 + 0.001, LAT0 + 0.0045); N(B + 4012, LON0 + 0.001, LAT0 + 0.0025)
Wy(710, [B + 4011, nid(1, 3), B + 4012], highway='tertiary', bridge='yes', layer='1', name='錯接的橋')
# 通行標籤
N(B + 5001, LON0 + 0.001, LAT0 - 0.0008); Wy(800, [nid(1, 0), B + 5001], highway='service', access='private', name='私人道路')
N(B + 5002, LON0 + 0.003, LAT0 + 0.0052); Wy(801, [nid(3, 4), B + 5002], highway='footway', name='人行步道')
N(B + 5003, LON0, LAT0 + 0.0052); Wy(802, [nid(0, 4), B + 5003], highway='track', name='產業道路')
N(B + 5004, LON0 + 0.004, LAT0 + 0.0052); Wy(803, [nid(4, 4), B + 5004], highway='cycleway', name='自行車道')
N(B + 5005, LON0 + 0.002, LAT0 + 0.0052); Wy(804, [nid(2, 4), B + 5005], highway='residential', motor_vehicle='no', foot='yes', name='徒步區')
# 障礙物：車阻（bollard）擋汽車，自行車、行人可過
N(B + 6001, LON0 - 0.001, LAT0 + 0.003, barrier='bollard'); N(B + 6002, LON0 - 0.002, LAT0 + 0.003)
Wy(806, [nid(0, 3), B + 6001, B + 6002], highway='residential', name='車阻巷')
# 號誌
nodes[nid(1, 1)] = Node(id=nid(1, 1), location=(LON0 + 1 * D, LAT0 + 1 * D), tags={'highway': 'traffic_signals'}, version=1)
# 缺資料：way 參照一個不在檔案裡的 node
N(B + 7001, LON0 + 0.005, LAT0 + 0.003); N(B + 7003, LON0 + 0.006, LAT0 + 0.0035)
Wy(807, [nid(4, 3), B + 7001, B + 7002, B + 7003], highway='residential', name='缺點路')
# 不進路網的
Wy(808, [nid(0, 0), nid(1, 1)], highway='construction', construction='primary')
Wy(809, [nid(1, 1), nid(2, 1), nid(2, 0), nid(1, 0), nid(1, 1)], highway='pedestrian', area='yes', name='廣場')
# 渡輪：本島碼頭 → 小島（只載人、20 分鐘）→ 更遠的小島（沒標航行時間）
N(B + 8000, LON0 + 0.005, LAT0 + 0.004); Wy(812, [nid(4, 4), B + 8000], highway='residential', name='碼頭路')
N(B + 8001, LON0 + 0.020, LAT0 + 0.004); N(B + 8002, LON0 + 0.022, LAT0 + 0.004); Wy(811, [B + 8001, B + 8002], highway='residential', name='小島路')
Wy(810, [B + 8000, B + 8001], route='ferry', duration='00:20', name='測試渡輪', motor_vehicle='no', bicycle='yes')
N(B + 8003, LON0 + 0.030, LAT0 + 0.004); N(B + 8004, LON0 + 0.031, LAT0 + 0.004); Wy(815, [B + 8003, B + 8004], highway='residential', name='外島路')
Wy(814, [B + 8002, B + 8003], route='ferry', name='外島渡輪')
# 渡輪端點沒接上道路（OSM 常見）：建圖時補碼頭連接
N(B + 8010, LON0 + 0.0002, LAT0 + 0.0056); N(B + 8011, LON0 + 0.0002, LAT0 + 0.0150); N(B + 8012, LON0 + 0.0010, LAT0 + 0.0150)
Wy(816, [B + 8010, B + 8011], route='ferry', name='北島渡輪', duration='00:30'); Wy(817, [B + 8011, B + 8012], highway='residential', name='北島路')
w = osmium.SimpleWriter(OUT)
for k in sorted(nodes): w.add_node(nodes[k])
for x in sorted(ways, key=lambda x: x.id): w.add_way(x)
for x in sorted(rels, key=lambda x: x.id): w.add_relation(x)
w.close(); print('wrote', OUT, os.path.getsize(OUT), 'bytes')
