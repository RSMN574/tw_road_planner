// poi-categories.mjs — 店家地點（POI）的類別表：OSM 標籤 → 本系統類別（中文名稱、圖示、類別搜尋詞、群組）
//
// 只收「有人會去的地方」：停車格、長椅、垃圾桶、飲水機、遮雨棚、置物櫃、資訊看板等不收（見 EXCLUDE）。
// 沒有名稱的地點只收 KEEP_UNNAMED 的類別（加油站、廁所、ATM、停車場等，用類別找時才有意義）。
// 類別搜尋詞（words）命中時，查詢會變成「附近的這一類」，不比對店名。
export const CATEGORIES = {
  restaurant: { label: '餐廳', group: 'food', icon: 'food', words: ['餐廳', '美食', '吃飯', '餐館', 'restaurant'] },
  fast_food: { label: '速食', group: 'food', icon: 'food', words: ['速食', '快餐', 'fast food'] },
  cafe: { label: '咖啡廳', group: 'food', icon: 'cafe', words: ['咖啡', '咖啡廳', '咖啡店', 'cafe', 'coffee'] },
  bar: { label: '酒吧', group: 'food', icon: 'cafe', words: ['酒吧', '居酒屋', 'bar', 'pub'] },
  food_court: { label: '美食街', group: 'food', icon: 'food', words: ['美食街', '美食廣場'] },
  ice_cream: { label: '冰品', group: 'food', icon: 'cafe', words: ['冰店', '冰品', '冰淇淋'] },
  bakery: { label: '麵包店', group: 'food', icon: 'cafe', words: ['麵包', '麵包店', '烘焙'] },
  beverage: { label: '飲料店', group: 'food', icon: 'cafe', words: ['飲料', '飲料店', '手搖', '手搖飲'] },
  convenience: { label: '便利商店', group: 'shop', icon: 'store', words: ['便利商店', '超商', '便利店', 'convenience'] },
  supermarket: { label: '超市', group: 'shop', icon: 'cart', words: ['超市', '超級市場', '量販', '量販店', 'supermarket'] },
  marketplace: { label: '市場', group: 'shop', icon: 'cart', words: ['市場', '傳統市場', '菜市場', '夜市'] },
  mall: { label: '百貨商場', group: 'shop', icon: 'store', words: ['百貨', '百貨公司', '購物中心', '商場', 'mall'] },
  clothes: { label: '服飾', group: 'shop', icon: 'store', words: ['服飾', '衣服', '服飾店'] },
  electronics: { label: '電子 3C', group: 'shop', icon: 'store', words: ['3c', '電子', '手機行', '電器'] },
  hardware: { label: '五金', group: 'shop', icon: 'store', words: ['五金', '五金行', '居家修繕'] },
  books: { label: '書店', group: 'shop', icon: 'store', words: ['書店', '文具'] },
  hairdresser: { label: '美髮美容', group: 'shop', icon: 'store', words: ['美髮', '理髮', '剪頭髮', '美容', '美甲'] },
  shop: { label: '商店', group: 'shop', icon: 'store', words: ['商店', '店家'] },
  fuel: { label: '加油站', group: 'car', icon: 'fuel', words: ['加油站', '加油', '中油', '台塑石化', '台亞', '全國加油', 'gas station', 'fuel'] },
  charging: { label: '充電站', group: 'car', icon: 'fuel', words: ['充電站', '充電樁', '電動車充電', 'charging'] },
  parking: { label: '停車場', group: 'car', icon: 'parking', words: ['停車場', '停車', 'parking'] },
  moto_parking: { label: '機車停車場', group: 'car', icon: 'parking', words: ['機車停車場', '機車停車'] },
  car_repair: { label: '汽機車維修', group: 'car', icon: 'store', words: ['修車', '汽車維修', '機車行', '保養廠'] },
  car_wash: { label: '洗車', group: 'car', icon: 'store', words: ['洗車'] },
  bike_rental: { label: '自行車租借', group: 'car', icon: 'bike', words: ['youbike', '微笑單車', '租腳踏車', '自行車租借'] },
  bank: { label: '銀行', group: 'money', icon: 'bank', words: ['銀行', 'bank'] },
  atm: { label: 'ATM', group: 'money', icon: 'bank', words: ['atm', '提款機', '領錢'] },
  post_office: { label: '郵局', group: 'money', icon: 'bank', words: ['郵局', 'post office'] },
  hospital: { label: '醫院', group: 'health', icon: 'health', words: ['醫院', '急診', 'hospital'] },
  clinic: { label: '診所', group: 'health', icon: 'health', words: ['診所', '看醫生', 'clinic'] },
  dentist: { label: '牙醫', group: 'health', icon: 'health', words: ['牙醫', '牙科', 'dentist'] },
  pharmacy: { label: '藥局', group: 'health', icon: 'pill', words: ['藥局', '藥房', '藥妝', 'pharmacy'] },
  veterinary: { label: '動物醫院', group: 'health', icon: 'health', words: ['動物醫院', '獸醫'] },
  hotel: { label: '旅館', group: 'stay', icon: 'bed', words: ['飯店', '旅館', '酒店', '住宿', '民宿', 'hotel', 'hostel'] },
  attraction: { label: '景點', group: 'fun', icon: 'camera', words: ['景點', '觀光', '旅遊'] },
  viewpoint: { label: '觀景點', group: 'fun', icon: 'camera', words: ['觀景台', '觀景點', '夜景'] },
  museum: { label: '博物館美術館', group: 'fun', icon: 'camera', words: ['博物館', '美術館', '展覽', 'museum'] },
  park: { label: '公園', group: 'fun', icon: 'park', words: ['公園', '綠地', 'park'] },
  cinema: { label: '電影院', group: 'fun', icon: 'camera', words: ['電影院', '看電影', '影城', 'cinema'] },
  sports: { label: '運動場館', group: 'fun', icon: 'park', words: ['健身房', '運動中心', '體育館', '游泳池', 'gym'] },
  playground: { label: '遊樂場', group: 'fun', icon: 'park', words: ['遊樂場', '兒童遊戲場', '溜滑梯'] },
  school: { label: '學校', group: 'public', icon: 'school', words: ['學校', '國小', '國中', '高中', 'school'] },
  university: { label: '大學', group: 'public', icon: 'school', words: ['大學', '學院', 'university'] },
  library: { label: '圖書館', group: 'public', icon: 'school', words: ['圖書館', 'library'] },
  government: { label: '政府機關', group: 'public', icon: 'bank', words: ['區公所', '市政府', '戶政', '公所', '政府'] },
  police: { label: '警察局', group: 'public', icon: 'bank', words: ['警察局', '派出所', '警察'] },
  fire_station: { label: '消防局', group: 'public', icon: 'bank', words: ['消防局', '消防隊'] },
  community: { label: '活動中心', group: 'public', icon: 'bank', words: ['活動中心', '社區活動中心'] },
  worship: { label: '宗教場所', group: 'public', icon: 'temple', words: ['廟', '寺', '宮', '教會', '教堂', '宗教'] },
  toilets: { label: '廁所', group: 'facility', icon: 'toilet', words: ['廁所', '洗手間', '化妝室', 'toilet', 'wc'] },
  station: { label: '車站', group: 'transport', icon: 'transit', words: ['車站', '火車站', '捷運站', '客運站', '轉運站'] },
  airport: { label: '機場', group: 'transport', icon: 'transit', words: ['機場', 'airport'] },
  office: { label: '公司行號', group: 'office', icon: 'work', words: ['公司', '辦公室', 'office'] },
  other: { label: '地點', group: 'other', icon: 'pin', words: [] }
};
// OSM 標籤 → 類別（先比對 key=value，再比對 key=*）
const TAG = {
  'amenity=restaurant': 'restaurant', 'amenity=fast_food': 'fast_food', 'amenity=cafe': 'cafe', 'amenity=bar': 'bar', 'amenity=pub': 'bar', 'amenity=food_court': 'food_court', 'amenity=ice_cream': 'ice_cream', 'amenity=biergarten': 'bar',
  'shop=bakery': 'bakery', 'shop=pastry': 'bakery', 'shop=beverages': 'beverage', 'shop=tea': 'beverage', 'shop=coffee': 'cafe', 'shop=confectionery': 'bakery',
  'shop=convenience': 'convenience', 'shop=supermarket': 'supermarket', 'shop=greengrocer': 'marketplace', 'amenity=marketplace': 'marketplace', 'shop=department_store': 'mall', 'shop=mall': 'mall',
  'shop=clothes': 'clothes', 'shop=shoes': 'clothes', 'shop=electronics': 'electronics', 'shop=mobile_phone': 'electronics', 'shop=computer': 'electronics', 'shop=hardware': 'hardware', 'shop=doityourself': 'hardware',
  'shop=books': 'books', 'shop=stationery': 'books', 'shop=hairdresser': 'hairdresser', 'shop=beauty': 'hairdresser', 'shop=chemist': 'pharmacy', 'shop=cosmetics': 'pharmacy',
  'amenity=fuel': 'fuel', 'amenity=charging_station': 'charging', 'amenity=parking': 'parking', 'amenity=motorcycle_parking': 'moto_parking', 'shop=car_repair': 'car_repair', 'shop=motorcycle': 'car_repair', 'shop=motorcycle_repair': 'car_repair',
  'amenity=car_wash': 'car_wash', 'amenity=bicycle_rental': 'bike_rental',
  'amenity=bank': 'bank', 'amenity=atm': 'atm', 'amenity=post_office': 'post_office',
  'amenity=hospital': 'hospital', 'healthcare=hospital': 'hospital', 'amenity=clinic': 'clinic', 'amenity=doctors': 'clinic', 'healthcare=clinic': 'clinic', 'healthcare=doctor': 'clinic', 'amenity=dentist': 'dentist', 'healthcare=dentist': 'dentist',
  'amenity=pharmacy': 'pharmacy', 'healthcare=pharmacy': 'pharmacy', 'amenity=veterinary': 'veterinary',
  'tourism=hotel': 'hotel', 'tourism=hostel': 'hotel', 'tourism=guest_house': 'hotel', 'tourism=motel': 'hotel', 'tourism=apartment': 'hotel',
  'tourism=attraction': 'attraction', 'tourism=theme_park': 'attraction', 'tourism=zoo': 'attraction', 'tourism=aquarium': 'attraction', 'tourism=viewpoint': 'viewpoint', 'tourism=museum': 'museum', 'tourism=gallery': 'museum', 'amenity=arts_centre': 'museum',
  'leisure=park': 'park', 'leisure=garden': 'park', 'leisure=nature_reserve': 'park', 'amenity=cinema': 'cinema', 'leisure=sports_centre': 'sports', 'leisure=fitness_centre': 'sports', 'leisure=swimming_pool': 'sports', 'leisure=stadium': 'sports',
  'leisure=playground': 'playground', 'leisure=water_park': 'attraction', 'leisure=amusement_arcade': 'attraction',
  'amenity=school': 'school', 'amenity=kindergarten': 'school', 'amenity=university': 'university', 'amenity=college': 'university', 'amenity=library': 'library',
  'amenity=townhall': 'government', 'office=government': 'government', 'amenity=courthouse': 'government', 'amenity=police': 'police', 'amenity=fire_station': 'fire_station', 'amenity=community_centre': 'community',
  'amenity=place_of_worship': 'worship', 'amenity=toilets': 'toilets', 'amenity=bus_station': 'station', 'railway=station': 'station', 'railway=halt': 'station', 'public_transport=station': 'station', 'aeroway=aerodrome': 'airport', 'aeroway=terminal': 'airport', 'tourism=information/office': 'attraction',
  'shop=*': 'shop', 'office=*': 'office', 'craft=*': 'shop', 'healthcare=*': 'clinic', 'tourism=*': 'attraction', 'leisure=*': 'sports'
};
// 不收（不是一般人會「搜尋並前往」的地方）
const EXCLUDE = new Set(['amenity=parking_space', 'amenity=bench', 'amenity=waste_basket', 'amenity=waste_disposal', 'amenity=recycling', 'amenity=drinking_water', 'amenity=shelter', 'amenity=parcel_locker',
  'amenity=vending_machine', 'amenity=bicycle_parking', 'amenity=parking_entrance', 'amenity=clock', 'amenity=post_box', 'amenity=telephone', 'amenity=loading_dock', 'amenity=letter_box', 'amenity=water_point',
  'amenity=fountain', 'amenity=bbq', 'amenity=lounger', 'amenity=smoking_area', 'amenity=grit_bin', 'amenity=hunting_stand', 'amenity=compressed_air', 'amenity=give_box', 'amenity=photo_booth',
  'tourism=information', 'tourism=picnic_site', 'tourism=artwork', 'leisure=pitch', 'leisure=picnic_table', 'leisure=track', 'leisure=slipway', 'leisure=firepit', 'leisure=outdoor_seating', 'leisure=bleachers', 'shop=vacant', 'shop=no', 'amenity=yes']);
