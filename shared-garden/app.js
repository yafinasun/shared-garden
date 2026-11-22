/* 共享花園 - 介面層（單機輪流操作版）。規則全部在 rules.js。 */
(function () {
  'use strict';
  const R = window.GardenRules;
  const C = R.CONFIG;
  const root = document.getElementById('app');

  const ui = {
    screen: 'home',
    setup: { count: 2, chars: ['straw', 'shiba', 'alien', 'elf'] },
    game: null,
    selected: null, // 手牌 index
    error: ''
  };

  const CHAR_IDS = Object.keys(R.CHARACTERS);

  function esc(t) {
    return String(t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------- 畫面 ----------
  function homeView() {
    return '<div class="home center">' +
      '<div class="big">🌻🐢🍅🏮</div>' +
      '<h1>共享花園</h1>' +
      '<p class="muted">一起照料花園，守護植物，抵擋病毒。</p>' +
      '<div class="row">' +
      '<button class="btn" data-act="local">開始本機試玩</button>' +
      '<button class="btn secondary" disabled title="多人連線階段才會開放">建立房間（即將推出）</button>' +
      '<button class="btn secondary" disabled title="多人連線階段才會開放">加入房間（即將推出）</button>' +
      '</div>' +
      '<p class="muted">原型階段：同一台裝置輪流操作，請圍在一起討論。</p>' +
      '</div>';
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
        const ch = R.CHARACTERS[id];
        const sp = R.SPECIES[ch.plant];
        h += '<button class="char" data-act="char" data-i="' + i + '" data-id="' + id + '" aria-pressed="' + (s.chars[i] === id) + '">' +
          '<span class="e">' + ch.emoji + sp.emoji + '</span> ' + esc(ch.name) +
          '<small>' + esc(sp.name) + '・' + esc(ch.role) + '</small></button>';
      });
      h += '</div></div>';
    }
    h += '<div class="row"><button class="btn secondary" data-act="home">返回</button>' +
      '<button class="btn" data-act="start">開始遊戲</button></div>';
    return h;
  }

  function plantHtml(p, targetable) {
    const sp = R.SPECIES[p.species];
    const emoji = p.stage === 0 ? '🌱' : p.stage === 1 ? '🌿' : sp.emoji;
    const owner = ownerLabel(p);
    const need = R.needFor(p);
    let pips = '';
    if (need === null) pips = '<span class="muted">✨ 成熟</span>';
    else for (let i = 0; i < need; i++) pips += '<span class="pip' + (i < p.care ? ' on' : '') + '"></span>';
    return '<button class="plant' + (p.infected ? ' infected' : '') + (targetable ? ' targetable' : '') + '" data-act="plant" data-id="' + p.id + '"' +
      (targetable ? '' : ' disabled') + ' title="' + esc(sp.ability) + '">' +
      '<span class="badges">' + (p.infected ? '🦠' : '') + (p.shield ? '🛡️' : '') + '</span>' +
      '<div class="emoji">' + emoji + '</div>' +
      '<div class="pname">' + esc(sp.name) + '</div>' +
      '<div class="owner">' + esc(owner) + '</div>' +
      '<div class="stage">' + R.STAGE_NAMES[p.stage] + '</div>' +
      '<div class="pips">' + pips + '</div></button>';
  }

  function ownerLabel(p) {
    if (!p.owner) return '共有';
    const pl = ui.game.players.find(function (x) { return x.id === p.owner; });
    return pl ? pl.name + '的植物' : '';
  }

  function bar(value, max, cls) {
    return '<div class="bar ' + cls + '"><i style="width:' + Math.min(100, (value / max) * 100) + '%"></i></div>';
  }

  function gameView() {
    const g = ui.game;
    const cur = g.players[g.turnIdx];
    const card = ui.selected !== null ? R.CARDS[cur.hand[ui.selected]] : null;
    const targets = card ? R.validTargets(g, card.id) : null;
    const over = g.phase === 'over';
    const mature = R.matureCount(g);

    let h = '<div class="panel status">' +
      '<div class="stat">回合<b>' + Math.min(g.round, C.maxRounds) + ' / ' + C.maxRounds + '</b></div>' +
      '<div class="stat">成熟植物<b>' + mature + ' / ' + R.winTarget(g) + '</b>' + bar(mature, R.winTarget(g), 'ok') + '</div>' +
      '<div class="stat">病毒威脅<b>' + g.threat + ' / ' + C.threatLimit + '</b>' + bar(g.threat, C.threatLimit, 'danger') + '</div>' +
      '<div class="stat">病毒預告<b>🦠 本回合將攻擊 ' + R.attackCount(g) + ' 株</b>' +
      (g.buffs.bonusCare ? '<span class="muted">☀️ 暖陽：照料 +' + g.buffs.bonusCare + '</span>' : '') + '</div>' +
      '</div>';

    h += '<div class="panel"><h3>共享花園（' + g.plants.length + '/' + C.maxSlots + '）</h3><div class="garden">';
    g.plants.forEach(function (p) { h += plantHtml(p, !over && targets !== null && targets.indexOf(p.id) !== -1); });
    for (let i = g.plants.length; i < C.maxSlots; i++) h += '<div class="empty-slot">空位</div>';
    h += '</div></div>';

    h += '<div class="panel"><div class="players">';
    g.players.forEach(function (p, i) {
      const ch = R.CHARACTERS[p.charId];
      const sp = R.SPECIES[ch.plant];
      h += '<div class="pl' + (i === g.turnIdx ? ' active' : '') + '"><div class="nm">' + ch.emoji + ' ' + esc(p.name) + '・' + esc(ch.name) + (i === g.turnIdx ? '（行動中）' : '') + '</div>' +
        '<div class="muted">' + sp.emoji + ' ' + esc(sp.ability) + '</div><div>';
      if (i !== g.turnIdx) p.hand.forEach(function (cid) { h += '<span class="mini">' + R.CARDS[cid].emoji + R.CARDS[cid].name + '</span>'; });
      else h += '<span class="muted">手牌 ' + p.hand.length + ' 張（見下方）</span>';
      h += '</div></div>';
    });
    h += '</div></div>';

    h += '<div class="panel"><div class="hint">' + esc(turnHint(cur, card, targets)) + '</div><div class="hand">';
    cur.hand.forEach(function (cid, i) {
      const c = R.CARDS[cid];
      h += '<button class="card' + (i === ui.selected ? ' sel' : '') + '" data-act="card" data-i="' + i + '"' + (over ? ' disabled' : '') + '>' +
        '<div class="e">' + c.emoji + '</div><div class="n">' + c.name + '</div><div class="k">' + c.kind + '</div><div class="d">' + esc(c.desc) + '</div></button>';
    });
    if (!cur.hand.length) h += '<span class="muted">沒有手牌</span>';
    h += '</div><div class="actions">' +
      '<button class="btn" data-act="play"' + (card && !card.target && !over ? '' : ' disabled') + '>出牌</button>' +
      '<button class="btn secondary" data-act="discard"' + (card && !over ? '' : ' disabled') + '>棄牌換牌（本回合行動）</button>' +
      '<button class="btn secondary" data-act="restart">重新開始</button>' +
      '</div><div class="error">' + esc(ui.error) + '</div></div>';

    h += '<div class="panel"><h3>紀錄</h3><div class="log" id="log">';
    g.log.slice().reverse().slice(0, 40).forEach(function (l) { h += '<div>[' + l.round + '] ' + esc(l.text) + '</div>'; });
    h += '</div></div>';

    if (over) {
      h += '<div class="overlay"><div class="dialog ' + (g.result.win ? 'win' : 'lose') + '">' +
        '<div class="big">' + (g.result.win ? '🌻🎉' : '🥀') + '</div>' +
        '<h2>' + (g.result.win ? '花園守住了！' : '花園淪陷了') + '</h2>' +
        '<p>' + esc(g.result.reason) + '</p>' +
        '<p class="muted">共進行 ' + Math.min(g.round, C.maxRounds) + ' 回合・成熟 ' + mature + ' 株・威脅 ' + g.threat + '</p>' +
        '<div class="row"><button class="btn" data-act="restart">再玩一次</button><button class="btn secondary" data-act="home">回首頁</button></div>' +
        '</div></div>';
    }
    return h;
  }

  function turnHint(cur, card, targets) {
    const name = cur.name + '（' + R.CHARACTERS[cur.charId].name + '）';
    if (!card) return '輪到 ' + name + '：選一張牌，或棄牌換牌。';
    if (targets === null) return '已選「' + card.name + '」，按「出牌」。';
    if (!targets.length) return '「' + card.name + '」目前沒有可用目標，可換選別張牌或棄牌。';
    return '已選「' + card.name + '」，請點選花園中發亮的植物。';
  }

  // ---------- 行為 ----------
  function act(action) {
    const res = R.applyAction(ui.game, action);
    if (!res.ok) { ui.error = res.error; return; }
    ui.game = res.state;
    ui.selected = null;
    ui.error = '';
  }

  function startGame() {
    const s = ui.setup;
    const players = [];
    for (let i = 0; i < s.count; i++) players.push({ name: '玩家' + (i + 1), charId: s.chars[i] });
    ui.game = R.createGame(players);
    ui.selected = null;
    ui.error = '';
    ui.screen = 'game';
  }

  root.addEventListener('click', function (e) {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const a = el.dataset.act;
    const g = ui.game;
    if (a === 'local') ui.screen = 'setup';
    else if (a === 'home') ui.screen = 'home';
    else if (a === 'count') ui.setup.count = Number(el.dataset.n);
    else if (a === 'char') {
      const i = Number(el.dataset.i), id = el.dataset.id, cs = ui.setup.chars;
      const j = cs.indexOf(id);
      if (j !== -1 && j !== i) { cs[j] = cs[i]; } // 已被選走則互換
      cs[i] = id;
    } else if (a === 'start' || a === 'restart') startGame();
    else if (a === 'card') { ui.selected = ui.selected === Number(el.dataset.i) ? null : Number(el.dataset.i); ui.error = ''; }
    else if (a === 'plant' && ui.selected !== null) act({ type: 'play', cardIndex: ui.selected, target: Number(el.dataset.id) });
    else if (a === 'play' && ui.selected !== null) act({ type: 'play', cardIndex: ui.selected });
    else if (a === 'discard' && ui.selected !== null) act({ type: 'discard', cardIndex: ui.selected });
    render();
  });

  function render() {
    root.innerHTML = ui.screen === 'home' ? homeView() : ui.screen === 'setup' ? setupView() : gameView();
  }

  render();
})();
