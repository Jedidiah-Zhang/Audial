export type AmbientScene =
  | "cafe"
  | "restaurant"
  | "street"
  | "office"
  | "nature"
  | "train"
  | "airport"
  | "beach"
  | "classroom"
  | "home"
  | "shop"
  | "generic";

// Multilingual keyword bank. Order matters: more specific scenes first so
// a "café" inside a "restaurant" sentence still picks restaurant when the
// stronger signal is present.
const SCENE_KEYWORDS: Array<{ scene: AmbientScene; words: string[] }> = [
  {
    scene: "airport",
    words: [
      "airport", "boarding", "flight", "departure", "terminal", "gate", "check-in", "passport", "customs",
      "机场", "登机", "航班", "起飞", "登机口", "海关",
      "空港", "搭乗", "フライト", "ゲート",
      "aeropuerto", "vuelo", "embarque", "puerta",
      "aéroport", "vol", "embarquement", "porte",
      "flughafen", "flug", "boarding",
    ],
  },
  {
    scene: "train",
    words: [
      "train", "subway", "metro", "platform", "railway", "station",
      "火车", "地铁", "站台", "高铁", "车站",
      "電車", "地下鉄", "駅", "ホーム",
      "tren", "metro", "andén", "estación",
      "train", "métro", "quai", "gare",
      "zug", "bahn", "bahnhof", "bahnsteig",
    ],
  },
  {
    scene: "restaurant",
    words: [
      "restaurant", "menu", "waiter", "waitress", "order", "dish", "appetizer", "dessert", "wine list", "reservation", "dinner", "lunch",
      "餐厅", "饭店", "服务员", "点菜", "菜单", "晚餐", "午餐", "甜点", "预订",
      "レストラン", "メニュー", "ウェイター", "注文", "ディナー", "予約",
      "restaurante", "camarero", "menú", "pedir", "cena", "almuerzo", "reserva",
      "restaurant", "serveur", "menu", "commander", "dîner", "déjeuner", "réservation",
      "restaurant", "kellner", "speisekarte", "bestellen", "abendessen",
    ],
  },
  {
    scene: "cafe",
    words: [
      "cafe", "café", "coffee", "latte", "espresso", "cappuccino", "barista", "tea shop",
      "咖啡", "咖啡馆", "拿铁", "卡布奇诺", "茶馆",
      "カフェ", "コーヒー", "ラテ", "喫茶店",
      "cafetería", "café", "barista",
      "café", "barista",
      "kaffee", "café",
    ],
  },
  {
    scene: "shop",
    words: [
      "shop", "store", "supermarket", "mall", "cashier", "cart", "discount", "checkout", "shopping",
      "商店", "超市", "商场", "购物", "收银", "结账",
      "店", "スーパー", "ショッピング", "レジ",
      "tienda", "supermercado", "compras", "cajero",
      "magasin", "supermarché", "courses", "caisse",
      "geschäft", "supermarkt", "einkaufen", "kasse",
    ],
  },
  {
    scene: "office",
    words: [
      "office", "meeting", "colleague", "boss", "deadline", "project", "report", "email", "spreadsheet", "manager", "client",
      "办公室", "会议", "同事", "老板", "项目", "报告", "客户", "经理",
      "オフィス", "会議", "同僚", "上司", "プロジェクト", "クライアント",
      "oficina", "reunión", "colega", "jefe", "proyecto", "informe", "cliente",
      "bureau", "réunion", "collègue", "patron", "projet", "rapport", "client",
      "büro", "besprechung", "kollege", "chef", "projekt", "kunde",
    ],
  },
  {
    scene: "classroom",
    words: [
      "classroom", "school", "teacher", "student", "lesson", "homework", "exam", "lecture", "professor",
      "教室", "学校", "老师", "学生", "课程", "作业", "考试", "教授",
      "教室", "学校", "先生", "生徒", "授業", "宿題", "試験",
      "aula", "escuela", "profesor", "estudiante", "clase", "tarea", "examen",
      "salle de classe", "école", "professeur", "élève", "cours", "devoirs", "examen",
      "klassenzimmer", "schule", "lehrer", "schüler", "unterricht", "prüfung",
    ],
  },
  {
    scene: "beach",
    words: [
      "beach", "ocean", "wave", "shore", "seaside", "surf", "sand",
      "海滩", "海边", "沙滩", "海浪",
      "ビーチ", "海", "波", "砂浜",
      "playa", "ola", "mar", "arena",
      "plage", "vague", "mer", "sable",
      "strand", "welle", "meer", "sand",
    ],
  },
  {
    scene: "nature",
    words: [
      "park", "forest", "mountain", "garden", "trail", "hike", "bird", "river", "lake", "tree", "outdoor",
      "公园", "森林", "山", "花园", "树", "鸟", "河", "湖", "户外",
      "公園", "森", "山", "庭", "鳥", "川", "湖",
      "parque", "bosque", "montaña", "jardín", "árbol", "pájaro", "río", "lago",
      "parc", "forêt", "montagne", "jardin", "arbre", "oiseau", "rivière", "lac",
      "park", "wald", "berg", "garten", "baum", "vogel", "fluss", "see",
    ],
  },
  {
    scene: "street",
    words: [
      "street", "traffic", "car", "taxi", "bus", "downtown", "intersection", "sidewalk", "crosswalk", "honking",
      "街道", "马路", "出租车", "公交", "市中心", "人行道", "十字路口",
      "通り", "道路", "タクシー", "バス", "交差点", "歩道",
      "calle", "tráfico", "taxi", "autobús", "centro", "acera",
      "rue", "circulation", "taxi", "bus", "centre-ville", "trottoir",
      "straße", "verkehr", "taxi", "bus", "innenstadt", "gehweg",
    ],
  },
  {
    scene: "home",
    words: [
      "home", "kitchen", "living room", "bedroom", "couch", "sofa", "tv at home",
      "家", "家里", "厨房", "客厅", "卧室", "沙发",
      "家", "キッチン", "リビング", "寝室", "ソファ",
      "casa", "cocina", "salón", "dormitorio", "sofá",
      "maison", "cuisine", "salon", "chambre", "canapé",
      "zuhause", "küche", "wohnzimmer", "schlafzimmer", "sofa",
    ],
  },
];

export function detectAmbientScene(text: string | undefined | null): AmbientScene {
  if (!text) return "generic";
  const haystack = text.toLowerCase();
  const scores = new Map<AmbientScene, number>();
  for (const { scene, words } of SCENE_KEYWORDS) {
    for (const w of words) {
      if (!w) continue;
      const lw = w.toLowerCase();
      // Use simple includes — works for CJK and latin alike. For very short
      // tokens (<=3 chars), require a word-boundary on latin to avoid noise.
      if (lw.length <= 3 && /^[a-z]+$/.test(lw)) {
        const re = new RegExp(`\\b${lw}\\b`, "i");
        if (re.test(haystack)) scores.set(scene, (scores.get(scene) ?? 0) + 1);
      } else if (haystack.includes(lw)) {
        scores.set(scene, (scores.get(scene) ?? 0) + 1);
      }
    }
  }
  let best: AmbientScene = "generic";
  let bestScore = 0;
  for (const [scene, score] of scores) {
    if (score > bestScore) {
      best = scene;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : "generic";
}
