/* 共享花園：冒險版介面層（單機輪流操作）。規則全部在 adventure-rules.js。
 * - 橫向卷軸：地圖往右延伸，可左右捲動；戰鬥與花園都是側視場景。
 * - 拖拉出牌：把手牌拖到發亮的目標（玩家、植物、盆栽或病毒）。也可以先點牌再點目標。
 * - 角色、植物、病毒圖片在 assets/（由企劃 Word 的角色表切出）。
 */
(function () {
  'use strict';
  const R = window.GardenAdventure;
  const C = R.CONFIG;
  const root = document.getElementById('app');

  const ui = {
    screen: 'home',
    setup: { count: 2, chars: ['straw', 'shiba', 'alien', 'elf'] },
    game: null,
    selected: null, // 手牌 index
    viewer: 0, // 花園中正在查看哪位玩家的照料手牌
    reward: null, // 寶箱：已選但還沒指定目標的收穫
    library: false,
    error: ''
  };
  const CHAR_IDS = Object.keys(R.CHARACTERS);
  const SET_ORDER = [
    { id: 'basic', name: '基礎牌（每人起始）' },
    { id: 'sunflower', name: '巨大向日葵專屬' }, { id: 'turtle', name: '圓葉山烏龜專屬' },
    { id: 'tomato', name: '星空番茄專屬' }, { id: 'lantern', name: '火焰燈籠果專屬' },
    { id: 'earth', name: '地球植物牌（戰後收穫）' }, { id: 'garden', name: '照料牌（花園共用）' }
  ];

  function esc(t) {
    return String(t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------- 圖片 ----------
  function art(name, cls, alt) {
    // 圖片資料夾可由頁面設定（dev/ 底下的測試頁用 '../assets/'）
    return '<img class="art ' + (cls || '') + '" src="' + (window.GARDEN_ASSETS || 'assets/') + name + '.png" alt="' + esc(alt || '') + '" draggable="false">';
  }
  /** 資源小圖示：purity 淨化因子、seed 地球種子、remains 植物殘骸 */
  const RES_NAME = { purity: '淨化因子', seed: '地球種子', remains: '植物殘骸' };
  function res(kind) { return art('icon-' + kind, 'res-icon', RES_NAME[kind]); }
  /** 寶箱收穫圖示 */
  const CHEST_ICON = { grow: 'chest-grow', superfert: 'chest-superfert', seed: 'chest-seed', purify: 'icon-purity' };
  /** 事件插圖；植物研究者沿用角色圖 */
  function eventArt(id, name) { return art(id === 'researcher' ? 'researcher' : 'event-' + id, 'event-art', name); }
  /** 角色圖；倒下時換成倒下的圖 */
  function charArt(charId, cls, down) { const ch = R.CHARACTERS[charId]; return art(ch.art + (down ? '-down' : ''), (cls || '') + ' char-' + charId, ch.name); }
  /** 地圖上非戰鬥地點的水彩圖示；隨機事件用該事件插圖的剪影＋問號，不劇透內容 */
  const NODE_ART = { garden: 'icon-seed', rest: 'aloe-2', treasure: 'chest' };
  function nodeIcon(n) {
    if (n.virus) return virusArt(n.virus, 'node-art');
    if (NODE_ART[n.type]) return art(NODE_ART[n.type], 'node-art', n.name);
    if (n.type === 'event' && n.event) {
      return '<span class="node-mystery">' + art(n.event === 'researcher' ? 'researcher' : 'event-' + n.event, 'node-art', '') + '<b>?</b></span>';
    }
    return '<span class="e">' + n.emoji + '</span>';
  }
  /** 專屬植物：幼苗、成長、成熟各有一張圖（assets/<物種>-<階段>.png） */
  function plantArt(plant, cls) {
    return art(plant.species + '-' + plant.stage, (cls || '') + ' stage-' + plant.stage, R.SPECIES[plant.species].name);
  }
  // 個別栽培植物的圖片例外（目前全部都有三階段圖，留著方便之後新增植物時暫代）
  const POT_ART = {};
  function potArt(pot, cls) {
    const name = POT_ART[pot.species] ? POT_ART[pot.species](pot.stage) : pot.species + '-' + pot.stage;
    return art(name, (cls || '') + ' stage-' + pot.stage, R.POT_SPECIES[pot.species].name);
  }
  function virusArt(v, cls) {
    const def = R.VIRUSES[v.id || v];
    return art(def.art, cls, def.name);
  }

  // 卡牌圖示（assets/card-*.png）；專屬牌依取得時機用該植物的幼苗／成長／成熟圖
  const CARD_ICON = {
    thorn: 'card-thorn', petal: 'card-petal', leaf: 'card-leaf', hedge: 'card-hedge', sunshine: 'card-sunshine',
    pollen: 'card-pollen', cleanse: 'card-cleanse', vine: 'card-vine', miracle: 'card-miracle',
    water: 'card-water', soil: 'card-soil', fertilizer: 'card-fertilizer', superfert: 'card-superfert',
    mintleaf: 'card-mint', dandelionseed: 'card-dandelion', thornvine: 'card-thorn', mushroom: 'mushroom-2'
  };
  function cardIcon(c) {
    const id = c.base || c.id;
    if (CARD_ICON[id]) return CARD_ICON[id];
    const g = R.GROWTH_CARDS[c.set];
    if (g) return c.set + '-' + (g.start === id ? 0 : g.grow.indexOf(id) !== -1 ? 1 : 2);
    return null;
  }

  /** 場景背景圖（assets/bg-*.jpg） */
  function sceneBg(name) { return '<div class="scene-bg" style="background-image:url(\'' + (window.GARDEN_ASSETS || 'assets/') + name + '.jpg\')"></div>'; }

  // ---------- 共用元件 ----------
  function bar(value, max, cls) {
    return '<div class="bar ' + cls + '"><i style="width:' + Math.max(0, Math.min(100, (value / max) * 100)) + '%"></i></div>';
  }

  function stageTrack(stage) {
    let h = '<div class="stage-track">';
    R.STAGE_NAMES.forEach(function (n, i) {
      h += '<span class="' + (i < stage ? 'done' : i === stage ? 'now' : '') + '">' + n + '</span>';
    });
    return h + '</div>';
  }

  function pips(need, care) {
    if (need === null) return '<span class="muted">✨ 成熟</span>';
    let h = '';
    for (let i = 0; i < need; i++) h += '<span class="pip' + (i < care ? ' on' : '') + '"></span>';
    return h;
  }

  /** 卡牌外觀（依企劃卡牌總覽）：藤蔓底框、左上費用、上方牌名、中間圖示、牌種、分隔線、說明 */
  function cardHtml(c, attrs, extraCls) {
    const icon = c.icon || cardIcon(c);
    const pic = icon ? art(icon, 'card-art', c.name) : '<span class="card-icon">' + c.emoji + '</span>';
    return '<button class="card kind-' + esc(c.kind) + ' set-' + (c.set || 'pot') + (c.upgraded ? ' upgraded' : '') + (extraCls ? ' ' + extraCls : '') + '" ' + (attrs || '') + '>' +
      (c.cost !== undefined ? '<span class="cost">' + c.cost + '</span>' : '') +
      '<div class="n">' + esc(c.name) + '</div><div class="pic">' + pic + '</div><div class="k">' + c.kind + '</div><div class="d">' + esc(c.desc) + '</div></button>';
  }

  /** 栽培室植物當作卡牌顯示（牌卡庫用） */
  function potCard(id) {
    const p = R.POT_SPECIES[id];
    return { name: p.name, kind: '栽培植物', desc: p.effect, icon: POT_ART[id] ? POT_ART[id](2) : id + '-2' };
  }

  function validTargets(g, card) {
    if (!card) return [];
    if (g.scene === 'battle') {
      if (!card.target) return ['playzone'];
      return g.players.filter(function (p) { return p.hp > 0; }).map(function (p) { return p.id; });
    }
    const ids = g.players.filter(function (p) { return p.plant.stage < R.MAX_STAGE; }).map(function (p) { return p.id; });
    g.pots.forEach(function (pot, i) { if (pot && pot.stage < R.MAX_STAGE) ids.push('pot' + i); });
    return ids;
  }

  function selectedCard(g) {
    if (ui.selected === null) return null;
    const p = g.scene === 'battle' ? g.players[g.turnIdx] : g.players[Math.min(ui.viewer, g.players.length - 1)];
    const hand = g.scene === 'battle' ? p.hand : p.gardenHand;
    return hand[ui.selected] ? R.CARDS[hand[ui.selected]] : null;
  }

  function targetAttrs(id, ok) { return ' data-act="target" data-id="' + id + '"' + (ok ? '' : ' disabled'); }

  function handView(g, p) {
    const inBattle = g.scene === 'battle';
    const hand = inBattle ? p.hand : p.gardenHand;
    let h = '<div class="hand">';
    hand.forEach(function (cid, i) {
      const c = R.CARDS[cid];
      const dis = inBattle && g.battle.energy[p.id] < c.cost;
      h += cardHtml(c, 'data-act="card" data-i="' + i + '"' + (dis ? ' disabled' : ''), i === ui.selected ? 'sel' : '');
    });
    if (!hand.length) h += '<span class="muted">' + (inBattle ? '沒有手牌' : '沒有照料牌了') + '</span>';
    return h + '</div>';
  }

  function hintFor(g, card) {
    if (!card) return g.scene === 'garden' ? '把照料牌拖到一株植物或盆栽上（也可以先點牌、再點植物）。' : '把牌拖到發亮的目標上出牌；沒事可做就結束回合。';
    if (g.scene === 'battle' && !card.target) return '「' + card.name + '」：拖到病毒身上，或點一下病毒。';
    return '「' + card.name + '」：拖到發亮的' + (g.scene === 'garden' ? '植物或盆栽' : '玩家') + '上。';
  }

  function logView(g) {
    let h = '<details class="panel log-panel"><summary>冒險紀錄</summary><div class="log">';
    g.log.slice().reverse().slice(0, 50).forEach(function (l) { h += '<div>' + esc(l.text) + '</div>'; });
    return h + '</div></details>';
  }

  function hud(g) {
    return '<div class="hud"><span>' + res('purity') + ' 淨化因子 ×' + g.purity + '</span><span>' + res('seed') + ' 地球種子 ×' + g.seeds + '</span>' +
      '<span title="打贏怪物取得，可向植物研究者換牌卡升級">' + res('remains') + ' 植物殘骸 ×' + g.remains + '</span>' +
      '<span class="spacer"></span>' + musicButton() + '<button class="btn secondary small" data-act="library">📖 牌卡庫</button>' +
      '<button class="btn secondary small" data-act="restart">🔄 重新開始</button></div>';
  }

  // 各場景背景：依目前場景挑背景圖
  function parallax(name) { return sceneBg(name || 'bg-reward'); }

  // ---------- 首頁與設定 ----------
  function homeView() {
    let cast = '';
    CHAR_IDS.forEach(function (id) {
      cast += '<div class="cast">' + charArt(id, 'cast-char') + art(R.CHARACTERS[id].plant + '-2', 'cast-plant') + '</div>';
    });
    return '<div class="home center">' + sceneBg('bg-start') + '<div class="home-inner"><div class="home-cast">' + cast + '</div>' +
      '<h1>共享花園：冒險版</h1>' +
      '<p class="muted">帶著植物夥伴往東前進，合作打牌擊退病毒。植物長大時，收集屬於自己的專屬牌。</p>' +
      '<div class="row"><button class="btn" data-act="local">開始本機試玩</button>' +
      '<button class="btn secondary" data-act="library">📖 牌卡庫</button>' + musicButton() +
      '<button class="btn secondary" disabled title="多人連線階段才會開放">建立房間（即將推出）</button></div>' +
      '<div class="home-foes">' + art('virus-mini', 'foe-mini') + art('virus-spore', 'foe-mini') + art('virus-elite', 'foe-elite') + art('virus-boss', 'foe-boss') + '</div>' +
      '<p class="muted">原型階段：同一台裝置輪流操作，手牌公開。舊版桌面花園規則在 <a href="classic.html">classic.html</a>。</p></div></div>';
  }

  function setupView() {
    const s = ui.setup;
    let h = '<h2>選擇人數與角色</h2><div class="panel"><div class="row">';
    for (let n = C.minPlayers; n <= C.maxPlayers; n++) {
      h += '<button class="btn secondary count-btn" data-act="count" data-n="' + n + '" aria-pressed="' + (s.count === n) + '">' +
        n + ' 人' + (n < 2 ? '（測試）' : '') + '</button>';
    }
    h += '</div></div>';
    for (let i = 0; i < s.count; i++) {
      h += '<div class="panel setup-player"><b>玩家 ' + (i + 1) + '</b><div class="chars">';
      CHAR_IDS.forEach(function (id) {
        const ch = R.CHARACTERS[id], sp = R.SPECIES[ch.plant];
        h += '<button class="char" data-act="char" data-i="' + i + '" data-id="' + id + '" aria-pressed="' + (s.chars[i] === id) + '">' +
          '<span class="char-pics">' + charArt(id, 'char-pic') + art(ch.plant + '-2', 'char-plant') + '</span>' +
          '<b>' + esc(ch.name) + '</b><small>' + esc(sp.name) + '・' + esc(sp.style) + '</small></button>';
      });
      h += '</div></div>';
    }
    return h + '<div class="row"><button class="btn secondary" data-act="home">返回</button>' +
      '<button class="btn" data-act="start">開始冒險</button></div>';
  }

  // ---------- 地圖（橫向卷軸） ----------
  const COL_W = 190;
  const LANE_Y = [22, 50, 78];

  function nodePos(n, colLen) { return { x: n.col * COL_W + COL_W / 2, y: colLen === 1 ? 50 : LANE_Y[n.lane] }; }

  function mapView(g) {
    const reach = R.reachable(g);
    const cur = R.currentNode(g);
    const width = g.map.length * COL_W;
    let lines = '';
    for (let c = 0; c + 1 < g.map.length; c++) {
      g.map[c].forEach(function (a) {
        g.map[c + 1].forEach(function (b) {
          const single = g.map[c].length === 1 || g.map[c + 1].length === 1;
          if (!single && Math.abs(a.lane - b.lane) > 1) return;
          const pa = nodePos(a, g.map[c].length), pb = nodePos(b, g.map[c + 1].length);
          const walked = g.path.indexOf(a.id) !== -1 && g.path.indexOf(b.id) !== -1;
          const next = a.id === cur.id && reach.indexOf(b.id) !== -1;
          lines += '<line x1="' + pa.x + '" y1="' + pa.y + '%" x2="' + pb.x + '" y2="' + pb.y + '%" class="' + (walked ? 'walked' : next ? 'next' : '') + '"/>';
        });
      });
    }
    let nodes = '';
    g.map.forEach(function (col) {
      col.forEach(function (n) {
        const p = nodePos(n, col.length);
        const can = reach.indexOf(n.id) !== -1;
        const done = g.path.indexOf(n.id) !== -1;
        const icon = nodeIcon(n);
        const label = n.virus ? R.NODE_TYPES[n.type].name + '<br>' + esc(n.name) : esc(n.name);
        nodes += '<button class="map-node type-' + n.type + (can ? ' reachable' : '') + (done ? ' done' : '') + (n.id === cur.id ? ' here' : '') + '"' +
          ' style="left:' + p.x + 'px;top:' + p.y + '%"' + (can ? ' data-act="move" data-id="' + n.id + '"' : ' disabled') + '>' +
          icon + '<small>' + label + '</small></button>';
      });
    });
    const cp = nodePos(cur, g.map[cur.col].length);
    const party = g.players.map(function (p) { return charArt(p.charId, 'party-char'); }).join('');
    return '<div class="scene map-scene">' +
      '<div class="map-head"><h2>🗺️ 往東前進</h2><span class="muted">選一個發亮的地點。三條路線只能走到相鄰的那條；每一欄都有一個寶箱 🎁 或隨機事件 ❓。左右滑動可以看整張地圖。</span></div>' +
      '<div class="map-scroll"><div class="map-track" style="width:' + width + 'px">' + parallax('bg-map') +
      '<svg class="map-lines" width="' + width + '" height="100%">' + lines + '</svg>' + nodes +
      '<div class="party" style="left:' + cp.x + 'px;top:' + cp.y + '%">' + party + '</div>' +
      '</div></div></div>';
  }

  // ---------- 花園栽培室 ----------
  function nextPickText(p) {
    if (p.plant.stage >= R.MAX_STAGE) return '已成熟';
    const g = R.GROWTH_CARDS[p.plant.species];
    const ids = p.plant.stage === 0 ? g.grow : g.mature;
    return '長到「' + R.STAGE_NAMES[p.plant.stage + 1] + '」時選牌：' + ids.map(function (id) { return R.CARDS[id].name; }).join(' / ') + (p.plant.stage === 1 ? ' / 或強化一張專屬牌' : '');
  }

  function gardenView(g) {
    const node = R.currentNode(g);
    const viewer = g.players[Math.min(ui.viewer, g.players.length - 1)];
    const card = selectedCard(g);
    const targets = validTargets(g, card);
    let h = '<div class="scene greenhouse">' + parallax('bg-garden') + '<div class="scene-body">' +
      '<h2>🪴 花園栽培室・' + esc(node.name) + '</h2>' +
      '<p class="muted">這裡很安靜。照料植物讓它們長大；植物每升一階，主人就能選一張專屬牌加入自己的牌組。</p>' +
      '<h3>專屬植物</h3><div class="plots">';
    g.players.forEach(function (p) {
      const sp = R.SPECIES[p.plant.species];
      const ok = targets.indexOf(p.id) !== -1;
      h += '<button class="plot' + (ok ? ' targetable' : '') + '"' + targetAttrs(p.id, ok) + '>' +
        '<div class="plot-pic">' + plantArt(p.plant, 'plot-plant') + charArt(p.charId, 'plot-owner') + '</div>' +
        '<div class="pname">' + esc(sp.name) + '</div>' +
        '<div class="owner">' + esc(p.name) + '・' + esc(R.CHARACTERS[p.charId].name) + '・❤️ ' + p.hp + '/' + C.playerHp + '</div>' +
        stageTrack(p.plant.stage) + '<div class="pips">' + pips(R.needFor(p.plant), p.plant.care) + '</div>' +
        '<div class="ability">' + esc(sp.style) + '<br>' + esc(nextPickText(p)) + '</div>' +
        '<div class="muted tiny">牌組 ' + R.playerCards(p).length + ' 張</div></button>';
    });
    h += '</div><h3>盆栽（新植物）</h3><div class="plots pots">';
    g.pots.forEach(function (pot, i) {
      if (!pot) {
        h += '<div class="plot pot empty"><div class="plot-pic">' + art('pot-empty', 'plot-plant stage-1', '空盆栽') + '</div><div class="pname">空盆栽</div>' +
          (g.seeds > 0
            ? '<button class="btn small" data-act="sow" data-i="' + i + '">' + res('seed') + ' 種下地球種子</button><div class="muted">剩 ' + g.seeds + ' 顆，會長成什麼呢？</div>'
            : '<div class="muted">沒有地球種子。寶箱和事件可能拿得到。</div>') + '</div>';
        return;
      }
      const ps = R.POT_SPECIES[pot.species];
      const ok = targets.indexOf('pot' + i) !== -1;
      h += '<button class="plot pot' + (ok ? ' targetable' : '') + (pot.stage >= R.MAX_STAGE ? ' mature' : '') + '"' + targetAttrs('pot' + i, ok) + '>' +
        '<div class="plot-pic">' + potArt(pot, 'plot-plant') + '</div><div class="pname">' + esc(ps.name) + '</div>' +
        stageTrack(pot.stage) + '<div class="pips">' + pips(R.potNeed(pot), pot.care) + '</div>' +
        '<div class="ability">' + esc(ps.effect) + (pot.stage >= R.MAX_STAGE ? '（生效中）' : '') + '</div></button>';
    });
    h += '</div></div></div><div class="panel"><div class="tabs">';
    g.players.forEach(function (p, i) {
      h += '<button class="tab" data-act="viewer" data-i="' + i + '" aria-pressed="' + (p === viewer) + '">' + charArt(p.charId, 'tab-pic') + ' ' + esc(p.name) + '（' + p.gardenHand.length + '）</button>';
    });
    h += '</div><div class="hint">' + esc(hintFor(g, card)) + '</div>' + handView(g, viewer) +
      '<div class="error">' + esc(ui.error) + '</div>' +
      '<div class="actions"><button class="btn" data-act="advance">🗺️ 前往地圖 ➜</button></div></div>';
    if (node.type === 'rest') h += shopPanel(g);
    return h;
  }

  // ---------- 戰鬥（側視） ----------
  function battleView(g) {
    const b = g.battle, v = b.virus, cur = g.players[g.turnIdx];
    const card = selectedCard(g);
    const targets = validTargets(g, card);
    const it = R.intentOf(g);
    let h = '<div class="scene battle-scene">' + parallax('bg-battle') + '<div class="scene-body">' +
      '<div class="topline">第 ' + b.round + ' 回合・輪到 <b>' + esc(cur.name) + '</b>' +
      '　⚡ 能量 <b>' + b.energy[cur.id] + '/' + C.maxEnergy + '</b>' +
      (b.reduce ? '　🛡️ 病毒傷害 -' + b.reduce : '') + (b.halve ? '　⏳ 病毒傷害減半' : '') +
      (b.power[cur.id] ? '　🌾 攻擊 +' + b.power[cur.id] : '') + '</div><div class="arena"><div class="party-row">';
    g.players.forEach(function (p, i) {
      const sp = R.SPECIES[p.plant.species];
      const ok = targets.indexOf(p.id) !== -1;
      const marks = (b.guard && b.guard.playerId === p.id ? '🤝' : '') + (b.thorns[p.id] ? '💥' : '');
      h += '<button class="hero' + (i === g.turnIdx ? ' active' : '') + (p.hp <= 0 ? ' down' : '') + (ok ? ' targetable' : '') + '"' + targetAttrs(p.id, ok) + '>' +
        '<div class="who">' + charArt(p.charId, 'hero-char', p.hp <= 0) + plantArt(p.plant, 'hero-plant') + (marks ? '<span class="marks">' + marks + '</span>' : '') + '</div>' +
        '<div class="nm">' + esc(p.name) + '</div><div class="muted tiny">' + esc(sp.name) + '・' + R.STAGE_NAMES[p.plant.stage] + '</div>' +
        bar(p.hp, C.playerHp, 'danger') + '<div class="nums">❤️ ' + p.hp + (p.block ? '　🛡️ ' + p.block : '') + '</div></button>';
    });
    const zoneOk = targets.indexOf('playzone') !== -1;
    h += '</div><div class="foe' + (zoneOk ? ' targetable' : '') + '" data-act="playzone">' +
      '<div class="intent">⚠️ ' + esc(it.text) + '</div>' + virusArt(v, 'foe-art tier-' + R.VIRUSES[v.id].tier) +
      '<div class="nm">' + esc(v.name) + '</div>' +
      bar(v.hp, v.maxHp, 'virus-hp') + '<div class="nums">❤️ ' + v.hp + '/' + v.maxHp + (v.spore ? '　🍄 孢子 ' + v.spore + '（傷害 +' + v.spore * C.sporeBonus + '）' : '') + '</div>' +
      (v.armor ? '<div class="armor">🔒 核心外殼：每次攻擊傷害 -' + v.armor + '</div>' : '') + '</div></div></div></div>';

    const canPurify = g.purity > 0 && v.armor > 0;
    h += '<div class="panel"><div class="hint">' + esc(hintFor(g, card)) + '<span class="muted deck-info">　🂠 牌庫 ' + cur.deck.length + '・棄牌 ' + cur.discard.length + '</span></div>' + handView(g, cur) +
      '<div class="error">' + esc(ui.error) + '</div><div class="actions">' +
      '<button class="btn" data-act="play"' + (card && !card.target ? '' : ' disabled') + '>出牌</button>' +
      (canPurify ? '<button class="btn purify" data-act="purify">' + res('purity') + ' 使用淨化因子</button>' : '') +
      '<button class="btn secondary" data-act="endturn">結束回合</button></div>' +
      '<div class="muted others">隊友手牌：' + g.players.filter(function (p, i) { return i !== g.turnIdx; }).map(function (p) {
        return esc(p.name) + '：' + (p.hand.map(function (c) { return R.CARDS[c].emoji; }).join('') || '無');
      }).join('　') + '</div></div>';
    return h;
  }

  // ---------- 植物研究者（交易） ----------
  function shopRow(label, ids, counts, owner, g) {
    const cost = C.upgradeCost;
    let h = '';
    ids.forEach(function (id) {
      const from = R.CARDS[id], to = R.CARDS[id + '+'];
      h += '<div class="shop-item">' + cardHtml(from, 'tabindex="-1"') + '<span class="arrow">➜</span>' + cardHtml(to, 'tabindex="-1"') +
        '<div class="shop-buy"><div class="muted tiny">' + esc(label) + ' 擁有 ×' + counts[id] + '</div>' +
        '<button class="btn small" data-act="upgrade" data-id="' + id + '"' + (owner ? ' data-player="' + owner + '"' : '') + (g.remains < cost ? ' disabled' : '') + '>升級（' + res('remains') + '×' + cost + '）</button></div></div>';
    });
    return h;
  }

  function shopPanel(g) {
    let h = '<div class="panel shop"><h3>🧑‍🔬 植物研究者</h3>' +
      '<p class="muted">「把打敗病毒後留下的植物殘骸給我，我可以幫你們強化牌卡。」每次升級 1 張，需要 ' + res('remains') + '×' + C.upgradeCost + '（目前 ' + g.remains + ' 個）。</p>';
    g.players.forEach(function (p) {
      const counts = R.deckCounts(p);
      const ids = Object.keys(counts).filter(function (id) { return R.UPGRADES[id]; });
      h += '<details class="shop-group"><summary>' + charArt(p.charId, 'tab-pic') + ' ' + esc(p.name) + ' 的牌組（可升級 ' + ids.length + ' 種）</summary><div class="shop-list">' +
        shopRow(p.name, ids, counts, p.id, g) + '</div></details>';
    });
    const owned = R.ownedCounts(g);
    const gids = ['water', 'soil', 'fertilizer'].filter(function (id) { return owned[id]; });
    h += '<details class="shop-group"><summary>🪴 花園照料牌（全隊共用）</summary><div class="shop-list">' + shopRow('花園', gids, owned, null, g) + '</div></details>';
    return h + '</div>';
  }

  function shopView(g) {
    return '<div class="scene event-scene">' + parallax('bg-reward') + '<div class="scene-body center">' + art('researcher', 'researcher-art', '植物研究者') + '<h2>和植物研究者交易</h2></div></div>' +
      shopPanel(g) + '<div class="error">' + esc(ui.error) + '</div>' +
      '<div class="actions"><button class="btn" data-act="leaveShop">道別，回到地圖 ➜</button></div>';
  }

  // ---------- 收穫、寶箱、事件 ----------
  function cardRewardView(g) {
    let h = '<div class="scene garden-scene">' + parallax('bg-reward') + '<div class="scene-body"><h2>🎁 戰後收穫</h2>' +
      '<p class="muted">每個人從 3 張地球植物牌中選 1 張加入自己的牌組，也可以跳過。全員選完回到地圖。</p>';
    g.players.forEach(function (p) {
      const done = g.reward.done[p.id];
      h += '<div class="reward-row' + (done ? ' done' : '') + '"><div class="reward-who">' + charArt(p.charId, 'reward-pic') + '<b>' + esc(p.name) + '</b>' +
        (done ? '<span class="muted">✔ 已選</span>' : '') + '</div><div class="hand">';
      if (!done) {
        g.reward.offers[p.id].forEach(function (id) {
          h += cardHtml(R.CARDS[id], 'data-act="takeCard" data-player="' + p.id + '" data-id="' + id + '"', 'reward-card');
        });
        h += '<button class="btn secondary small skip" data-act="takeCard" data-player="' + p.id + '" data-id="skip">跳過</button>';
      }
      h += '</div></div>';
    });
    return h + '<div class="error">' + esc(ui.error) + '</div></div></div>';
  }

  function chestView(g) {
    const pick = ui.reward ? R.REWARDS[ui.reward] : null;
    const taken = g.reward.taken;
    let h = '<div class="scene garden-scene chest-scene">' + parallax('bg-chest') + '<div class="scene-body">' + art('chest', 'chest-art', '寶箱') + '<h2>🎁 打開寶箱！</h2>' +
      '<p class="muted">隊伍討論後，還可以選 <b>' + g.reward.left + '</b> 項（不可重複）。選完回到地圖。</p><div class="hand reward">';
    (g.reward.options || Object.keys(R.REWARDS)).forEach(function (id) {
      const r = R.REWARDS[id];
      const card = '<button class="card chest-card' + (ui.reward === id ? ' sel' : '') + '" data-act="reward" data-id="' + id + '"' + (taken.indexOf(id) !== -1 ? ' disabled' : '') + '>' +
        '<div class="pic">' + art(CHEST_ICON[id], 'reward-icon', r.name) + '</div><div class="n">' + r.name + '</div><div class="d">' + esc(r.desc) + '</div></button>';
      // 「成長」是研究者提供的，把研究者 NPC 放在旁邊
      h += id === 'grow'
        ? '<div class="npc-offer"><div class="npc"><div class="npc-say">「讓我幫一株植物立刻長大吧！」</div>' + art('researcher', 'npc-art', '植物研究者') + '</div>' + card + '</div>'
        : card;
    });
    h += '</div>';
    if (pick && pick.needTarget) {
      h += '<div class="hint">「' + esc(pick.name) + '」要給誰？</div><div class="plots">';
      g.players.forEach(function (p) {
        const ok = ui.reward !== 'grow' || p.plant.stage < R.MAX_STAGE;
        h += '<button class="plot' + (ok ? ' targetable' : '') + '" data-act="rewardTarget" data-id="' + p.id + '"' + (ok ? '' : ' disabled') + '>' +
          '<div class="plot-pic">' + plantArt(p.plant, 'plot-plant') + charArt(p.charId, 'plot-owner') + '</div>' +
          '<div class="pname">' + esc(p.name) + '</div><div class="stage">' + R.STAGE_NAMES[p.plant.stage] + '</div></button>';
      });
      h += '</div>';
    }
    return h + '<div class="error">' + esc(ui.error) + '</div></div></div>';
  }

  function eventView(g) {
    const ev = R.EVENTS[g.event.id];
    let h = '<div class="scene event-scene">' + parallax() + '<div class="scene-body center"><div class="event-card">' +
      eventArt(g.event.id, ev.name) + '<h2>' + esc(ev.name) + '</h2><p>' + esc(ev.text) + '</p><div class="event-choices">';
    ev.choices.forEach(function (c, i) {
      h += '<button class="btn' + (i ? ' secondary' : '') + '" data-act="eventChoice" data-i="' + i + '"><b>' + esc(c.label) + '</b><br><small>' + esc(c.desc) + '</small></button>';
    });
    return h + '</div><div class="error">' + esc(ui.error) + '</div></div></div></div>';
  }

  // ---------- 升階選牌 ----------
  function pickView(g) {
    const pk = g.picks[0];
    const p = g.players.find(function (x) { return x.id === pk.playerId; });
    const sp = R.SPECIES[p.plant.species];
    let h = '<div class="overlay pick-overlay"><div class="dialog pick-dialog">' +
      '<div class="pick-head">' + plantArt({ species: p.plant.species, stage: pk.stage }, 'pick-plant') + charArt(p.charId, 'pick-char') + '</div>' +
      '<h2>' + esc(sp.name) + ' 長到「' + R.STAGE_NAMES[pk.stage] + '」了！</h2>' +
      '<p>' + esc(p.name) + '（' + esc(R.CHARACTERS[p.charId].name) + '），選一張牌加入你的牌組：</p><div class="hand pick-cards">';
    pk.options.forEach(function (id) { h += cardHtml(R.CARDS[id], 'data-act="pick" data-id="' + id + '"', 'pick-card'); });
    h += '</div>';
    if (pk.enhance) {
      const ids = R.enhanceable(p);
      if (ids.length) {
        h += '<p class="muted">或是強化一張已收集的專屬牌：</p><div class="hand pick-cards">';
        ids.forEach(function (id) { h += cardHtml(R.CARDS[id + '+'], 'data-act="pick" data-id="enhance:' + id + '"', 'pick-card'); });
        h += '</div>';
      }
    }
    return h + '<div class="row"><button class="btn secondary small" data-act="pick" data-id="skip">這次不拿</button></div>' +
      '<div class="error">' + esc(ui.error) + '</div></div></div>';
  }

  // ---------- 牌卡庫 ----------
  function libraryView() {
    const g = ui.screen === 'game' ? ui.game : null;
    let h = '<div class="overlay" data-act="closeLibrary"><div class="dialog library" data-stop="1"><h2>📖 牌卡庫</h2>';
    if (g) {
      h += '<h3>大家的牌組</h3>';
      g.players.forEach(function (p) {
        const counts = R.deckCounts(p);
        h += '<details class="deck-group"><summary>' + charArt(p.charId, 'tab-pic') + ' ' + esc(p.name) + '・' + esc(R.CHARACTERS[p.charId].name) + '（' + R.playerCards(p).length + ' 張）</summary><div class="hand lib-row">';
        Object.keys(counts).sort().forEach(function (id) {
          h += '<div class="lib-item">' + cardHtml(R.CARDS[id], 'tabindex="-1"') + '<div class="muted tiny">×' + counts[id] + '</div></div>';
        });
        h += '</div></details>';
      });
    }
    h += '<p class="muted">以下是所有卡牌。每人起始 10 張：荊棘擊 ×4、葉盾 ×3、暖陽 ×1、角色專屬起始牌 ×2。</p>';
    SET_ORDER.forEach(function (set) {
      const ids = Object.keys(R.CARDS).filter(function (id) { return R.CARDS[id].set === set.id && !R.CARDS[id].upgraded; });
      h += '<h3>' + esc(set.name) + '</h3><div class="hand lib-row">';
      ids.forEach(function (id) {
        let note = '';
        const gc = R.GROWTH_CARDS[set.id];
        if (gc) note = gc.start === id ? '起始 ×2' : gc.grow.indexOf(id) !== -1 ? '成長時二選一' : '成熟時二選一';
        h += '<div class="lib-item">' + cardHtml(R.CARDS[id], 'tabindex="-1"') + (note ? '<div class="muted tiny">' + note + '</div>' : '') +
          (R.CARDS[id + '+'] ? '<div class="muted tiny">＋：' + esc(R.CARDS[id + '+'].desc) + '</div>' : '') + '</div>';
      });
      h += '</div>';
    });
    h += '<h3>栽培室植物（種下地球種子後隨機長出）</h3><div class="hand lib-row">';
    Object.keys(R.POT_SPECIES).forEach(function (id) {
      h += '<div class="lib-item">' + cardHtml(potCard(id), 'tabindex="-1"') + '</div>';
    });
    return h + '</div><div class="row"><button class="btn" data-act="closeLibrary">關閉</button></div></div></div>';
  }

  // ---------- 結局 ----------
  /** 失敗畫面：打倒隊伍的病毒 + 倒下的角色（用 *-down 圖） */
  function loseArt(g) {
    // 病毒依等級決定大小；全隊（本局所有加入的角色）都用倒下圖
    const vid = g.battle && g.battle.virus ? g.battle.virus.id : 'bloom';
    const foe = virusArt(vid, 'lose-foe foe-tier-' + R.VIRUSES[vid].tier);
    return foe + g.players.map(function (p) {
      return '<div class="lose-down">' + charArt(p.charId, 'lose-char', true) + '<div class="muted">' + esc(p.name) + '</div></div>';
    }).join('');
  }
  function endingView(g) {
    if (!g.result.win) {
      // 失敗結局：倒下的角色和病毒直接放在「花園被細菌入侵」的畫面裡
      return '<div class="overlay lose-overlay" style="background-image:url(\'' + (window.GARDEN_ASSETS || 'assets/') + 'bg-lose.jpg\')">' +
        '<div class="dialog lose"><h2>冒險失敗</h2><p>' + esc(g.result.reason) + '</p>' +
        '<div class="row"><button class="btn" data-act="restart">再玩一次</button><button class="btn secondary" data-act="home">回首頁</button></div></div>' +
        '<div class="lose-ground">' + loseArt(g) + '</div></div>';
    }
    const garden = g.players.map(function (p) {
      return '<div class="end-plant">' + plantArt(p.plant, 'end-plant-art') + charArt(p.charId, 'end-char') + '</div>';
    }).join('') + g.pots.filter(Boolean).map(function (p) { return '<div class="end-plant">' + potArt(p, 'end-plant-art') + '</div>'; }).join('');
    return '<div class="ending">' +
      '<div class="end-sky" style="background-image:url(\'' + (window.GARDEN_ASSETS || 'assets/') + 'bg-ending.jpg\')"></div>' +
      '<div class="end-sun"><div class="rays"></div></div><div class="end-glow"></div><div class="end-garden">' + garden + '</div>' +
      '<div class="end-text"><h2>☀️ 陽光升起了！</h2><p>' + esc(g.result.reason) + '</p>' +
      '<div class="row"><button class="btn" data-act="restart">再玩一次</button><button class="btn secondary" data-act="home">回首頁</button></div></div></div>';
  }

  function gameView() {
    const g = ui.game;
    let h = hud(g);
    if (g.scene === 'map') h += mapView(g);
    else if (g.scene === 'garden') h += gardenView(g);
    else if (g.scene === 'battle') h += battleView(g);
    else if (g.scene === 'reward') h += g.reward.kind === 'cards' ? cardRewardView(g) : chestView(g);
    else if (g.scene === 'event') h += eventView(g);
    else if (g.scene === 'shop') h += shopView(g);
    h += logView(g);
    if (g.picks && g.picks.length) h += pickView(g);
    if (g.scene === 'over') h += endingView(g);
    return h;
  }

  // ---------- 行為 ----------
  function act(action) {
    const res = R.applyAction(ui.game, action);
    if (!res.ok) { ui.error = res.error; return false; }
    ui.game = res.state;
    ui.selected = null;
    ui.error = '';
    return true;
  }

  function startGame() {
    const s = ui.setup, players = [];
    for (let i = 0; i < s.count; i++) players.push({ name: '玩家' + (i + 1), charId: s.chars[i] });
    ui.game = R.createGame(players);
    ui.selected = null; ui.viewer = 0; ui.error = ''; ui.reward = null; ui.library = false;
    ui.screen = 'game';
  }

  function useOn(el) {
    const g = ui.game;
    if (ui.selected === null || !el) return;
    if (el.dataset.act === 'playzone') act({ type: 'play', cardIndex: ui.selected });
    else act({ type: 'play', playerId: g.scene === 'garden' ? g.players[ui.viewer].id : undefined, cardIndex: ui.selected, target: el.dataset.id });
  }

  let suppressClick = false;
  root.addEventListener('click', function (e) {
    if (suppressClick) { suppressClick = false; return; }
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const a = el.dataset.act;
    if (a === 'closeLibrary' && e.target.closest('[data-stop]') && !e.target.closest('button[data-act=closeLibrary]')) return;
    if (a === 'local') ui.screen = 'setup';
    else if (a === 'home') { ui.screen = 'home'; ui.library = false; }
    else if (a === 'library') ui.library = true;
    else if (a === 'music') music.toggle();
    else if (a === 'closeLibrary') ui.library = false;
    else if (a === 'count') ui.setup.count = Number(el.dataset.n);
    else if (a === 'char') {
      const i = Number(el.dataset.i), id = el.dataset.id, cs = ui.setup.chars, j = cs.indexOf(id);
      if (j !== -1 && j !== i) cs[j] = cs[i];
      cs[i] = id;
    } else if (a === 'start' || a === 'restart') startGame();
    else if (a === 'pick') act({ type: 'pick', choice: el.dataset.id });
    else if (a === 'viewer') { ui.viewer = Number(el.dataset.i); ui.selected = null; ui.error = ''; }
    else if (a === 'card') { ui.selected = ui.selected === Number(el.dataset.i) ? null : Number(el.dataset.i); ui.error = ''; }
    else if (a === 'target' || (a === 'playzone' && el.classList.contains('targetable'))) useOn(el);
    else if (a === 'play' && ui.selected !== null) act({ type: 'play', cardIndex: ui.selected });
    else if (a === 'endturn') act({ type: 'endTurn' });
    else if (a === 'purify') act({ type: 'purify' });
    else if (a === 'advance') { act({ type: 'advance' }); ui.viewer = 0; }
    else if (a === 'move') { act({ type: 'move', node: el.dataset.id }); ui.viewer = 0; }
    else if (a === 'sow') act({ type: 'sow', pot: Number(el.dataset.i) });
    else if (a === 'eventChoice') act({ type: 'event', choice: Number(el.dataset.i) });
    else if (a === 'upgrade') act({ type: 'upgrade', card: el.dataset.id, playerId: el.dataset.player });
    else if (a === 'leaveShop') act({ type: 'leaveShop' });
    else if (a === 'takeCard') act({ type: 'reward', playerId: el.dataset.player, choice: el.dataset.id });
    else if (a === 'reward') {
      const id = el.dataset.id;
      ui.error = '';
      if (R.REWARDS[id].needTarget) ui.reward = ui.reward === id ? null : id;
      else if (act({ type: 'reward', choice: id })) ui.reward = null;
    } else if (a === 'rewardTarget' && ui.reward) {
      if (act({ type: 'reward', choice: ui.reward, target: el.dataset.id })) ui.reward = null;
    } else return;
    render();
  });

  // ---------- 拖拉出牌 ----------
  let drag = null;
  root.addEventListener('pointerdown', function (e) {
    const card = e.target.closest('.card[data-act=card]');
    if (!card || card.disabled || e.button > 0) return;
    drag = { i: Number(card.dataset.i), x0: e.clientX, y0: e.clientY, ghost: null, src: card, hover: null };
  });

  window.addEventListener('pointermove', function (e) {
    if (!drag) return;
    if (!drag.ghost) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 8) return;
      const rect = drag.src.getBoundingClientRect();
      ui.selected = drag.i;
      ui.error = '';
      render();
      const ghost = drag.src.cloneNode(true);
      ghost.classList.add('drag-ghost');
      ghost.style.width = rect.width + 'px';
      document.body.appendChild(ghost);
      document.body.classList.add('dragging');
      drag.ghost = ghost;
      drag.dx = e.clientX - rect.left;
      drag.dy = e.clientY - rect.top;
    }
    drag.ghost.style.left = (e.clientX - drag.dx) + 'px';
    drag.ghost.style.top = (e.clientY - drag.dy) + 'px';
    const over = document.elementFromPoint(e.clientX, e.clientY);
    const t = over && over.closest('.targetable');
    if (drag.hover && drag.hover !== t) drag.hover.classList.remove('drop-hover');
    if (t) t.classList.add('drop-hover');
    drag.hover = t;
    e.preventDefault();
  });

  window.addEventListener('pointerup', function (e) {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.ghost) return;
    d.ghost.remove();
    document.body.classList.remove('dragging');
    suppressClick = true;
    setTimeout(function () { suppressClick = false; }, 0);
    const over = document.elementFromPoint(e.clientX, e.clientY);
    const t = over && over.closest('.targetable');
    if (t) useOn(t);
    else ui.selected = null;
    render();
  });

  window.addEventListener('pointercancel', function () {
    if (drag && drag.ghost) { drag.ghost.remove(); document.body.classList.remove('dragging'); }
    drag = null;
    render();
  });

  // ---------- 背景音樂 ----------
  // 瀏覽器不允許有聲音的自動播放，所以玩家第一次點擊後才開始播。開關狀態存在 localStorage。
  const MUSIC_FILES = {
    calm: 'Music for General Occasions.mp3', // 首頁、地圖、栽培室、收穫、事件
    battle: 'Conflict.mp3', // 戰鬥
    win: 'Peaceful Ending.mp3', // 成功結局
    lose: 'Non-Peaceful Ending.mp3' // 失敗
  };
  const music = {
    audio: null, track: null, unlocked: false,
    on: (function () { try { return localStorage.getItem('garden-music') !== 'off'; } catch (e) { return true; } })(),
    trackFor: function () {
      const g = ui.game;
      if (ui.screen !== 'game' || !g) return 'calm';
      if (g.scene === 'battle') return 'battle';
      if (g.scene === 'over') return g.result && g.result.win ? 'win' : 'lose';
      return 'calm';
    },
    update: function () {
      if (!this.unlocked) return;
      if (!this.audio) { this.audio = new Audio(); this.audio.volume = 0.45; }
      const t = this.trackFor();
      if (t !== this.track) {
        this.track = t;
        this.audio.src = (window.GARDEN_MUSIC || 'music/') + encodeURIComponent(MUSIC_FILES[t]);
        this.audio.loop = t === 'calm' || t === 'battle'; // 結局曲只播一次
      }
      if (this.on) { const p = this.audio.play(); if (p && p.catch) p.catch(function () {}); }
      else this.audio.pause();
    },
    unlock: function () { if (!this.unlocked) { this.unlocked = true; this.update(); } },
    toggle: function () {
      this.on = !this.on;
      try { localStorage.setItem('garden-music', this.on ? 'on' : 'off'); } catch (e) { /* 無法儲存就只在這次有效 */ }
      this.unlocked = true;
      this.update();
    }
  };
  function musicButton() {
    return '<button class="btn secondary small" data-act="music" title="背景音樂">' + (music.on ? '🔊 音樂' : '🔇 音樂') + '</button>';
  }
  root.addEventListener('pointerdown', function () { music.unlock(); }, true);
  root.addEventListener('keydown', function () { music.unlock(); }, true);

  function render() {
    let h = ui.screen === 'home' ? homeView() : ui.screen === 'setup' ? setupView() : gameView();
    if (ui.library) h += libraryView();
    root.innerHTML = h;
    const sc = root.querySelector('.map-scroll');
    const party = sc && sc.querySelector('.party');
    if (party) sc.scrollLeft = Math.max(0, party.offsetLeft - sc.clientWidth / 3);
    music.update(); // 依目前場景切換曲目
  }

  window.GardenUI = { ui: ui, render: render, music: music };
  render();
})();