const KEEP_UNNAMED = new Set(['fuel', 'charging', 'parking', 'moto_parking', 'atm', 'toilets', 'convenience', 'pharmacy', 'bike_rental']);
const KEYS = ['amenity', 'shop', 'tourism', 'leisure', 'healthcare', 'office', 'craft', 'railway', 'public_transport', 'aeroway'];

// 標籤 → 類別代碼；不收回傳 null
export function categoryOf(t, named) {
  for (const k of KEYS) {
    const v = t[k]; if (!v) continue; const kv = k + '=' + v;
    if (EXCLUDE.has(kv)) { if (k === 'tourism' && v === 'information' && t.information === 'office') return 'attraction'; continue; }
    const c = TAG[kv] || TAG[k + '=*']; if (!c) continue;
    if (!named && !KEEP_UNNAMED.has(c)) return null;
    return c;
  }
  return null;
}
export const CAT_CODES = Object.keys(CATEGORIES);
// 類別搜尋詞 → 類別（完全相同才算；例如「加油站」「atm」）
export const CAT_WORDS = new Map(); for (const [c, v] of Object.entries(CATEGORIES)) for (const w of v.words) CAT_WORDS.set(w.toLowerCase(), c);
// 品牌同義詞：查詢詞 → 一起找的其他寫法（只做查詢展開，不改資料）
export const SYNONYMS = [
  ['7-11', '7-eleven', '711', '小七', '統一超商', 'seven'], ['全家', 'familymart', '全家便利商店'], ['萊爾富', 'hi-life', 'hilife'], ['ok超商', 'ok mart', 'okmart'],
  ['全聯', '全聯福利中心', 'pxmart'], ['家樂福', 'carrefour'], ['好市多', 'costco'], ['麥當勞', 'mcdonalds', "mcdonald's", 'mcd'], ['肯德基', 'kfc'], ['摩斯', '摩斯漢堡', 'mos burger', 'mos'],
  ['星巴克', 'starbucks'], ['路易莎', 'louisa'], ['85度c', '85°c', '85度'], ['中油', '台灣中油', 'cpc'], ['屈臣氏', 'watsons'], ['康是美', 'cosmed'], ['宜家', 'ikea'], ['郵局', '中華郵政']
];
