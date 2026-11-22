/*
 * 共享花園：冒險版規則引擎（純邏輯，不碰 DOM）
 *
 * 地圖：起點花園 → 三選一 → 三選一 → 休息點花園 → 三選一 → BOSS
 * - 每個「三選一」欄位有三個地點，其中一個是寶箱或隨機事件；只能走到相鄰的路線。
 * - 收集卡牌：每位玩家有自己的戰鬥牌組（起始 10 張）。植物升階時，植物主人選 1 張專屬牌；
 *   成熟時也可以改成強化一張已收集的專屬牌。打贏怪物後每人選 1 張地球植物牌。
 * - 照料牌是全隊共用的花園牌堆，只在花園栽培室使用。
 * - 植物殘骸可向植物研究者換牌卡「＋」升級；淨化因子可剝除 BOSS 的核心外殼（主線解謎）。
 * - 狀態是可 JSON 序列化的純物件；applyAction 不修改傳入的 state。
 * - 亂數使用存在 state.seed 的種子，之後可直接放到伺服器執行。
 * 所有數值集中在 CONFIG / CARDS / VIRUSES，方便試玩時調整。
 */
(function (global) {
  'use strict';

  const CONFIG = {
    minPlayers: 1, // 1 人僅供測試；正式為 2–4 人
    maxPlayers: 4,
    battleHand: 5, // 戰鬥中每回合開始抽到幾張
    gardenHand: 4, // 每次進花園時，照料手牌補到幾張
    handCap: 8,
    maxEnergy: 3, // 戰鬥中每位玩家每回合的能量
    playerHp: 30,
    thresholds: [4, 6], // 三階段：幼苗→成長需 4 點照料；成長→成熟再需 6 點
    // 花園栽培室
    potSlots: 3,
    potThresholds: [2, 3],
    startSeeds: 1,
    mintBlock: 3, // 成熟薄荷：每場戰鬥開始全隊護盾
    dandelionDraw: 1, // 成熟蒲公英：每場戰鬥第一回合每人多抽
    aloeHeal: 5, // 成熟蘆薈：戰鬥勝利後全隊恢復
    // 收集卡牌
    rewardOffer: 3, // 戰後每人看到幾張地球植物牌
    // 植物殘骸：打贏怪物取得，可向植物研究者換牌卡升級
    remainsByTier: { mini: 1, elite: 2 },
    upgradeCost: 2,
    // 地圖
    mapLayout: ['garden', 'lanes', 'lanes', 'rest', 'lanes', 'boss'],
    lanePlans: [['mini', 'mini'], ['mini', 'elite'], ['elite', 'mini']],
    chestPicks: 2,
    chestSeeds: 1,
    chestGrowChance: 0.5, // 寶箱裡「成長」（研究者給的立即生長）出現的機率
    restHeal: 15,
    anyDownLoses: true, // true：任何玩家生命歸零即失敗；false：全員倒下才失敗
    sporeBonus: 2, // 每層孢子讓病毒攻擊 +N 傷害
    // 難度數值依 dev/adv-sim.html 機器人模擬調整；需真人試玩再確認
    virusHpScale: { 1: 0.58, 2: 1.45, 3: 2.3, 4: 3.0 },
    virusDmgScale: 1.65,
    // 病毒每回合只打一人，人多時每人被打的次數變少，所以依人數補傷害
    // 20261123 收集卡牌版拿掉植物被動能力後重新調整（原 1.05／1.25／1.5）
    virusDmgByPlayers: { 1: 0.8, 2: 0.95, 3: 1.05, 4: 1.15 }
  };

  // style：牌組特色，給介面說明用（植物不再有被動能力，個性全由專屬牌表現）
  const SPECIES = {
    sunflower: { name: '巨大向日葵', emoji: '🌻', art: 'sunflower', style: '支援・抽牌・能量' },
    turtle: { name: '圓葉山烏龜', emoji: '🐢', art: 'turtle', style: '防禦・護盾・替隊友承傷' },
    tomato: { name: '星空番茄', emoji: '🍅', art: 'tomato', style: '控制・削弱病毒・抽牌' },
    lantern: { name: '火焰燈籠果', emoji: '🏮', art: 'lantern', style: '攻擊・淨化・爆發' }
  };

  const POT_SPECIES = {
    mint: { name: '薄荷', emoji: '🍃', effect: '成熟後：每場戰鬥開始，全隊各獲得 3 點護盾' },
    dandelion: { name: '蒲公英', emoji: '🌼', effect: '成熟後：每場戰鬥第一回合，每人多抽 1 張' },
    aloe: { name: '蘆薈', emoji: '🌵', effect: '成熟後：每次戰鬥勝利，全隊恢復 5 生命' },
    mushroom: { name: '蘑菇', emoji: '🍄', effect: '成熟後：每次戰鬥勝利，多得 1 個植物殘骸' }
  };

  const CHARACTERS = {
    straw: { id: 'straw', name: '戴草帽的人', emoji: '👒', art: 'straw', plant: 'sunflower', role: '支援／補給' },
    shiba: { id: 'shiba', name: '白柴犬', emoji: '🐶', art: 'shiba', plant: 'turtle', role: '守護／承傷' },
    alien: { id: 'alien', name: '外星人', emoji: '👽', art: 'alien', plant: 'tomato', role: '控場／減傷' },
    elf: { id: 'elf', name: '精靈', emoji: '🧚', art: 'elf', plant: 'lantern', role: '攻擊／淨化' }
  };

  /*
   * 卡牌效果欄位（說明文字由 describe() 依數值自動產生）：
   *   dmg 傷害、sporeBonus 病毒有孢子時加傷、clearSpores＋dmgPerSpore 清孢子並依層數造成傷害
   *   spore 移除孢子、sporeClear 清除所有孢子
   *   block 目標護盾、blockAll 全隊護盾、selfBlock 自己護盾
   *   heal 目標恢復、healAll 全隊恢復、selfHeal 自己恢復
   *   draw 自己抽、drawTarget 目標抽、drawAll 全隊抽、foresight 抽到 0–1 費再抽 1
   *   energy 目標本回合 +能量、power 目標本回合攻擊加成
   *   weaken 本回合病毒傷害 -N、halve 本回合病毒傷害減半
   *   chain 之後每打 1 張牌抽 1（上限 N）、guard 替隊友承受單體攻擊（傷害 -N）、thorns 受攻擊時反擊
   *   care 照料點（花園）
   * set：basic 基礎、earth 地球植物（戰後收穫）、物種 id 為該植物專屬
   */
  const CARDS = {
    // 基礎（每人起始牌組）
    thorn: { set: 'basic', name: '荊棘擊', emoji: '🌿', kind: '攻擊', cost: 1, dmg: 6 },
    leaf: { set: 'basic', name: '葉盾', emoji: '🍃', kind: '防禦', cost: 1, block: 6 },
    sunshine: { set: 'basic', name: '暖陽', emoji: '☀️', kind: 'Buff', cost: 1, heal: 6 },
    // 戴草帽的人・巨大向日葵
    sunseed: { set: 'sunflower', name: '葵花籽', emoji: '🌻', kind: 'Buff', cost: 1, draw: 2 },
    sunshare: { set: 'sunflower', name: '日光分享', emoji: '🌤️', kind: 'Buff', cost: 1, drawTarget: 2, heal: 2 },
    sunboost: { set: 'sunflower', name: '向陽充能', emoji: '⚡', kind: 'Buff', cost: 0, energy: 1 },
    noon: { set: 'sunflower', name: '正午烈陽', emoji: '🌞', kind: 'Buff', cost: 2, drawAll: 1, healAll: 4 },
    golden: { set: 'sunflower', name: '金色花盤', emoji: '🏵️', kind: 'Buff', cost: 1, chain: 3 },
    // 白柴犬・圓葉山烏龜
    shell: { set: 'turtle', name: '龜甲', emoji: '🐢', kind: '防禦', cost: 1, selfBlock: 8 },
    turtleleaf: { set: 'turtle', name: '龜葉護盾', emoji: '🪴', kind: '防禦', cost: 1, block: 7, selfBlock: 3 },
    guard: { set: 'turtle', name: '並肩守護', emoji: '🤝', kind: '防禦', cost: 1, guard: 3 },
    fortress: { set: 'turtle', name: '圓葉堡壘', emoji: '🏰', kind: '防禦', cost: 2, blockAll: 6 },
    counter: { set: 'turtle', name: '縮殼反擊', emoji: '💥', kind: '防禦', cost: 1, selfBlock: 6, thorns: 6 },
    // 外星人・星空番茄
    stardust: { set: 'tomato', name: '星塵偏移', emoji: '✨', kind: '特殊', cost: 1, weaken: 4 },
    foresight: { set: 'tomato', name: '番茄預知', emoji: '🔮', kind: '特殊', cost: 0, draw: 1, foresight: true },
    anchor: { set: 'tomato', name: '重力錨', emoji: '⚓', kind: '特殊', cost: 1, spore: 1, weaken: 2 },
    timetomato: { set: 'tomato', name: '時空番茄', emoji: '⏳', kind: '特殊', cost: 2, halve: true },
    nebula: { set: 'tomato', name: '星雲迷霧', emoji: '🌌', kind: '特殊', cost: 1, drawAll: 1, weaken: 3 },
    // 精靈・火焰燈籠果
    flame: { set: 'lantern', name: '燈火', emoji: '🔥', kind: '攻擊', cost: 1, dmg: 7 },
    purge: { set: 'lantern', name: '燈火淨化', emoji: '🏮', kind: '攻擊', cost: 1, dmg: 6, spore: 1 },
    ember: { set: 'lantern', name: '燼光綻放', emoji: '🎇', kind: '攻擊', cost: 2, dmg: 10, sporeBonus: 4 },
    inferno: { set: 'lantern', name: '業火燈籠', emoji: '☄️', kind: '攻擊', cost: 2, dmg: 16 },
    pureflame: { set: 'lantern', name: '淨焰', emoji: '💫', kind: '攻擊', cost: 1, clearSpores: true, dmgPerSpore: 4 },
    // 地球植物（戰後收穫）
    mintleaf: { set: 'earth', name: '薄荷葉', emoji: '🌱', kind: 'Buff', cost: 1, selfHeal: 5, draw: 1 },
    thornvine: { set: 'earth', name: '荊棘藤', emoji: '🥀', kind: '防禦', cost: 1, selfBlock: 3, thorns: 5 },
    dandelionseed: { set: 'earth', name: '蒲公英種子', emoji: '🌼', kind: 'Buff', cost: 1, draw: 1, drawTarget: 1 },
    hedge: { set: 'earth', name: '樹籬', emoji: '🌳', kind: '防禦', cost: 1, blockAll: 3 },
    mushroom: { set: 'earth', name: '蘑菇傘', emoji: '🍄', kind: '防禦', cost: 1, blockAll: 2, weaken: 1 },
    petal: { set: 'earth', name: '花瓣風暴', emoji: '🌸', kind: '攻擊', cost: 2, dmg: 11 },
    pollen: { set: 'earth', name: '花粉祝福', emoji: '🌾', kind: 'Buff', cost: 1, power: 3 },
    cleanse: { set: 'earth', name: '淨化', emoji: '🫧', kind: '特殊', cost: 1, spore: 2, draw: 1 },
    vine: { set: 'earth', name: '藤蔓纏繞', emoji: '🪢', kind: '特殊', cost: 1, weaken: 3 },
    miracle: { set: 'earth', name: '奇蹟種子', emoji: '🌠', kind: '特殊', cost: 1, blockAll: 5, sporeClear: true },
    // 花園：照料
    water: { set: 'garden', name: '澆水', emoji: '💧', kind: '照料', care: 1 },
    soil: { set: 'garden', name: '土壤', emoji: '🟫', kind: '照料', care: 1 },
    fertilizer: { set: 'garden', name: '肥料', emoji: '🧪', kind: '照料', care: 2 },
    superfert: { set: 'garden', name: '特殊肥料', emoji: '💎', kind: '照料', care: 3, consumable: true }
  };

  // 「＋」升級版：只寫有變化的數值（植物研究者用殘骸升級，或專屬牌在成熟時強化）
  const UPGRADES = {
    thorn: { dmg: 9 }, leaf: { block: 9 }, sunshine: { heal: 10 },
    sunseed: { draw: 3 }, sunshare: { drawTarget: 3, heal: 4 }, sunboost: { energy: 2 }, noon: { healAll: 7 }, golden: { chain: 5 },
    shell: { selfBlock: 12 }, turtleleaf: { block: 10, selfBlock: 4 }, guard: { guard: 6 }, fortress: { blockAll: 9 }, counter: { selfBlock: 8, thorns: 9 },
    stardust: { weaken: 6 }, foresight: { draw: 2 }, anchor: { spore: 2, weaken: 3 }, timetomato: { cost: 1 }, nebula: { weaken: 5 },
    flame: { dmg: 10 }, purge: { dmg: 9, spore: 2 }, ember: { dmg: 14, sporeBonus: 6 }, inferno: { dmg: 22 }, pureflame: { dmgPerSpore: 6 },
    mintleaf: { selfHeal: 8 }, thornvine: { selfBlock: 5, thorns: 8 }, dandelionseed: { drawTarget: 2 }, hedge: { blockAll: 5 }, mushroom: { blockAll: 3, weaken: 2 },
    petal: { dmg: 15 }, pollen: { power: 5 }, cleanse: { spore: 3, draw: 2 }, vine: { weaken: 5 }, miracle: { blockAll: 8 },
    water: { care: 2 }, soil: { care: 2 }, fertilizer: { care: 3 }
  };

  // 各植物的專屬牌：起始 2 張、升到成長二選一、升到成熟二選一
  const GROWTH_CARDS = {
    sunflower: { start: 'sunseed', grow: ['sunshare', 'sunboost'], mature: ['noon', 'golden'] },
    turtle: { start: 'shell', grow: ['turtleleaf', 'guard'], mature: ['fortress', 'counter'] },
    tomato: { start: 'stardust', grow: ['foresight', 'anchor'], mature: ['timetomato', 'nebula'] },
    lantern: { start: 'flame', grow: ['purge', 'ember'], mature: ['inferno', 'pureflame'] }
  };

  const STARTER_BASIC = { thorn: 4, leaf: 3, sunshine: 1 }; // 再加 2 張專屬起始牌，共 10 張
  const GARDEN_DECK = { water: 10, soil: 8, fertilizer: 5 };

  /** 依效果欄位產生說明文字 */
  function describe(c) {
    const p = [];
    if (c.clearSpores) p.push('清除病毒所有孢子，每清除 1 層造成 ' + c.dmgPerSpore + ' 傷害');
    if (c.dmg) p.push('對病毒造成 ' + c.dmg + ' 傷害' + (c.sporeBonus ? '；病毒有孢子時再 +' + c.sporeBonus : ''));
    if (c.spore) p.push('病毒孢子 -' + c.spore);
    if (c.sporeClear) p.push('清除病毒所有孢子');
    if (c.block) p.push('一位玩家獲得 ' + c.block + ' 護盾');
    if (c.blockAll) p.push('全隊各獲得 ' + c.blockAll + ' 護盾');
    if (c.selfBlock) p.push('自己獲得 ' + c.selfBlock + ' 護盾');
    if (c.heal && !c.drawTarget) p.push('一位玩家恢復 ' + c.heal + ' 生命');
    if (c.healAll) p.push('全隊各恢復 ' + c.healAll + ' 生命');
    if (c.selfHeal) p.push('自己恢復 ' + c.selfHeal + ' 生命');
    if (c.draw) p.push('抽 ' + c.draw + ' 張' + (c.foresight ? '；抽到 0–1 費的牌時再抽 1 張' : ''));
    if (c.drawTarget) p.push('一位玩家抽 ' + c.drawTarget + ' 張' + (c.heal ? '並恢復 ' + c.heal + ' 生命' : ''));
    if (c.drawAll) p.push('全隊各抽 ' + c.drawAll + ' 張');
    if (c.energy) p.push('一位玩家本回合 +' + c.energy + ' 能量');
    if (c.power) p.push('一位玩家本回合每張攻擊牌 +' + c.power + ' 傷害');
    if (c.weaken) p.push('本回合病毒傷害 -' + c.weaken);
    if (c.halve) p.push('本回合病毒傷害減半');
    if (c.chain) p.push('本回合之後你每打出 1 張牌，抽 1 張（最多 ' + c.chain + ' 張）');
    if (c.guard) p.push('本回合病毒的單體攻擊改打你，傷害 -' + c.guard);
    if (c.thorns) p.push('本回合你受到攻擊時，對病毒造成 ' + c.thorns + ' 傷害');
    if (c.care) p.push('一株植物 +' + c.care + ' 照料點' + (c.consumable ? '，用完即消失' : ''));
    return p.join('；');
  }

  // 補齊衍生欄位：id、scope、target、說明，並產生「＋」版
  Object.keys(CARDS).forEach(function (id) {
    const c = CARDS[id];
    c.id = id;
    c.scope = c.set === 'garden' ? 'garden' : 'battle';
  });
  Object.keys(UPGRADES).forEach(function (id) {
    const base = CARDS[id];
    CARDS[id + '+'] = Object.assign({}, base, UPGRADES[id], { id: id + '+', base: id, name: base.name + '＋', upgraded: true });
  });
  Object.keys(CARDS).forEach(function (id) {
    const c = CARDS[id];
    // 需要拖到某位玩家（花園中可拖到植物或盆栽）的牌
    c.target = (c.care || c.block || c.heal || c.drawTarget || c.energy || c.power) ? 'player' : null;
    c.desc = describe(c);
  });

  const EARTH_POOL = Object.keys(CARDS).filter(function (id) { return CARDS[id].set === 'earth' && !CARDS[id].upgraded; });

  // 寶箱收穫：從四種中選
  const REWARDS = {
    grow: { id: 'grow', name: '成長', emoji: '🌱⬆️', needTarget: true, desc: '選 1 位玩家，他的植物立刻升一階（並獲得升階選牌）' },
    superfert: { id: 'superfert', name: '特殊肥料', emoji: '💎', needTarget: true, desc: '選 1 位玩家，獲得 1 張「特殊肥料」（+3 照料），可在花園使用' },
    seed: { id: 'seed', name: '特殊種子', emoji: '🌠', needTarget: false, desc: '每位玩家的牌組各加入 1 張「奇蹟種子」' },
    purify: { id: 'purify', name: '淨化因子', emoji: '💠', needTarget: false, desc: '取得 1 個淨化因子。傳說它能剝除病毒巢穴深處的核心外殼……' }
  };

  const EVENTS = {
    bees: {
      name: '迷路的蜜蜂', emoji: '🐝', text: '一群蜜蜂在霧裡打轉，牠們找不到回花田的路。',
      choices: [
        { label: '幫忙帶路', desc: '全隊每人 -4 生命；植物最小的玩家獲得 1 張特殊肥料' },
        { label: '悄悄離開', desc: '什麼都不發生' }
      ]
    },
    rot: {
      name: '腐土', emoji: '🪱', text: '腳下的土壤又黑又軟，裡面似乎埋著什麼在發光。',
      choices: [
        { label: '挖開腐土', desc: '全隊專屬植物 -1 照料點（不會退階）；獲得 1 個淨化因子' },
        { label: '繞過去', desc: '什麼都不發生' }
      ]
    },
    spring: {
      name: '林間泉水', emoji: '⛲', text: '清澈的泉水閃著微光，喝起來甜甜的。',
      choices: [
        { label: '大家喝一口', desc: '全隊恢復 8 生命' },
        { label: '裝一瓶閃光泉水', desc: '牌最少的玩家獲得 1 張奇蹟種子' }
      ]
    },
    seedbag: {
      name: '遺落的種子袋', emoji: '🎒', text: '路邊有個舊布袋，裡面裝著幾顆圓滾滾的種子。',
      choices: [
        { label: '全部帶走', desc: '獲得 2 顆地球種子' },
        { label: '拿一顆，把其他埋回土裡', desc: '獲得 1 顆地球種子；全隊恢復 4 生命' }
      ]
    },
    researcher: {
      name: '植物研究者', emoji: '🧑‍🔬', text: '一位研究者正在收集被病毒侵蝕的植物殘骸，他願意用研究成果幫你們強化牌卡。',
      choices: [
        { label: '跟他交易', desc: '用植物殘骸換牌卡升級（每次 2 個）' },
        { label: '請他看看植物', desc: '全隊專屬植物各 +1 照料點' }
      ]
    }
  };

  // art：介面使用的角色圖（assets/*.png）
  const VIRUSES = {
    mold: {
      id: 'mold', tier: 'mini', name: '黴斑', emoji: '🟢', art: 'virus-mini', hp: 20, armor: 0,
      pattern: [{ kind: 'attack', dmg: 5 }, { kind: 'attack', dmg: 6 }]
    },
    spore: {
      id: 'spore', tier: 'mini', name: '小孢子', emoji: '🍄', art: 'virus-spore', hp: 22, armor: 0,
      pattern: [{ kind: 'spread', dmg: 3 }, { kind: 'attack', dmg: 6 }]
    },
    blight: {
      id: 'blight', tier: 'elite', name: '枯萎孢子', emoji: '🍂', art: 'virus-elite', hp: 40, armor: 0,
      pattern: [{ kind: 'attack', dmg: 7 }, { kind: 'spread', dmg: 4 }, { kind: 'attack', dmg: 9 }]
    },
    bloom: {
      id: 'bloom', tier: 'boss', name: '蔓生之王', emoji: '🦠', art: 'virus-boss', hp: 70, armor: 2,
      pattern: [{ kind: 'attack', dmg: 9 }, { kind: 'attack', dmg: 5, all: true }, { kind: 'spread', dmg: 6 }, { kind: 'attack', dmg: 12 }]
    }
  };

  const NODE_TYPES = {
    garden: { name: '起點花園', emoji: '🌱' },
    rest: { name: '休息點花園', emoji: '🏕️' },
    mini: { name: '迷你怪', emoji: '⚔️' },
    elite: { name: '小怪', emoji: '🗡️' },
    boss: { name: 'BOSS', emoji: '👑' },
    treasure: { name: '寶箱', emoji: '🎁' },
    event: { name: '隨機事件', emoji: '❓' }
  };

  const STAGE_NAMES = ['幼苗', '成長', '成熟'];
  const MAX_STAGE = STAGE_NAMES.length - 1;

  // ---------- 工具 ----------
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function rand(s) { // mulberry32
    s.seed = (s.seed + 0x6D2B79F5) >>> 0;
    let t = s.seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function shuffle(arr, s) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand(s) * (i + 1));
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  function log(s, text) {
    s.log.push({ col: s.col, text: text });
    if (s.log.length > 150) s.log.shift();
  }

  function fail(state, error) { return { ok: false, state: state, error: error }; }
  function alive(p) { return p.hp > 0; }
  function aliveList(s) { return s.players.filter(alive); }
  function findPlayer(s, id) { return s.players.find(function (p) { return p.id === id; }) || null; }

  // ---------- 牌堆 ----------
  function buildDeck(counts, s) {
    const d = [];
    Object.keys(counts).forEach(function (id) {
      for (let i = 0; i < counts[id]; i++) d.push(id);
    });
    return shuffle(d, s);
  }

  /** 從 { deck, discard } 抽 n 張到 hand；牌庫空了就洗棄牌堆 */
  function drawFrom(s, pile, hand, n) {
    let drawn = 0;
    const got = [];
    while (n > 0 && hand.length < CONFIG.handCap) {
      if (!pile.deck.length) {
        if (!pile.discard.length) break;
        pile.deck = shuffle(pile.discard, s);
        pile.discard = [];
      }
      const c = pile.deck.pop();
      hand.push(c);
      got.push(c);
      n--; drawn++;
    }
    return got;
  }

  function drawBattle(s, p, n) { return drawFrom(s, p, p.hand, n).length; }

  /** 玩家擁有的所有戰鬥牌（牌庫＋棄牌＋手牌） */
  function playerCards(p) { return p.deck.concat(p.discard, p.hand); }

  /** 把玩家擁有的一張 fromId 換成 toId；找不到回傳 false */
  function replaceCard(p, fromId, toId) {
    const lists = [p.deck, p.discard, p.hand];
    for (let i = 0; i < lists.length; i++) {
      const k = lists[i].indexOf(fromId);
      if (k !== -1) { lists[i][k] = toId; return true; }
    }
    return false;
  }

  function giveCard(s, p, id, why) {
    p.discard.push(id);
    log(s, p.name + ' 獲得「' + CARDS[id].name + '」' + (why || '') + '，加入自己的牌組。');
  }

  // ---------- 植物與升階選牌 ----------
  function grow(s, plant, n, thresholds) {
    const before = plant.stage;
    plant.care += n;
    while (plant.stage < MAX_STAGE && plant.care >= thresholds[plant.stage]) {
      plant.care -= thresholds[plant.stage];
      plant.stage += 1;
    }
    if (plant.stage >= MAX_STAGE) plant.care = 0;
    return plant.stage - before;
  }

  /** 專屬植物升階：記錄並排入選牌 */
  function onPlantStage(s, player) {
    log(s, player.name + ' 的' + SPECIES[player.plant.species].name + ' 長到「' + STAGE_NAMES[player.plant.stage] + '」了！');
    queuePick(s, player, player.plant.stage);
  }

  function addCare(s, player, n) {
    const from = player.plant.stage;
    grow(s, player.plant, n, CONFIG.thresholds);
    for (let st = from + 1; st <= player.plant.stage; st++) {
      const real = player.plant.stage;
      player.plant.stage = st; // 讓紀錄與選牌對應每一階
      onPlantStage(s, player);
      player.plant.stage = real;
    }
  }

  /** 可以在成熟時強化的牌：自己擁有、還沒升級的專屬牌 */
  function enhanceable(player) {
    const set = player.plant.species;
    const ids = {};
    playerCards(player).forEach(function (c) { if (CARDS[c].set === set && !CARDS[c].upgraded) ids[c] = true; });
    return Object.keys(ids);
  }

  function queuePick(s, player, stage) {
    const g = GROWTH_CARDS[player.plant.species];
    s.picks.push({ playerId: player.id, stage: stage, options: (stage >= MAX_STAGE ? g.mature : g.grow).slice(), enhance: stage >= MAX_STAGE });
  }

  function resolvePick(s, choice) {
    const pk = s.picks[0];
    const p = findPlayer(s, pk.playerId);
    if (choice === 'skip') {
      log(s, p.name + ' 這次不拿牌。');
    } else if (typeof choice === 'string' && choice.indexOf('enhance:') === 0) {
      if (!pk.enhance) return '這次升階不能強化牌。';
      const id = choice.slice(8);
      if (enhanceable(p).indexOf(id) === -1) return '沒有這張可以強化的專屬牌。';
      replaceCard(p, id, id + '+');
      log(s, p.name + ' 把「' + CARDS[id].name + '」強化成「' + CARDS[id + '+'].name + '」！');
    } else {
      if (pk.options.indexOf(choice) === -1) return '請從選項中選一張牌。';
      giveCard(s, p, choice, '（植物升階）');
    }
    s.picks.shift();
    return null;
  }

  function needFor(plant) { return plant.stage >= MAX_STAGE ? null : CONFIG.thresholds[plant.stage]; }
  function potNeed(pot) { return pot.stage >= MAX_STAGE ? null : CONFIG.potThresholds[pot.stage]; }

  function maturePots(s, species) {
    return s.pots.filter(function (p) { return p && p.species === species && p.stage >= MAX_STAGE; }).length;
  }

  function sow(s, index) {
    if (s.seeds <= 0) return '沒有地球種子。';
    if (index < 0 || index >= CONFIG.potSlots) return '沒有這個盆栽。';
    if (s.pots[index]) return '這個盆栽已經種了植物。';
    const ids = Object.keys(POT_SPECIES);
    const species = ids[Math.floor(rand(s) * ids.length)];
    s.seeds -= 1;
    s.pots[index] = { species: species, stage: 0, care: 0 };
    log(s, '在盆栽裡種下一顆地球種子……冒出了「' + POT_SPECIES[species].name + '」的芽！');
    return null;
  }

  // ---------- 地圖 ----------
  function makeNode(col, lane, type) {
    const nt = NODE_TYPES[type];
    return { id: col + '-' + lane, col: col, lane: lane, type: type, name: nt.name, emoji: nt.emoji };
  }

  function buildMap(s) {
    const pools = {};
    Object.keys(VIRUSES).forEach(function (id) {
      const tier = VIRUSES[id].tier;
      (pools[tier] = pools[tier] || []).push(id);
    });
    Object.keys(pools).forEach(function (t) { shuffle(pools[t], s); });
    const used = {};
    const events = shuffle(Object.keys(EVENTS), s);
    let ev = 0, plan = 0;

    function fill(node) {
      if (pools[node.type]) {
        const pool = pools[node.type];
        const k = used[node.type] || 0;
        node.virus = pool[k % pool.length];
        used[node.type] = k + 1;
        node.name = VIRUSES[node.virus].name;
      } else if (node.type === 'event') {
        node.event = events[ev++ % events.length];
      }
      return node;
    }

    s.map = CONFIG.mapLayout.map(function (kind, col) {
      if (kind !== 'lanes') return [fill(makeNode(col, 1, kind))];
      const special = rand(s) < 0.5 ? 'treasure' : 'event';
      const types = shuffle([special].concat(CONFIG.lanePlans[plan++ % CONFIG.lanePlans.length]), s);
      return types.map(function (t, lane) { return fill(makeNode(col, lane, t)); });
    });
  }

  function currentNode(s) {
    const col = s.map[s.col];
    return col.find(function (n) { return n.lane === s.lane; }) || col[0];
  }

  function reachable(s) {
    const next = s.map[s.col + 1];
    if (!next) return [];
    const cur = currentNode(s);
    const single = s.map[s.col].length === 1 || next.length === 1;
    return next.filter(function (n) { return single || Math.abs(n.lane - cur.lane) <= 1; })
      .map(function (n) { return n.id; });
  }

  function moveTo(s, id) {
    if (reachable(s).indexOf(id) === -1) return '這個地點現在去不了。';
    const node = s.map[s.col + 1].find(function (n) { return n.id === id; });
    s.col = node.col;
    s.lane = node.lane;
    s.path.push(id);
    enterNode(s, node);
    return null;
  }

  function enterNode(s, node) {
    if (node.type === 'garden' || node.type === 'rest') enterGarden(s);
    else if (node.virus) startBattle(s, node);
    else if (node.type === 'treasure') {
      s.seeds += CONFIG.chestSeeds;
      log(s, '發現一個發光的寶箱！裡面還有 ' + CONFIG.chestSeeds + ' 顆地球種子。');
      s.scene = 'reward';
      // 「成長」不一定出現：機率判定成功時，植物研究者會在寶箱旁提供
      const options = Object.keys(REWARDS).filter(function (id) { return id !== 'grow'; });
      if (rand(s) < CONFIG.chestGrowChance) {
        options.unshift('grow');
        log(s, '植物研究者在寶箱旁等著：「我可以讓一株植物立刻長大。」');
      }
      s.reward = { kind: 'chest', left: CONFIG.chestPicks, taken: [], options: options };
    } else if (node.type === 'event') {
      s.scene = 'event';
      s.event = { id: node.event };
      log(s, '遇到「' + EVENTS[node.event].name + '」。');
    }
  }

  // ---------- 病毒意圖 ----------
  function intentOf(s) {
    const b = s.battle;
    const v = b.virus;
    const pattern = VIRUSES[v.id].pattern;
    const step = pattern[(b.round - 1) % pattern.length];
    const living = aliveList(s);
    const spore = v.spore + (step.kind === 'spread' ? 1 : 0);
    const scale = CONFIG.virusDmgScale * (CONFIG.virusDmgByPlayers[s.players.length] || 1);
    const dmg = Math.round(step.dmg * scale) + spore * CONFIG.sporeBonus;
    let target = step.all || !living.length ? null : living[(b.round - 1) % living.length];
    let redirected = false;
    if (target && b.guard && b.guard.playerId !== target.id) {
      const g = findPlayer(s, b.guard.playerId);
      if (g && alive(g)) { target = g; redirected = true; }
    }
    let text;
    if (step.all) text = '全體攻擊，每人 ' + dmg + ' 傷害';
    else text = (step.kind === 'spread' ? '擴散孢子，並' : '') + '攻擊 ' + (target ? target.name : '') + '，' + dmg + ' 傷害' + (redirected ? '（' + target.name + ' 挺身守護）' : '');
    return { kind: step.kind, dmg: dmg, all: !!step.all, targetId: target ? target.id : null, spread: step.kind === 'spread', redirected: redirected, text: text };
  }

  // ---------- 戰鬥 ----------
  function damageVirus(s, amount, source) {
    const v = s.battle.virus;
    const blocked = Math.min(v.armor, amount);
    const dmg = Math.max(0, amount - blocked);
    v.hp = Math.max(0, v.hp - dmg);
    return { dmg: dmg, blocked: blocked };
  }

  function hurt(s, target, amount) {
    const b = s.battle;
    amount = Math.max(0, amount - b.reduce);
    if (b.halve) amount = Math.floor(amount / 2);
    const used = Math.min(target.block, amount);
    target.block -= used;
    const rest = amount - used;
    target.hp = Math.max(0, target.hp - rest);
    log(s, target.name + ' 受到 ' + rest + ' 點傷害' + (used ? '（護盾擋下 ' + used + '）' : '') + '，剩 ' + target.hp + ' 生命。');
    const th = b.thorns[target.id];
    if (th && b.virus.hp > 0) {
      const r = damageVirus(s, th);
      log(s, target.name + ' 反擊，對病毒造成 ' + r.dmg + ' 傷害。');
    }
  }

  function startRound(s) {
    const b = s.battle;
    b.round += 1;
    b.reduce = 0;
    b.halve = false;
    b.guard = null;
    b.thorns = {};
    b.chain = {};
    s.players.forEach(function (p) {
      p.block = 0;
      b.energy[p.id] = alive(p) ? CONFIG.maxEnergy : 0;
      b.power[p.id] = 0;
      if (alive(p)) drawBattle(s, p, CONFIG.battleHand - p.hand.length);
    });
    if (b.round === 1) {
      const mint = maturePots(s, 'mint');
      if (mint) {
        aliveList(s).forEach(function (p) { p.block += CONFIG.mintBlock * mint; });
        log(s, '薄荷的清香護住了大家：全隊獲得 ' + CONFIG.mintBlock * mint + ' 護盾。');
      }
      const dand = maturePots(s, 'dandelion');
      if (dand) {
        aliveList(s).forEach(function (p) { drawBattle(s, p, CONFIG.dandelionDraw * dand); });
        log(s, '蒲公英的絨毛飄來好運：每人多抽 ' + CONFIG.dandelionDraw * dand + ' 張。');
      }
    }
    const first = s.players.findIndex(alive);
    s.turnIdx = first < 0 ? 0 : first;
    log(s, '—— 第 ' + b.round + ' 回合 ——');
  }

  function startBattle(s, node) {
    const def = VIRUSES[node.virus];
    const hp = Math.round(def.hp * (CONFIG.virusHpScale[s.players.length] || 1));
    s.scene = 'battle';
    s.players.forEach(function (p) {
      p.deck = shuffle(playerCards(p), s);
      p.discard = [];
      p.hand = [];
    });
    s.battle = {
      virus: { id: def.id, name: def.name, emoji: def.emoji, hp: hp, maxHp: hp, spore: 0, armor: def.armor },
      round: 0, energy: {}, power: {}, reduce: 0, halve: false, guard: null, thorns: {}, chain: {}
    };
    log(s, '遭遇「' + def.name + '」！');
    if (def.armor) log(s, def.name + ' 被核心外殼包覆：每次攻擊傷害 -' + def.armor + '。也許淨化因子能派上用場。');
    startRound(s);
  }

  function endBattle(s) {
    s.players.forEach(function (p) {
      p.block = 0;
      p.deck = playerCards(p);
      p.discard = [];
      p.hand = [];
    });
  }

  function finish(s, win, reason) {
    s.scene = 'over';
    s.result = { win: win, reason: reason };
    log(s, (win ? '勝利：' : '失敗：') + reason);
  }

  function checkLose(s) {
    if (s.scene === 'over') return;
    const downs = s.players.filter(function (p) { return !alive(p); });
    if (CONFIG.anyDownLoses && downs.length) finish(s, false, downs[0].name + ' 倒下了。');
    else if (downs.length === s.players.length) finish(s, false, '全隊都倒下了。');
  }

  function healAll(s, amount, where) {
    s.players.forEach(function (p) {
      const before = p.hp;
      p.hp = Math.min(CONFIG.playerHp, p.hp + amount);
      if (p.hp > before) log(s, p.name + ' 在' + where + '恢復了 ' + (p.hp - before) + ' 生命。');
    });
  }

  function healOne(p, n) {
    const before = p.hp;
    p.hp = Math.min(CONFIG.playerHp, p.hp + n);
    return p.hp - before;
  }

  /** 戰後每人從地球植物牌中抽 rewardOffer 張候選 */
  function makeOffers(s) {
    const offers = {};
    s.players.forEach(function (p) { offers[p.id] = shuffle(EARTH_POOL.slice(), s).slice(0, CONFIG.rewardOffer); });
    return offers;
  }

  function checkVictory(s) {
    if (s.scene !== 'battle' || s.battle.virus.hp > 0) return;
    const name = s.battle.virus.name;
    log(s, '擊敗了「' + name + '」！');
    endBattle(s);
    const aloe = maturePots(s, 'aloe');
    if (aloe) healAll(s, CONFIG.aloeHeal * aloe, '蘆薈的照顧下');
    const tier = VIRUSES[s.battle.virus.id].tier;
    if (tier === 'boss') {
      finish(s, true, '擊敗了「' + name + '」，病毒退去，陽光重新照亮大地。');
      return;
    }
    const remains = (CONFIG.remainsByTier[tier] || 0) + maturePots(s, 'mushroom'); // 成熟蘑菇分解出更多殘骸
    if (remains) {
      s.remains += remains;
      log(s, '撿到 ' + remains + ' 個植物殘骸（共 ' + s.remains + ' 個），可以拿去給植物研究者。');
    }
    s.scene = 'reward';
    s.reward = { kind: 'cards', offers: makeOffers(s), done: {} };
  }

  function virusPhase(s) {
    const b = s.battle;
    const it = intentOf(s);
    log(s, b.virus.name + '：' + it.text + '。');
    if (it.spread) b.virus.spore += 1;
    if (it.all) aliveList(s).forEach(function (p) { hurt(s, p, it.dmg); });
    else if (it.targetId) hurt(s, findPlayer(s, it.targetId), Math.max(0, it.dmg - (it.redirected ? b.guard.reduce : 0)));
    checkLose(s);
    if (s.scene === 'battle' && b.virus.hp <= 0) checkVictory(s); // 反擊打倒病毒
  }

  function endTurn(s) {
    let next = -1;
    for (let i = s.turnIdx + 1; i < s.players.length; i++) if (alive(s.players[i])) { next = i; break; }
    if (next >= 0) { s.turnIdx = next; return; }
    virusPhase(s);
    if (s.scene !== 'battle') return;
    startRound(s);
  }

  // ---------- 出牌 ----------
  function playGardenCard(s, player, card, targetId) {
    const t = targetId || player.id;
    if (/^pot\d+$/.test(t)) {
      const pot = s.pots[Number(t.slice(3))];
      if (!pot) return '這個盆栽還沒種植物。';
      if (pot.stage >= MAX_STAGE) return '這株植物已經成熟，不需要再照料。';
      log(s, player.name + ' 用「' + card.name + '」照料了盆栽裡的' + POT_SPECIES[pot.species].name + '（+' + card.care + '）。');
      if (grow(s, pot, card.care, CONFIG.potThresholds)) log(s, '盆栽裡的' + POT_SPECIES[pot.species].name + ' 長到「' + STAGE_NAMES[pot.stage] + '」了！');
      return null;
    }
    const tp = findPlayer(s, t);
    if (!tp) return '請選擇一株植物。';
    if (tp.plant.stage >= MAX_STAGE) return '這株植物已經成熟，不需要再照料。';
    log(s, player.name + ' 用「' + card.name + '」照料了 ' + tp.name + ' 的植物（+' + card.care + '）。');
    addCare(s, tp, card.care);
    return null;
  }

  /** 依卡牌效果欄位結算 */
  function playBattleCard(s, player, card, targetId) {
    const b = s.battle;
    const v = b.virus;
    if (b.energy[player.id] < card.cost) return '能量不足。';
    let tp = null;
    if (card.target === 'player') {
      tp = findPlayer(s, targetId || player.id);
      if (!tp) return '請選擇一位玩家。';
      if (!alive(tp)) return '目標已經倒下。';
    }
    b.energy[player.id] -= card.cost;
    const parts = [];

    if (card.clearSpores) {
      const n = v.spore;
      v.spore = 0;
      const r = damageVirus(s, n * card.dmgPerSpore);
      parts.push('清除 ' + n + ' 層孢子，造成 ' + r.dmg + ' 傷害');
    }
    if (card.dmg) {
      const amount = card.dmg + b.power[player.id] + (card.sporeBonus && v.spore > 0 ? card.sporeBonus : 0);
      const r = damageVirus(s, amount);
      parts.push('對病毒造成 ' + r.dmg + ' 傷害' + (r.blocked ? '（核心外殼擋下 ' + r.blocked + '）' : ''));
    }
    if (card.spore) { v.spore = Math.max(0, v.spore - card.spore); parts.push('孢子 -' + card.spore); }
    if (card.sporeClear) { v.spore = 0; parts.push('孢子全部消散'); }
    if (card.block) { tp.block += card.block; parts.push(tp.name + ' +' + card.block + ' 護盾'); }
    if (card.blockAll) { aliveList(s).forEach(function (p) { p.block += card.blockAll; }); parts.push('全隊 +' + card.blockAll + ' 護盾'); }
    if (card.selfBlock) { player.block += card.selfBlock; parts.push('自己 +' + card.selfBlock + ' 護盾'); }
    if (card.heal) parts.push(tp.name + ' 恢復 ' + healOne(tp, card.heal) + ' 生命');
    if (card.healAll) { aliveList(s).forEach(function (p) { healOne(p, card.healAll); }); parts.push('全隊恢復 ' + card.healAll + ' 生命'); }
    if (card.selfHeal) parts.push('自己恢復 ' + healOne(player, card.selfHeal) + ' 生命');
    if (card.draw) {
      const got = drawFrom(s, player, player.hand, card.draw);
      let extra = 0;
      if (card.foresight && got.some(function (c) { return CARDS[c].cost <= 1; })) extra = drawBattle(s, player, 1);
      parts.push('抽 ' + (got.length + extra) + ' 張');
    }
    if (card.drawTarget) parts.push(tp.name + ' 抽 ' + drawBattle(s, tp, card.drawTarget) + ' 張');
    if (card.drawAll) { aliveList(s).forEach(function (p) { drawBattle(s, p, card.drawAll); }); parts.push('全隊各抽 ' + card.drawAll + ' 張'); }
    if (card.energy) { b.energy[tp.id] += card.energy; parts.push(tp.name + ' +' + card.energy + ' 能量'); }
    if (card.power) { b.power[tp.id] += card.power; parts.push(tp.name + ' 本回合攻擊 +' + card.power); }
    if (card.weaken) { b.reduce += card.weaken; parts.push('本回合病毒傷害 -' + card.weaken); }
    if (card.halve) { b.halve = true; parts.push('本回合病毒傷害減半'); }
    if (card.guard) { b.guard = { playerId: player.id, reduce: card.guard }; parts.push('本回合守護隊友'); }
    if (card.thorns) { b.thorns[player.id] = (b.thorns[player.id] || 0) + card.thorns; parts.push('受攻擊時反擊 ' + card.thorns); }

    // 金色花盤：之前打出的連鎖抽牌（先結算，這張牌本身不觸發）
    if (b.chain[player.id] > 0) {
      b.chain[player.id] -= 1;
      if (drawBattle(s, player, 1)) parts.push('金色花盤再抽 1 張');
    }
    if (card.chain) { b.chain[player.id] = (b.chain[player.id] || 0) + card.chain; parts.push('之後每打 1 張牌抽 1 張'); }

    log(s, player.name + ' 使用「' + card.name + '」：' + parts.join('，') + '。');
    return null;
  }

  // ---------- 場景 ----------
  function enterGarden(s) {
    const node = currentNode(s);
    s.scene = 'garden';
    s.players.forEach(function (p) { drawFrom(s, s.gardenPile, p.gardenHand, CONFIG.gardenHand - p.gardenHand.length); });
    log(s, '來到「' + node.name + '」的花園栽培室，可以照料植物。');
    if (node.type === 'rest') healAll(s, CONFIG.restHeal, '休息點');
  }

  function claimChest(s, choice, targetId) {
    const r = REWARDS[choice];
    if (!r) return '請選擇一項收穫。';
    if (s.reward.options && s.reward.options.indexOf(choice) === -1) return '這次的寶箱沒有這項收穫。';
    if (s.reward.taken.indexOf(choice) !== -1) return '這項收穫已經選過了。';
    let tp = null;
    if (r.needTarget) {
      tp = findPlayer(s, targetId);
      if (!tp) return '請選擇一位玩家。';
    }
    if (choice === 'grow') {
      if (tp.plant.stage >= MAX_STAGE) return '這株植物已經成熟了。';
      tp.plant.stage += 1;
      tp.plant.care = 0;
      onPlantStage(s, tp);
    } else if (choice === 'superfert') {
      tp.gardenHand.push('superfert');
      log(s, '收穫「特殊肥料」：交給 ' + tp.name + '，可在花園使用。');
    } else if (choice === 'seed') {
      s.players.forEach(function (p) { giveCard(s, p, 'miracle', '（特殊種子）'); });
    } else if (choice === 'purify') {
      s.purity += 1;
      log(s, '收穫「淨化因子」：它散發著微光，似乎能對病毒的核心起反應。');
    }
    s.reward.taken.push(choice);
    s.reward.left -= 1;
    return null;
  }

  function claimCard(s, playerId, choice) {
    const p = findPlayer(s, playerId);
    if (!p) return '請指定玩家。';
    if (s.reward.done[p.id]) return p.name + ' 已經選過了。';
    if (choice === 'skip') log(s, p.name + ' 這次不拿新牌。');
    else {
      if (s.reward.offers[p.id].indexOf(choice) === -1) return '請從候選牌中選一張。';
      giveCard(s, p, choice, '（戰後收穫）');
    }
    s.reward.done[p.id] = true;
    return null;
  }

  function applyEvent(s, choice) {
    const id = s.event.id;
    const ev = EVENTS[id];
    const c = ev.choices[choice];
    if (!c) return '請選擇一個選項。';
    log(s, '「' + ev.name + '」：' + c.label + '。');
    if (id === 'bees' && choice === 0) {
      s.players.forEach(function (p) { p.hp = Math.max(1, p.hp - 4); });
      const tp = s.players.slice().sort(function (a, b) { return a.plant.stage - b.plant.stage; })[0];
      tp.gardenHand.push('superfert');
      log(s, '蜜蜂回家了，送給 ' + tp.name + ' 一張特殊肥料。');
    } else if (id === 'rot' && choice === 0) {
      s.players.forEach(function (p) { p.plant.care = Math.max(0, p.plant.care - 1); });
      s.purity += 1;
      log(s, '腐土裡挖出了 1 個淨化因子。');
    } else if (id === 'spring') {
      if (choice === 0) healAll(s, 8, '泉水旁');
      else {
        const tp = s.players.slice().sort(function (a, b) { return playerCards(a).length - playerCards(b).length; })[0];
        giveCard(s, tp, 'miracle', '（閃光泉水）');
      }
    } else if (id === 'seedbag') {
      if (choice === 0) { s.seeds += 2; log(s, '獲得 2 顆地球種子。'); }
      else { s.seeds += 1; healAll(s, 4, '種子袋旁'); log(s, '獲得 1 顆地球種子。'); }
    } else if (id === 'researcher') {
      if (choice === 0) return 'shop';
      s.players.forEach(function (p) { addCare(s, p, 1); });
    }
    return null;
  }

  /** 能和植物研究者交易的地方：休息點花園，或「植物研究者」事件 */
  function canTrade(s) {
    return s.scene === 'shop' || (s.scene === 'garden' && currentNode(s).type === 'rest');
  }

  /** 用植物殘骸升級一張牌。戰鬥牌需指定 playerId（升級誰的牌）；照料牌升級共用花園牌堆 */
  function upgradeCard(s, baseId, playerId) {
    if (!UPGRADES[baseId] || !CARDS[baseId] || CARDS[baseId].upgraded) return '這張牌不能升級。';
    if (s.remains < CONFIG.upgradeCost) return '植物殘骸不夠，需要 ' + CONFIG.upgradeCost + ' 個。';
    let ok = false, who = '';
    if (CARDS[baseId].scope === 'garden') {
      const lists = [s.gardenPile.deck, s.gardenPile.discard].concat(s.players.map(function (p) { return p.gardenHand; }));
      const l = lists.find(function (x) { return x.indexOf(baseId) !== -1; });
      if (l) { l[l.indexOf(baseId)] = baseId + '+'; ok = true; who = '花園牌堆'; }
    } else {
      const p = findPlayer(s, playerId);
      if (!p) return '請指定要升級誰的牌。';
      ok = replaceCard(p, baseId, baseId + '+');
      who = p.name;
    }
    if (!ok) return '找不到可以升級的「' + CARDS[baseId].name + '」。';
    s.remains -= CONFIG.upgradeCost;
    log(s, '植物研究者把' + who + '的 1 張「' + CARDS[baseId].name + '」升級成「' + CARDS[baseId + '+'].name + '」！（剩 ' + s.remains + ' 個植物殘骸）');
    return null;
  }

  // ---------- 對外 API ----------
  function createGame(players, options) {
    options = options || {};
    if (!Array.isArray(players) || players.length < CONFIG.minPlayers || players.length > CONFIG.maxPlayers) {
      throw new Error('玩家人數必須是 ' + CONFIG.minPlayers + '–' + CONFIG.maxPlayers + ' 人');
    }
    const used = {};
    players.forEach(function (p) {
      if (!CHARACTERS[p.charId]) throw new Error('未知的角色：' + p.charId);
      if (used[p.charId]) throw new Error('角色不可重複：' + p.charId);
      used[p.charId] = true;
    });
    const s = {
      seed: (options.seed === undefined ? Date.now() : options.seed) >>> 0,
      scene: 'garden', col: 0, lane: 1, path: ['0-1'], map: [],
      turnIdx: 0, result: null, battle: null, reward: null, event: null,
      picks: [], // 等待植物主人選牌的升階
      purity: 0, remains: 0, seeds: CONFIG.startSeeds, pots: [],
      players: [], gardenPile: { deck: [], discard: [] }, log: []
    };
    for (let i = 0; i < CONFIG.potSlots; i++) s.pots.push(null);
    buildMap(s);
    s.gardenPile.deck = buildDeck(GARDEN_DECK, s);
    players.forEach(function (p, i) {
      const species = CHARACTERS[p.charId].plant;
      const counts = Object.assign({}, STARTER_BASIC);
      counts[GROWTH_CARDS[species].start] = 2;
      s.players.push({
        id: 'p' + (i + 1), name: p.name || ('玩家' + (i + 1)), charId: p.charId,
        hp: CONFIG.playerHp, block: 0,
        deck: buildDeck(counts, s), discard: [], hand: [], gardenHand: [],
        plant: { species: species, stage: 0, care: 0 }
      });
    });
    log(s, '冒險開始！每個人帶著自己的 10 張起始牌。先在花園栽培室照料植物，再沿著地圖往東前進。');
    enterGarden(s);
    return s;
  }

  /**
   * action:
   *   { type: 'pick', choice }                         植物升階選牌：卡牌 id、'enhance:<id>' 或 'skip'（有待選時只能做這個）
   *   { type: 'play', playerId?, cardIndex, target? }  花園中 target 可為玩家 id 或 'pot0'..；需指定 playerId（誰的照料手牌）
   *   { type: 'sow', pot }                             花園中用地球種子在盆栽種新植物
   *   { type: 'endTurn' }                              戰鬥中結束自己的回合
   *   { type: 'purify' }                               戰鬥中使用淨化因子（不耗能量）
   *   { type: 'advance' }                              花園 → 地圖
   *   { type: 'move', node }                           地圖上前往相鄰的地點
   *   { type: 'reward', playerId, choice }             戰後：每人選 1 張地球植物牌（卡牌 id 或 'skip'）
   *   { type: 'reward', choice, target? }              寶箱：grow / superfert / seed / purify
   *   { type: 'event', choice }                        隨機事件選項
   *   { type: 'upgrade', card, playerId? }             用植物殘骸升級一張牌
   *   { type: 'leaveShop' }                            結束研究者事件的交易
   */
  function applyAction(state, action) {
    if (state.scene === 'over') return fail(state, '遊戲已經結束。');
    const s = clone(state);
    let err = null;

    if (s.picks.length && action.type !== 'pick') return fail(state, '請先替升階的植物選牌。');

    switch (action.type) {
      case 'pick':
        if (!s.picks.length) return fail(state, '現在沒有要選的牌。');
        err = resolvePick(s, action.choice);
        return err ? fail(state, err) : { ok: true, state: s };

      case 'advance':
        if (s.scene !== 'garden') return fail(state, '現在不在花園。');
        s.scene = 'map';
        return { ok: true, state: s };

      case 'move':
        if (s.scene !== 'map') return fail(state, '現在不在地圖上。');
        err = moveTo(s, action.node);
        return err ? fail(state, err) : { ok: true, state: s };

      case 'sow':
        if (s.scene !== 'garden') return fail(state, '只能在花園栽培室種植。');
        err = sow(s, Number(action.pot));
        return err ? fail(state, err) : { ok: true, state: s };

      case 'reward':
        if (s.scene !== 'reward') return fail(state, '現在沒有收穫可選。');
        if (s.reward.kind === 'cards') {
          err = claimCard(s, action.playerId, action.choice);
          if (err) return fail(state, err);
          if (s.players.every(function (p) { return s.reward.done[p.id]; })) { s.reward = null; s.scene = 'map'; }
        } else {
          err = claimChest(s, action.choice, action.target);
          if (err) return fail(state, err);
          if (s.reward.left <= 0) { s.reward = null; s.scene = 'map'; }
        }
        return { ok: true, state: s };

      case 'event':
        if (s.scene !== 'event') return fail(state, '現在沒有事件。');
        err = applyEvent(s, Number(action.choice));
        if (err === 'shop') { s.event = null; s.scene = 'shop'; return { ok: true, state: s }; }
        if (err) return fail(state, err);
        s.event = null;
        s.scene = 'map';
        return { ok: true, state: s };

      case 'upgrade':
        if (!canTrade(s)) return fail(state, '這裡沒有植物研究者。');
        err = upgradeCard(s, action.card, action.playerId);
        return err ? fail(state, err) : { ok: true, state: s };

      case 'leaveShop':
        if (s.scene !== 'shop') return fail(state, '現在不在交易中。');
        log(s, '向植物研究者道別。');
        s.scene = 'map';
        return { ok: true, state: s };

      case 'endTurn':
        if (s.scene !== 'battle') return fail(state, '現在不在戰鬥中。');
        if (action.playerId && action.playerId !== s.players[s.turnIdx].id) return fail(state, '還沒輪到你。');
        log(s, s.players[s.turnIdx].name + ' 結束回合。');
        endTurn(s);
        return { ok: true, state: s };

      case 'purify':
        if (s.scene !== 'battle') return fail(state, '只能在戰鬥中使用淨化因子。');
        if (s.purity <= 0) return fail(state, '沒有淨化因子。');
        if (!s.battle.virus.armor) return fail(state, '這隻病毒沒有核心外殼，淨化因子沒有反應。');
        s.purity -= 1;
        s.battle.virus.armor = 0;
        log(s, '淨化因子發出光芒，' + s.battle.virus.name + ' 的核心外殼碎裂了！');
        return { ok: true, state: s };

      case 'play': {
        const inBattle = s.scene === 'battle';
        if (!inBattle && s.scene !== 'garden') return fail(state, '現在不能出牌。');
        const player = inBattle ? s.players[s.turnIdx] : findPlayer(s, action.playerId || s.players[0].id);
        if (!player) return fail(state, '找不到玩家。');
        if (inBattle && action.playerId && action.playerId !== player.id) return fail(state, '還沒輪到你。');
        const hand = inBattle ? player.hand : player.gardenHand;
        const cardId = hand[action.cardIndex];
        if (!cardId) return fail(state, '找不到這張牌。');
        const card = CARDS[cardId];
        if (card.scope !== (inBattle ? 'battle' : 'garden')) return fail(state, inBattle ? '照料牌只能在花園使用。' : '戰鬥牌只能在戰鬥中使用。');
        err = inBattle ? playBattleCard(s, player, card, action.target) : playGardenCard(s, player, card, action.target);
        if (err) return fail(state, err);
        hand.splice(action.cardIndex, 1);
        if (inBattle) player.discard.push(cardId);
        else if (!card.consumable) s.gardenPile.discard.push(cardId);
        checkVictory(s);
        return { ok: true, state: s };
      }
    }
    return fail(state, '未知的動作。');
  }

  /** 牌卡庫用：隊伍擁有的每張牌數量（所有玩家牌組＋花園牌堆） */
  function ownedCounts(state) {
    const counts = {};
    function add(list) { list.forEach(function (c) { counts[c] = (counts[c] || 0) + 1; }); }
    state.players.forEach(function (p) { add(playerCards(p)); add(p.gardenHand); });
    add(state.gardenPile.deck); add(state.gardenPile.discard);
    return counts;
  }

  /** 某位玩家的牌組：{ 卡牌 id: 張數 } */
  function deckCounts(player) {
    const counts = {};
    playerCards(player).forEach(function (c) { counts[c] = (counts[c] || 0) + 1; });
    return counts;
  }

  global.GardenAdventure = {
    CONFIG: CONFIG, SPECIES: SPECIES, POT_SPECIES: POT_SPECIES, CHARACTERS: CHARACTERS, CARDS: CARDS,
    UPGRADES: UPGRADES, GROWTH_CARDS: GROWTH_CARDS, EARTH_POOL: EARTH_POOL, STARTER_BASIC: STARTER_BASIC,
    VIRUSES: VIRUSES, REWARDS: REWARDS, EVENTS: EVENTS, NODE_TYPES: NODE_TYPES, GARDEN_DECK: GARDEN_DECK,
    STAGE_NAMES: STAGE_NAMES, MAX_STAGE: MAX_STAGE,
    createGame: createGame, applyAction: applyAction, intentOf: intentOf, needFor: needFor, potNeed: potNeed,
    reachable: reachable, currentNode: currentNode, canTrade: canTrade, enhanceable: enhanceable,
    ownedCounts: ownedCounts, deckCounts: deckCounts, playerCards: playerCards
  };
})(typeof window !== 'undefined' ? window : globalThis);
