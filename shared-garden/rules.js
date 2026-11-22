/*
 * 共享花園 - 規則引擎（純邏輯，不碰 DOM）
 *
 * 設計重點：
 * - 狀態是可 JSON 序列化的純物件。
 * - applyAction(state, action) 不修改傳入的 state，回傳 { ok, state, error }。
 * - 亂數使用存在 state.seed 的種子，同樣的狀態與動作會得到同樣結果。
 *   這樣之後多人連線時，可由伺服器執行同一份規則並廣播新狀態。
 * 所有數值都集中在 CONFIG / DECK_COUNTS，方便原型階段調整。
 */
(function (global) {
  'use strict';

  const CONFIG = {
    minPlayers: 1, // 1 人僅供測試；正式為 2–4 人
    maxPlayers: 4,
    maxSlots: 6, // 花園最多幾株植物
    startHand: 4,
    handCap: 5,
    threatLimit: 8, // 威脅達到此值即失敗
    winMatureByPlayers: { 1: 2, 2: 3, 3: 4, 4: 4 }, // 依人數，勝利所需的成熟植物數
    maxRounds: 12, // 超過回合數仍未勝利則失敗
    thresholds: [2, 3], // 幼苗→成長需 2 點；成長→成熟再需 3 點
    attackEveryByPlayers: { 1: 4, 2: 4, 3: 6, 4: 6 }, // 依人數，每 N 回合病毒每回合多感染 1 株
    extraAttackByPlayers: { 1: 0, 2: 0, 3: 1, 4: 2 }, // 依人數，病毒每回合額外感染的株數
  };

  const SPECIES = {
    sunflower: { name: '巨大向日葵', emoji: '🌻', ability: '成長後：回合結束時，給進度最少的其他植物 +1 照料' },
    turtle: { name: '圓葉山烏龜', emoji: '🐢', ability: '成長後：自身免疫感染。成熟後：病毒每回合少感染 1 株，威脅 -1' },
    tomato: { name: '星空番茄', emoji: '🍅', ability: '成長後：擁有者手牌上限 +1，每回合多抽 1 張' },
    lantern: { name: '火焰燈籠果', emoji: '🏮', ability: '成長後：回合結束時淨化 1 株。成熟後：淨化全部感染' },
    earth: { name: '地球花', emoji: '🌼', ability: '由地球種子種下，沒有特殊能力' }
  };

  const CHARACTERS = {
    straw: { id: 'straw', name: '戴草帽的人', emoji: '👒', plant: 'sunflower', role: '照料／支援' },
    shiba: { id: 'shiba', name: '白柴犬', emoji: '🐶', plant: 'turtle', role: '守護／抵擋' },
    alien: { id: 'alien', name: '外星人', emoji: '👽', plant: 'tomato', role: '改變局勢' },
    elf: { id: 'elf', name: '精靈', emoji: '🧚', plant: 'lantern', role: '清理／爆發' }
  };

  const CARDS = {
    water: { id: 'water', name: '澆水', emoji: '💧', kind: '照料', target: 'plant', care: 1, desc: '選 1 株植物，+1 照料點' },
    soil: { id: 'soil', name: '土壤', emoji: '🟫', kind: '照料', target: 'plant', care: 1, desc: '選 1 株植物，+1 照料點' },
    fertilizer: { id: 'fertilizer', name: '肥料', emoji: '🧪', kind: '照料', target: 'plant', care: 2, desc: '選 1 株植物，+2 照料點' },
    seed: { id: 'seed', name: '地球種子', emoji: '🌰', kind: '種植', target: null, desc: '在花園種下 1 株幼苗地球花' },
    shield: { id: 'shield', name: '防護罩', emoji: '🛡️', kind: 'Buff', target: 'plant', desc: '選 1 株植物，擋下下一次病毒攻擊（僅本回合病毒階段）' },
    cleanse: { id: 'cleanse', name: '淨化', emoji: '✨', kind: 'Buff', target: 'infected', desc: '淨化 1 株被感染的植物，威脅 -1' },
    sunshine: { id: 'sunshine', name: '暖陽', emoji: '☀️', kind: 'Buff', target: null, desc: '本回合內，所有照料牌 +1 照料點' }
  };

  const DECK_COUNTS = { water: 10, soil: 8, fertilizer: 5, seed: 5, shield: 4, cleanse: 4, sunshine: 3 };

  const STAGE_NAMES = ['幼苗', '成長', '成熟'];

  // ---------- 工具 ----------
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function rand(s) { // mulberry32，種子存在 state
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
    s.log.push({ round: s.round, text: text });
    if (s.log.length > 80) s.log.shift();
  }

  function fail(state, error) { return { ok: false, state: state, error: error }; }

  // ---------- 查詢 ----------
  function plantName(p) { return SPECIES[p.species].name; }

  function winTarget(s) { return Math.min(CONFIG.maxSlots - 1, CONFIG.winMatureByPlayers[s.players.length]); }

  function matureCount(s) { return s.plants.filter(function (p) { return p.stage === 2; }).length; }

  /** 找出角色專屬植物（需存活且達到指定階段） */
  function ownedPlant(s, species, minStage) {
    return s.plants.find(function (p) {
      return p.species === species && p.owner !== null && p.stage >= minStage;
    }) || null;
  }

  function playerPlant(s, player) {
    const species = CHARACTERS[player.charId].plant;
    return s.plants.find(function (p) { return p.owner === player.id && p.species === species; }) || null;
  }

  function handCapFor(s, player) {
    const p = playerPlant(s, player);
    return CONFIG.handCap + (p && p.species === 'tomato' && p.stage >= 1 ? 1 : 0);
  }

  function drawCountFor(s, player) {
    const p = playerPlant(s, player);
    return 1 + (p && p.species === 'tomato' && p.stage >= 1 ? 1 : 0);
  }

  /** 本回合病毒階段預計攻擊幾株（給介面預告用） */
  function attackCount(s) {
    let n = 1 + Math.floor((s.round - 1) / (CONFIG.attackEveryByPlayers[s.players.length] || 4));
    n += CONFIG.extraAttackByPlayers[s.players.length] || 0;
    if (ownedPlant(s, 'turtle', 2)) n -= 1;
    return Math.max(0, n);
  }

  function needFor(plant) {
    return plant.stage >= 2 ? null : CONFIG.thresholds[plant.stage];
  }

  // ---------- 牌堆 ----------
  function buildDeck(s) {
    const d = [];
    Object.keys(DECK_COUNTS).forEach(function (id) {
      for (let i = 0; i < DECK_COUNTS[id]; i++) d.push(id);
    });
    return shuffle(d, s);
  }

  function drawOne(s) {
    if (!s.deck.length) {
      if (!s.discard.length) return null;
      s.deck = shuffle(s.discard, s);
      s.discard = [];
    }
    return s.deck.pop();
  }

  // ---------- 植物 ----------
  function newPlant(s, species, owner) {
    const p = { id: s.nextPlantId++, species: species, owner: owner, stage: 0, care: 0, infected: false, shield: 0 };
    s.plants.push(p);
    return p;
  }

  function addCare(s, plant, n) {
    plant.care += n;
    while (plant.stage < 2 && plant.care >= CONFIG.thresholds[plant.stage]) {
      plant.care -= CONFIG.thresholds[plant.stage];
      plant.stage += 1;
      log(s, plantName(plant) + ' 升級為「' + STAGE_NAMES[plant.stage] + '」！');
    }
    if (plant.stage >= 2) plant.care = 0;
  }

  function cleansePlant(s, plant) {
    plant.infected = false;
    log(s, plantName(plant) + ' 的感染被淨化了。');
  }

  // ---------- 勝負 ----------
  function finish(s, win, reason) {
    s.phase = 'over';
    s.result = { win: win, reason: reason };
    log(s, (win ? '勝利：' : '失敗：') + reason);
  }

  function checkWin(s) {
    if (s.phase !== 'over' && matureCount(s) >= winTarget(s)) {
      finish(s, true, '花園裡有 ' + matureCount(s) + ' 株成熟植物，大家守住了共享花園！');
    }
  }

  function checkLose(s) {
    if (s.phase === 'over') return;
    if (s.plants.length === 0) finish(s, false, '花園裡的植物全部失去生機。');
    else if (s.threat >= CONFIG.threatLimit) finish(s, false, '病毒威脅達到上限。');
  }

  // ---------- 回合 ----------
  function startTurn(s) {
    const p = s.players[s.turnIdx];
    const cap = handCapFor(s, p);
    let n = drawCountFor(s, p);
    let drawn = 0;
    while (n > 0 && p.hand.length < cap) {
      const c = drawOne(s);
      if (!c) break;
      p.hand.push(c);
      drawn++; n--;
    }
    log(s, p.name + ' 的回合，抽了 ' + drawn + ' 張牌。');
  }

  function plantScore(p) { return p.stage * 10 + p.care; }

  function passivePhase(s) {
    const sun = ownedPlant(s, 'sunflower', 1);
    if (sun) {
      const others = s.plants.filter(function (p) { return p !== sun && p.stage < 2; });
      const pool = others.length ? others : (sun.stage < 2 ? [sun] : []);
      if (pool.length) {
        pool.sort(function (a, b) { return plantScore(a) - plantScore(b) || a.id - b.id; });
        log(s, plantName(sun) + ' 照料了 ' + plantName(pool[0]) + '（+1）。');
        addCare(s, pool[0], 1);
      }
    }
    const lan = ownedPlant(s, 'lantern', 1);
    if (lan) {
      const infected = s.plants.filter(function (p) { return p.infected; });
      const targets = lan.stage >= 2 ? infected : infected.slice(0, 1);
      targets.forEach(function (p) { cleansePlant(s, p); });
    }
  }

  function virusPhase(s) {
    // 1. 已感染的植物失去生機：先扣照料點，再退階，最後枯萎
    s.plants.slice().forEach(function (p) {
      if (!p.infected) return;
      if (p.care > 0) {
        p.care -= 1;
        log(s, plantName(p) + ' 被病毒侵蝕，失去 1 點照料。');
      } else if (p.stage > 0) {
        p.stage -= 1;
        p.care = 0;
        log(s, plantName(p) + ' 被病毒侵蝕，退回「' + STAGE_NAMES[p.stage] + '」。');
      } else {
        s.plants.splice(s.plants.indexOf(p), 1);
        log(s, plantName(p) + ' 枯萎了……');
      }
    });

    // 2. 新的攻擊：從未感染的植物中隨機選目標
    const turtle = ownedPlant(s, 'turtle', 1);
    const n = attackCount(s);
    const candidates = shuffle(s.plants.filter(function (p) { return !p.infected; }), s);
    candidates.slice(0, n).forEach(function (p) {
      if (p.shield > 0) {
        log(s, '防護罩擋下了對 ' + plantName(p) + ' 的病毒攻擊。');
      } else if (turtle && p === turtle) {
        log(s, plantName(p) + ' 抵擋了病毒。');
      } else {
        p.infected = true;
        log(s, '病毒感染了 ' + plantName(p) + '！');
      }
    });
    s.plants.forEach(function (p) { p.shield = 0; });

    // 3. 威脅上升：每株被感染的植物 +1；成熟的山烏龜 -1
    const infectedNow = s.plants.filter(function (p) { return p.infected; }).length;
    let delta = infectedNow;
    if (ownedPlant(s, 'turtle', 2)) delta -= 1;
    s.threat = Math.max(0, s.threat + delta);
    log(s, '病毒威脅 ' + (delta >= 0 ? '+' : '') + delta + '，目前 ' + s.threat + '/' + CONFIG.threatLimit + '。');
  }

  function endRound(s) {
    log(s, '—— 第 ' + s.round + ' 回合結束，花園與病毒階段 ——');
    passivePhase(s);
    checkWin(s);
    if (s.phase === 'over') return;
    virusPhase(s);
    checkLose(s);
    if (s.phase === 'over') return;
    if (s.round >= CONFIG.maxRounds) {
      finish(s, false, '已過 ' + CONFIG.maxRounds + ' 回合，花園還沒能及時成熟。');
    }
  }

  function advance(s) {
    s.turnIdx += 1;
    if (s.turnIdx >= s.players.length) {
      endRound(s);
      if (s.phase === 'over') { s.turnIdx = s.players.length - 1; return; }
      s.round += 1;
      s.turnIdx = 0;
      s.buffs.bonusCare = 0;
    }
    startTurn(s);
  }

  // ---------- 出牌 ----------
  /** 回傳錯誤字串；成功則直接修改 s 並回傳 null */
  function playCard(s, player, card, targetId) {
    let plant = null;
    if (card.target) {
      plant = s.plants.find(function (p) { return p.id === targetId; });
      if (!plant) return '請選擇一株植物。';
    }
    if (card.target === 'plant' && card.kind === '照料' && plant.stage >= 2) return '這株植物已經成熟，不需要再照料。';
    if (card.target === 'infected' && !plant.infected) return '淨化只能用在被感染的植物。';
    if (card.id === 'seed' && s.plants.length >= CONFIG.maxSlots) return '花園已經沒有空位了。';

    switch (card.id) {
      case 'water':
      case 'soil':
      case 'fertilizer': {
        const amount = card.care + s.buffs.bonusCare;
        log(s, player.name + ' 對 ' + plantName(plant) + ' 使用「' + card.name + '」（+' + amount + '）。');
        addCare(s, plant, amount);
        break;
      }
      case 'seed': {
        newPlant(s, 'earth', null);
        log(s, player.name + ' 種下了一株地球花。');
        break;
      }
      case 'shield':
        plant.shield = 1;
        log(s, player.name + ' 為 ' + plantName(plant) + ' 加上防護罩。');
        break;
      case 'cleanse':
        cleansePlant(s, plant);
        s.threat = Math.max(0, s.threat - 1);
        log(s, player.name + ' 使用「淨化」，威脅 -1。');
        break;
      case 'sunshine':
        s.buffs.bonusCare += 1;
        log(s, player.name + ' 召喚暖陽，本回合照料牌 +1。');
        break;
      default:
        return '未知的牌。';
    }
    return null;
  }

  // ---------- 對外 API ----------
  /**
   * players: [{ name, charId }]，charId 不可重複
   * options: { seed }
   */
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
      round: 1, turnIdx: 0, phase: 'play', result: null,
      players: [], plants: [], nextPlantId: 1,
      deck: [], discard: [], threat: 0, buffs: { bonusCare: 0 }, log: []
    };
    s.deck = buildDeck(s);
    players.forEach(function (p, i) {
      const pl = { id: 'p' + (i + 1), name: p.name || ('玩家' + (i + 1)), charId: p.charId, hand: [] };
      s.players.push(pl);
      newPlant(s, CHARACTERS[p.charId].plant, pl.id);
      for (let k = 0; k < CONFIG.startHand; k++) {
        const c = drawOne(s);
        if (c) pl.hand.push(c);
      }
    });
    log(s, '遊戲開始！目標：讓 ' + winTarget(s) + ' 株植物成熟，威脅別到 ' + CONFIG.threatLimit + '。');
    startTurn(s);
    return s;
  }

  /**
   * action:
   *   { type: 'play', playerId?, cardIndex, target? }  target 為植物 id
   *   { type: 'discard', playerId?, cardIndex }        棄 1 張牌並抽 1 張，視為本回合行動
   */
  function applyAction(state, action) {
    if (state.phase === 'over') return fail(state, '遊戲已經結束。');
    const s = clone(state);
    const player = s.players[s.turnIdx];
    if (action.playerId && action.playerId !== player.id) return fail(state, '還沒輪到你。');
    const cardId = player.hand[action.cardIndex];
    if (!cardId) return fail(state, '找不到這張牌。');

    if (action.type === 'discard') {
      player.hand.splice(action.cardIndex, 1);
      s.discard.push(cardId);
      const c = drawOne(s);
      if (c) player.hand.push(c);
      log(s, player.name + ' 棄掉「' + CARDS[cardId].name + '」並換了 1 張牌。');
    } else if (action.type === 'play') {
      const err = playCard(s, player, CARDS[cardId], action.target);
      if (err) return fail(state, err);
      player.hand.splice(action.cardIndex, 1);
      s.discard.push(cardId);
    } else {
      return fail(state, '未知的動作。');
    }

    checkWin(s);
    if (s.phase !== 'over') advance(s);
    return { ok: true, state: s };
  }

  /** 這張牌目前可以選哪些植物為目標；不需要目標的牌回傳 null */
  function validTargets(state, cardId) {
    const card = CARDS[cardId];
    if (!card.target) return null;
    return state.plants.filter(function (p) {
      if (card.target === 'infected') return p.infected;
      if (card.kind === '照料') return p.stage < 2;
      return true;
    }).map(function (p) { return p.id; });
  }

  global.GardenRules = {
    CONFIG: CONFIG, SPECIES: SPECIES, CHARACTERS: CHARACTERS, CARDS: CARDS, DECK_COUNTS: DECK_COUNTS,
    STAGE_NAMES: STAGE_NAMES,
    createGame: createGame, applyAction: applyAction, validTargets: validTargets,
    attackCount: attackCount, winTarget: winTarget, matureCount: matureCount, needFor: needFor, playerPlant: playerPlant
  };
})(typeof window !== 'undefined' ? window : globalThis);
