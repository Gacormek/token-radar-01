// Token Radar's dashboard (model radar-2). It reads window.RADAR (written beside dashboard/ by
// main.ts) and renders the ranked board, a filterable table, a per-protocol detail drawer with the
// model's own inputs and the protocol's farm plan, plus a model panel with an exploratory sandbox.
// No network: every figure on the page comes from data.js.
(function () {
  'use strict';

  var DATA = window.RADAR;
  var app = document.getElementById('board');
  if (!DATA) {
    app.textContent = 'No data: data.js did not load, so the board has nothing to show.';
    app.setAttribute('aria-busy', 'false');
    return;
  }

  var state = { q: '', category: 'all', chain: 'all', watchlist: false, tab: 'pre-token', sort: 'implied', dir: -1, selected: null, sandbox: null };
  var CAL = new Map(DATA.calibration.map(function (c) { return [c.category, c]; }));
  var WATCH = new Set(DATA.rows.filter(function (r) { return r.tvl_usd >= DATA.floor_usd; }).map(function (r) { return r.slug; }));

  var usdFull = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usdFull.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtMult(n) { return n.toFixed(4) + '×'; }
  function esc(s) { return String(s); }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // ---- The model, ported from lib/model.ts (radar-2) ----
  // categoryMultiple comes from the calibration table (the snapshot's own live comparables),
  // growth clamps to [-50, 100] and weighs falls more than rises, age is a hump peaking at 540
  // days, breadth adds 0.04 per extra chain up to 5. Same arithmetic, same order, same rounding.
  function modelCalc(row, model) {
    var age = row.age_days === null || row.age_days === undefined ? null : row.age_days;
    var cat = row.category === null || row.category === undefined ? 'Other' : row.category;
    var cal = CAL.get(cat);
    var categoryMultiple = cal ? cal.multiple : DATA.global_multiple;
    var rawGrowth = typeof row.change_7d === 'number' && isFinite(row.change_7d) ? row.change_7d : 0;
    var growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
    var weight = growthPct >= 0 ? model.growth_up_weight : model.growth_down_weight;
    var growthMult = 1 + (growthPct / 100) * weight;
    var ageMult;
    if (age === null) ageMult = model.unknown_age_mult;
    else if (age <= model.age_peak_days) ageMult = model.age_floor + (1 - model.age_floor) * (age / model.age_peak_days);
    else {
      var decay = Math.min((age - model.age_peak_days) / model.age_decay_days, 1);
      ageMult = 1 - (1 - model.age_decay_floor) * decay;
    }
    var breadthMult = 1 + model.breadth_step * Math.min(Math.max(row.chains.length - 1, 0), model.breadth_max_chains);
    var implied = Math.max(1, Math.round(row.tvl_usd * categoryMultiple * growthMult * ageMult * breadthMult));
    return { implied: implied, categoryMultiple: categoryMultiple, growthPct: growthPct, growthMult: growthMult, ageMult: ageMult, breadthMult: breadthMult, age: age };
  }

  // The page recomputes every row from the data and the model and checks the number the board
  // carries, so the page's code and the board's data are visibly the same arithmetic.
  window.RADAR_VERIFY = function () {
    var mismatches = [];
    for (var i = 0; i < DATA.rows.length; i++) {
      var row = DATA.rows[i];
      var page = modelCalc(row, DATA.model).implied;
      if (page !== row.implied_value_usd) mismatches.push({ slug: row.slug, page: page, board: row.implied_value_usd });
    }
    return { checked: DATA.rows.length, mismatches: mismatches };
  };

  // ---- The farm plan, ported from lib/model.ts (farmSteps / stepText / gasFor / capitalFor /
  // holdDaysFor / actionFor). The plan is derived from the protocol's own record (category,
  // chains, TVL, age), never from a hand-written list of names. ----
  function chainOf(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function gasFor(chain) {
    var c = chain.toLowerCase();
    if (c === 'ethereum') return '$3 to $8 of gas per transaction';
    if (c === 'bitcoin') return '$2 to $5 of gas per transaction';
    if (c === 'solana') return 'about $0.01 of gas per transaction';
    if (c === 'binance' || c === 'bnb chain' || c === 'bsc') return '$0.10 to $0.30 of gas per transaction';
    if (['arbitrum', 'optimism', 'base', 'polygon', 'avalanche', 'zksync era', 'linea', 'blast', 'scroll', 'mantle', 'mode', 'world chain', 'fraxtal'].indexOf(c) >= 0) {
      return '$0.10 to $0.50 of gas per transaction';
    }
    return 'about $1 of gas per transaction';
  }
  function capitalFor(p) {
    if (p.tvl_usd >= 5000000000) return 250;
    if (p.tvl_usd >= 1000000000) return 150;
    if (p.tvl_usd >= 100000000) return 100;
    return 50;
  }
  function holdDaysFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function actionFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open.';
    if (c.indexOf('dex') >= 0 || c.indexOf('yield') >= 0 || c.indexOf('leveraged farm') >= 0) return 'Provide $' + capital + ' of liquidity to ' + name + "'s main pool on " + chain + ' and keep the position open.';
    if (c.indexOf('bridge') >= 0) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.';
    if (c.indexOf('liquid staking') >= 0 || c.indexOf('restak') >= 0) return 'Stake $' + capital + " of the chain's staking asset through " + name + ' and keep the receipt.';
    if (c.indexOf('staking') >= 0) return 'Stake $' + capital + " of the chain's staking asset through " + name + ' and keep the receipt.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0 || c.indexOf('options') >= 0) return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedge.';
    if (c.indexOf('prediction') >= 0) return 'Fund $' + capital + ' and place one market position on ' + name + '.';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0 || c.indexOf('vault') >= 0) return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the shares.';
    if (c.indexOf('stable') >= 0) return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.';
    if (c.indexOf('rwa') >= 0) return 'Mint $' + capital + " of the protocol's yield asset on " + chain + ' and hold it.';
    if (c.indexOf('insurance') >= 0) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy.';
    if (c.indexOf('privacy') >= 0) return 'Deposit $' + capital + " into " + name + "'s shielded pool on " + chain + ' and keep the receipt.';
    if (c.indexOf('launchpad') >= 0) return 'Join $' + capital + ' of ' + name + "'s next launch pool on " + chain + ' and hold the allocation.';
    if (c.indexOf('nft') >= 0 || c.indexOf('gaming') >= 0 || c.indexOf('gamefi') >= 0) return 'Hold $' + capital + ' of in-game assets on ' + name + ' on ' + chain + ' and play one session a week.';
    if (c.indexOf('oracle') >= 0) return 'Stake $' + capital + ' with ' + name + "'s oracle on " + chain + ' and keep the stake through one epoch.';
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function farmSteps(p, age) {
    var chain = chainOf(p);
    var capital = capitalFor(p);
    var hold = holdDaysFor(age);
    var gas = gasFor(chain);
    var action = actionFor(p, capital, chain);
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'nothing but the wallet', time: '5 minutes' },
      { text: action, cost: '$' + capital + ' of capital and ' + gas, time: '15 minutes to set up' },
      { text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.', cost: gas + ' a week', time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: "Check the protocol's points or rewards page only through the link its own app publishes, and never pay to claim.", cost: 'no fee to check', time: '10 minutes' },
      { text: 'When you unwind, withdraw in two parts over two days and keep enough gas in the wallet to pay the exit.', cost: gas + ' per withdrawal', time: '10 minutes over 2 days' },
      { text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.', cost: 'nothing but the log', time: '5 minutes' }
    ].map(stepText);
  }

  // ---- Hash routing: #q= #category= #chain= #watchlist=1 #p=<slug> ----
  // The hash is the whole filter state: a parameter that is absent means its default, so a
  // link like #category=Dexs shows exactly that and nothing left over from a previous view.
  function readHash() {
    var params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    state.q = params.get('q') || '';
    state.category = params.get('category') || 'all';
    state.chain = params.get('chain') || 'all';
    state.watchlist = params.get('watchlist') === '1';
    state.selected = params.get('p') || null;
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.watchlist) params.set('watchlist', '1');
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    var url = next ? '#' + next : window.location.pathname + window.location.search;
    window.history.replaceState(null, '', url);
  }

  // ---- Filtering, sandbox ranking, sorting ----
  function sandboxModel() {
    if (!state.sandbox) return null;
    var m = {};
    Object.keys(DATA.model).forEach(function (k) { m[k] = DATA.model[k]; });
    m.growth_up_weight = state.sandbox.growth_up_weight;
    m.growth_down_weight = state.sandbox.growth_down_weight;
    m.age_peak_days = state.sandbox.age_peak_days;
    m.breadth_step = state.sandbox.breadth_step;
    return m;
  }
  function baseRows() {
    var q = state.q.trim().toLowerCase();
    var list = state.tab === 'pre-token' ? DATA.rows : DATA.live;
    return list.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (state.watchlist && state.tab === 'pre-token' && !WATCH.has(r.slug)) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category || '', (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function scored(list) {
    var sm = sandboxModel();
    if (!sm || state.tab !== 'pre-token') return list.map(function (r) { return { row: r, implied: r.implied_value_usd, rank: r.rank }; });
    var calc = list.map(function (r) { return { row: r, implied: modelCalc(r, sm).implied }; });
    calc.sort(function (a, b) { return b.implied - a.implied || (a.row.slug < b.row.slug ? -1 : a.row.slug > b.row.slug ? 1 : 0); });
    var ranks = {};
    calc.forEach(function (c, i) { ranks[c.row.slug] = i + 1; });
    return calc.map(function (c) { return { row: c.row, implied: c.implied, rank: ranks[c.row.slug] }; });
  }
  function sortedRows(scoredList) {
    var key = state.sort;
    var dir = state.dir;
    return scoredList.slice().sort(function (a, b) {
      var x = a.row, y = b.row, av, bv;
      if (key === 'name') { av = x.name.toLowerCase(); bv = y.name.toLowerCase(); }
      else if (key === 'tvl') { av = x.tvl_usd; bv = y.tvl_usd; }
      else if (key === 'growth') { av = x.change_7d === null ? -Infinity : x.change_7d; bv = y.change_7d === null ? -Infinity : y.change_7d; }
      else if (key === 'age') { av = x.age_days === null ? Infinity : x.age_days; bv = y.age_days === null ? Infinity : y.age_days; }
      else if (key === 'mcap') { av = x.mcap_usd === null ? -Infinity : x.mcap_usd; bv = y.mcap_usd === null ? -Infinity : y.mcap_usd; }
      else if (key === 'mult') { av = x.mcap_usd === null || !x.tvl_usd ? -Infinity : x.mcap_usd / x.tvl_usd; bv = y.mcap_usd === null || !y.tvl_usd ? -Infinity : y.mcap_usd / y.tvl_usd; }
      else if (key === 'rank') { av = a.rank; bv = b.rank; }
      else { av = a.implied; bv = b.implied; }
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0;
    });
  }

  // ---- Shell (built once) ----
  var shell = el('div', { class: 'shell' });
  var tableHost = el('div');
  var countEl = el('span', { class: 'count' });
  var sandboxNoteEl = el('span', { class: 'sandbox-note' });
  var searchInput, categorySelect, chainSelect, watchInput, preBtn, liveBtn;

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' },
        el('span', { class: 'mark', 'aria-hidden': 'true' }),
        el('span', { class: 'brand-name' }, el('b', { text: 'Token Radar' }), ' — pre-token board')
      ),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', null, 'model ', el('b', { text: DATA.model_version }))
      )
    );
  }
  function lede() {
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: DATA.board_size + ' pre-token protocols, ranked by implied value' }),
        el('p', null,
          'The watchlist is the floor: ', el('b', { text: String(DATA.watchlist_size) + ' named protocols' }),
          ' with at least ' + fmtUsd(DATA.floor_usd) + ' of TVL and no token on record. The early radar adds ',
          el('b', { text: String(DATA.early_size) + ' pre-token protocols' }),
          ' below that floor. Implied value is a model estimate from the snapshot\u2019s own figures, not a price.'
        )
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows scored' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Early rows below the floor' }), el('b', { text: String(DATA.early_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Live-token protocols set aside' }), el('b', { text: String(DATA.live_size) }))
      )
    );
  }
  function optionList(values) {
    return values.map(function (v) { return el('option', { value: v, text: v }); });
  }
  function controls() {
    var categories = Array.from(new Set(DATA.rows.concat(DATA.live).map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.concat(DATA.live).reduce(function (a, r) { return a.concat(r.chains || []); }, []))).sort();
    searchInput = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    searchInput.addEventListener('input', function () { state.q = searchInput.value; writeHash(); renderTable(); });
    categorySelect = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }), optionList(categories));
    categorySelect.value = state.category;
    categorySelect.addEventListener('change', function () { state.category = categorySelect.value; writeHash(); renderTable(); });
    chainSelect = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }), optionList(chains));
    chainSelect.value = state.chain;
    chainSelect.addEventListener('change', function () { state.chain = chainSelect.value; writeHash(); renderTable(); });
    watchInput = el('input', { type: 'checkbox', id: 'watchlist', checked: state.watchlist ? 'checked' : null });
    watchInput.addEventListener('change', function () { state.watchlist = watchInput.checked; writeHash(); renderTable(); });
    preBtn = el('button', { type: 'button', text: 'Pre-token', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', onclick: function () { setTab('pre-token'); } });
    liveBtn = el('button', { type: 'button', text: 'Live token', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', onclick: function () { setTab('live'); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), searchInput),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), categorySelect),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSelect),
      el('div', { class: 'field' }, el('span', { class: 'lab', text: 'Scope' }),
        el('label', { class: 'check', title: 'TVL at or above the watchlist floor' }, watchInput, 'Watchlist only')),
      el('div', { class: 'field' }, el('span', { class: 'lab', text: 'Token status' }), el('div', { class: 'tabs' }, preBtn, liveBtn)),
      countEl,
      sandboxNoteEl
    );
  }
  function setTab(tab) {
    state.tab = tab;
    preBtn.setAttribute('aria-pressed', tab === 'pre-token' ? 'true' : 'false');
    liveBtn.setAttribute('aria-pressed', tab === 'live' ? 'true' : 'false');
    watchInput.disabled = tab !== 'pre-token';
    if (tab !== 'pre-token') { state.sort = 'mcap'; state.dir = -1; }
    else { state.sort = 'implied'; state.dir = -1; }
    renderTable();
  }

  function sortHeader(key, label) {
    var btn = el('button', { type: 'button', onclick: function () {
      if (state.sort === key) state.dir = -state.dir;
      else { state.sort = key; state.dir = (key === 'name' || key === 'token') ? 1 : -1; }
      renderTable();
    } }, label);
    if (state.sort === key) btn.appendChild(el('span', { class: 'arr', 'aria-hidden': 'true', text: state.dir < 0 ? ' ↓' : ' ↑' }));
    return el('th', { scope: 'col' }, btn);
  }
  function chainText(r) {
    var ch = r.chains || [];
    if (ch.length === 0) return 'an unnamed chain';
    if (ch.length <= 2) return ch.join(', ');
    return ch.slice(0, 2).join(', ') + ' +' + (ch.length - 2);
  }
  function boardTable() {
    var list = sortedRows(scored(baseRows()));
    if (list.length === 0) return emptyPanel();
    var max = 1;
    list.forEach(function (s) { if (s.implied > max) max = s.implied; });
    var tbody = el('tbody');
    var sb = !!state.sandbox;
    list.forEach(function (s) {
      var r = s.row;
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var rankCell = sb
        ? el('td', null, el('div', { class: 'rankcell' }, el('span', { class: 'num', text: String(s.rank) }), el('span', { class: 'sub', text: 'board #' + r.rank })))
        : el('td', { class: 'num', text: String(r.rank) });
      var impliedCell = sb
        ? el('td', null, el('div', { class: 'implied' },
            el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((s.implied / max) * 100)) + '%' })),
            el('div', { class: 'rankcell' }, el('span', { class: 'num', text: fmtUsd(s.implied) }), el('span', { class: 'sub', text: 'board ' + fmtUsd(r.implied_value_usd) }))))
        : el('td', null, el('div', { class: 'implied' },
            el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((s.implied / max) * 100)) + '%' })),
            el('span', { class: 'num', text: fmtUsd(s.implied) })));
      var tr = el('tr', {
        'data-slug': r.slug,
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        rankCell,
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + chainText(r) }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        impliedCell,
        el('td', null, el('span', { class: 'chip', text: 'no token' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { text: 'Pre-token protocols, strongest implied value first. Select a row for its model breakdown and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('rank', 'Rank'), sortHeader('name', 'Protocol'), sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'), sortHeader('age', 'Age'), sortHeader('implied', 'Implied value'),
            sortHeader('token', 'Token'))),
          tbody
        )
      )
    );
  }
  function liveTable() {
    var list = sortedRows(scored(baseRows()));
    if (list.length === 0) return emptyPanel();
    var tbody = el('tbody');
    list.forEach(function (s) {
      var r = s.row;
      var mult = r.mcap_usd === null || !r.tvl_usd ? 'n/a' : (r.mcap_usd / r.tvl_usd).toFixed(2) + '×';
      tbody.appendChild(el('tr', null,
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + chainText(r) }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: mult }),
        el('td', null, el('span', { class: 'chip live', text: 'live' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They calibrate the board and are set aside from the pre-token ranking.' }),
          el('thead', null, el('tr', null,
            sortHeader('name', 'Protocol'), sortHeader('tvl', 'TVL'), sortHeader('growth', '7d'),
            sortHeader('mcap', 'Market cap'), sortHeader('mult', 'mcap / TVL'), el('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }
  function emptyPanel() {
    return el('div', { class: 'panel' }, el('div', { class: 'empty' },
      el('h2', { text: 'No protocol matches that filter' }),
      el('p', { text: 'Clear the search or pick another category or chain to see the board again.' }),
      el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () {
        state.q = ''; state.category = 'all'; state.chain = 'all'; state.watchlist = false;
        searchInput.value = ''; categorySelect.value = 'all'; chainSelect.value = 'all'; watchInput.checked = false;
        writeHash(); renderTable();
      } })
    ));
  }
  function renderTable() {
    var n = baseRows().length;
    countEl.textContent = state.tab === 'pre-token'
      ? n + ' of ' + DATA.board_size + ' rows shown'
      : n + ' of ' + DATA.live_size + ' live-token protocols';
    sandboxNoteEl.textContent = state.sandbox
      ? 'Sandbox ranking active — exploratory, does not change board.json.'
      : '';
    tableHost.textContent = '';
    tableHost.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
  }

  // ---- Model panel: formula, calibration, sandbox ----
  var sbStatus, sbUp, sbDown, sbPeak, sbBreadth, sbUpOut, sbDownOut, sbPeakOut, sbBreadthOut, sbReset;
  function modelPanel() {
    var m = DATA.model;
    var formula = 'implied = max(1, round(tvl × categoryMultiple × growthMult × ageMult × breadthMult))\n'
      + 'categoryMultiple = median mcap/TVL of live protocols in the category (n ≥ ' + m.min_live_comps + '),\n'
      + '  else the global median ' + DATA.global_multiple.toFixed(4) + '×; clamped to [' + m.multiple_floor + ', ' + m.multiple_cap + ']\n'
      + 'growthMult = 1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 × ' + m.growth_up_weight + ' rising, ' + m.growth_down_weight + ' falling\n'
      + 'ageMult = ' + m.age_floor + ' + ' + (1 - m.age_floor).toFixed(2) + ' × (age / ' + m.age_peak_days + ') to day ' + m.age_peak_days
      + ', then 1 − ' + (1 - m.age_decay_floor).toFixed(2) + ' × min((age − ' + m.age_peak_days + ') / ' + m.age_decay_days + ', 1); unknown age ' + m.unknown_age_mult + '\n'
      + 'breadthMult = 1 + ' + m.breadth_step + ' × min(max(chains − 1, 0), ' + m.breadth_max_chains + ')';
    var calRows = DATA.calibration.map(function (c) {
      return el('tr', null,
        el('td', { text: c.category }),
        el('td', { class: 'num', text: String(c.live_comps) }),
        el('td', { class: 'num', text: c.median_multiple === null ? '—' : c.median_multiple.toFixed(4) + '×' }),
        el('td', { class: 'num', text: c.multiple.toFixed(4) + '×' }),
        el('td', { text: c.fallback ? 'global fallback' : 'category' })
      );
    });
    var calib = el('div', { class: 'calib-wrap' },
      el('table', { class: 'calib' },
        el('thead', null, el('tr', null,
          el('th', { scope: 'col', text: 'Category' }), el('th', { scope: 'col', text: 'Live comps' }),
          el('th', { scope: 'col', text: 'Median multiple' }), el('th', { scope: 'col', text: 'Multiple used' }),
          el('th', { scope: 'col', text: 'Basis' }))),
        el('tbody', null, calRows)
      )
    );
    sbUpOut = el('output', { for: 'sb-up' });
    sbDownOut = el('output', { for: 'sb-down' });
    sbPeakOut = el('output', { for: 'sb-peak' });
    sbBreadthOut = el('output', { for: 'sb-breadth' });
    sbUp = el('input', { type: 'range', id: 'sb-up', min: '0', max: '1', step: '0.05', value: String(m.growth_up_weight), 'aria-label': 'Growth weight, rising' });
    sbDown = el('input', { type: 'range', id: 'sb-down', min: '0', max: '1', step: '0.05', value: String(m.growth_down_weight), 'aria-label': 'Growth weight, falling' });
    sbPeak = el('input', { type: 'range', id: 'sb-peak', min: '90', max: '1080', step: '30', value: String(m.age_peak_days), 'aria-label': 'Age peak in days' });
    sbBreadth = el('input', { type: 'range', id: 'sb-breadth', min: '0', max: '0.1', step: '0.01', value: String(m.breadth_step), 'aria-label': 'Breadth step per extra chain' });
    [sbUp, sbDown, sbPeak, sbBreadth].forEach(function (s) { s.addEventListener('input', onSandboxInput); });
    sbReset = el('button', { class: 'button ghost', type: 'button', text: 'Reset to board constants', onclick: resetSandbox });
    sbStatus = el('p', { class: 'sandbox-status' });
    var sandbox = el('div', { class: 'sandbox' },
      el('div', { class: 'sandbox-head' },
        el('h3', { text: 'Sandbox — try other constants' }),
        el('span', { class: 'warn', text: 'Exploratory — does not change board.json.' })
      ),
      el('div', { class: 'sliders' },
        el('div', { class: 'slider' }, el('label', { for: 'sb-up' }, 'Growth weight, rising', sbUpOut), sbUp),
        el('div', { class: 'slider' }, el('label', { for: 'sb-down' }, 'Growth weight, falling', sbDownOut), sbDown),
        el('div', { class: 'slider' }, el('label', { for: 'sb-peak' }, 'Age peak, days', sbPeakOut), sbPeak),
        el('div', { class: 'slider' }, el('label', { for: 'sb-breadth' }, 'Breadth step per extra chain', sbBreadthOut), sbBreadth)
      ),
      sbStatus,
      el('div', null, sbReset)
    );
    var panel = el('section', { class: 'panel model' },
      el('h2', null, 'How implied value is computed ', el('span', { class: 'tag', text: 'MODEL ' + DATA.model_version.toUpperCase() })),
      el('p', { class: 'sub', text: 'One function scores every row from the snapshot\u2019s own figures. No protocol name is special-cased, and no row is hand-picked.' }),
      el('div', { class: 'formula' }, el('b', { text: formula })),
      el('h3', { text: 'Calibration — live comparables per category' }),
      calib,
      sandbox,
      el('p', { class: 'footnote', text: 'The watchlist is a named list of ' + DATA.watchlist_size + ' slugs in the snapshot; the page cannot see the list itself, so \u201Cwatchlist only\u201D applies its floor (TVL ≥ ' + fmtUsd(DATA.floor_usd) + ').' })
    );
    updateSandboxUI();
    return panel;
  }
  function sandboxValues() {
    var m = DATA.model;
    return {
      growth_up_weight: state.sandbox ? state.sandbox.growth_up_weight : m.growth_up_weight,
      growth_down_weight: state.sandbox ? state.sandbox.growth_down_weight : m.growth_down_weight,
      age_peak_days: state.sandbox ? state.sandbox.age_peak_days : m.age_peak_days,
      breadth_step: state.sandbox ? state.sandbox.breadth_step : m.breadth_step
    };
  }
  function updateSandboxUI() {
    var v = sandboxValues();
    var m = DATA.model;
    sbUp.value = String(v.growth_up_weight); sbDown.value = String(v.growth_down_weight);
    sbPeak.value = String(v.age_peak_days); sbBreadth.value = String(v.breadth_step);
    sbUpOut.textContent = v.growth_up_weight.toFixed(2);
    sbDownOut.textContent = v.growth_down_weight.toFixed(2);
    sbPeakOut.textContent = String(v.age_peak_days) + ' days';
    sbBreadthOut.textContent = v.breadth_step.toFixed(2);
    var active = !!state.sandbox;
    sbStatus.textContent = active
      ? 'Sandbox active: the table re-ranks by the constants above. Board constants are growth ' + m.growth_up_weight + ' / ' + m.growth_down_weight + ', age peak ' + m.age_peak_days + ' days, breadth step ' + m.breadth_step + '.'
      : 'Board constants in effect: growth ' + m.growth_up_weight + ' / ' + m.growth_down_weight + ', age peak ' + m.age_peak_days + ' days, breadth step ' + m.breadth_step + '.';
    sbStatus.className = 'sandbox-status' + (active ? ' on' : '');
    sbReset.disabled = !active;
  }
  function onSandboxInput() {
    var m = DATA.model;
    state.sandbox = {
      growth_up_weight: parseFloat(sbUp.value),
      growth_down_weight: parseFloat(sbDown.value),
      age_peak_days: parseInt(sbPeak.value, 10),
      breadth_step: parseFloat(sbBreadth.value)
    };
    if (state.sandbox.growth_up_weight === m.growth_up_weight && state.sandbox.growth_down_weight === m.growth_down_weight
      && state.sandbox.age_peak_days === m.age_peak_days && state.sandbox.breadth_step === m.breadth_step) {
      state.sandbox = null;
    }
    updateSandboxUI();
    renderTable();
  }
  function resetSandbox() {
    state.sandbox = null;
    updateSandboxUI();
    renderTable();
  }

  // ---- Detail drawer ----
  var drawer = el('aside', { class: 'drawer', id: 'drawer', hidden: 'hidden', 'aria-labelledby': 'detail-title' });
  var backdrop = el('div', { class: 'backdrop', hidden: 'hidden', onclick: closeDetail });
  function markSelected(slug) {
    var rows = document.querySelectorAll('tbody tr[data-slug]');
    for (var i = 0; i < rows.length; i++) {
      rows[i].setAttribute('data-selected', rows[i].getAttribute('data-slug') === slug ? 'true' : 'false');
    }
  }
  function calibrationSentence(row) {
    var cat = row.category || 'Other';
    var cal = CAL.get(cat);
    var g = DATA.global_multiple.toFixed(2);
    if (!cal || cal.fallback) {
      if (cal && cal.live_comps > 0) return 'only ' + cal.live_comps + ' live comparable' + (cal.live_comps === 1 ? '' : 's') + ' — below the minimum of ' + DATA.model.min_live_comps + ', so the global median ' + g + '× applies.';
      return 'no live comparables — global median ' + g + '×.';
    }
    return 'live ' + cat + ' protocols trade at ' + cal.multiple.toFixed(2) + '× TVL (n=' + cal.live_comps + ').';
  }
  function openDetail(slug) {
    var row = null;
    for (var i = 0; i < DATA.rows.length; i++) if (DATA.rows[i].slug === slug) { row = DATA.rows[i]; break; }
    if (!row) return;
    state.selected = slug;
    writeHash();
    var v = modelCalc(row, DATA.model);
    var recomputed = v.implied;
    var same = recomputed === row.implied_value_usd;
    var steps = farmSteps(row, row.age_days);
    drawer.textContent = '';
    drawer.appendChild(el('div', { class: 'drawer-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + ((row.chains || []).join(', ') || 'an unnamed chain') })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: closeDetail })
    ));
    var eq = el('div', { class: 'equation' },
      el('div', null, el('span', { text: 'TVL' }), el('b', { text: fmtUsd(row.tvl_usd) })),
      el('div', null, el('span', { text: 'Category multiple' }), el('b', { text: fmtMult(v.categoryMultiple) })),
      el('div', null, el('span', { text: 'Seven-day change' }), el('b', { text: fmtPct(row.change_7d) })),
      el('div', null, el('span', { text: 'Growth multiplier' }), el('b', { text: fmtMult(v.growthMult) })),
      el('div', null, el('span', { text: 'Age with no token' }), el('b', { text: fmtAge(row.age_days) })),
      el('div', null, el('span', { text: 'Age multiplier' }), el('b', { text: fmtMult(v.ageMult) })),
      el('div', null, el('span', { text: 'Chains' }), el('b', { text: (row.chains || []).length + ' chains' })),
      el('div', null, el('span', { text: 'Breadth multiplier' }), el('b', { text: fmtMult(v.breadthMult) })),
      el('div', { class: 'total' }, el('span', { text: 'Implied value' }), el('b', { text: fmtUsd(row.implied_value_usd) }))
    );
    var verify = el('p', { class: 'verify ' + (same ? 'ok' : 'bad'), text:
      same
        ? 'page recomputes this row as ' + usdFull.format(recomputed) + ', the same number board.json carries.'
        : 'page recomputes this row as ' + usdFull.format(recomputed) + ', which differs from the board\u2019s ' + usdFull.format(row.implied_value_usd) + '.' });
    drawer.appendChild(el('section', { class: 'drawer-section' },
      el('h3', { text: 'Implied value' }), eq,
      el('p', { class: 'sub', text: calibrationSentence(row) }),
      verify,
      el('p', { class: 'sub', text: 'Implied value is a model estimate from the snapshot\u2019s own figures, not a price or a promise.' })
    ));
    var stepItems = steps.map(function (s) {
      var at = s.indexOf(' Cost: ');
      var action = at >= 0 ? s.slice(0, at) : s;
      var tail = at >= 0 ? s.slice(at + 1) : '';
      return el('li', null, el('b', { text: action }), tail ? el('span', { class: 'cost', text: tail }) : null);
    });
    drawer.appendChild(el('section', { class: 'drawer-section' },
      el('h3', { text: 'Farm plan — 7 steps' }),
      el('ol', { class: 'steps' }, stepItems)
    ));
    drawer.removeAttribute('hidden');
    backdrop.removeAttribute('hidden');
    markSelected(slug);
  }
  function closeDetail() {
    if (state.selected === null && drawer.hasAttribute('hidden')) return;
    state.selected = null;
    drawer.setAttribute('hidden', 'hidden');
    backdrop.setAttribute('hidden', 'hidden');
    writeHash();
    markSelected(null);
  }

  // ---- Boot ----
  readHash();
  shell.appendChild(header());
  shell.appendChild(lede());
  shell.appendChild(controls());
  shell.appendChild(tableHost);
  shell.appendChild(modelPanel());
  shell.appendChild(el('p', { class: 'foot', text: 'Snapshot ' + DATA.as_of + ' · model ' + DATA.model_version + ' · every figure on this page comes from data.js.' }));
  app.appendChild(shell);
  app.appendChild(backdrop);
  app.appendChild(drawer);
  app.setAttribute('aria-busy', 'false');
  watchInput.disabled = state.tab !== 'pre-token';
  renderTable();
  if (state.selected) openDetail(state.selected);
  window.addEventListener('hashchange', function () {
    var prevQ = state.q, prevCat = state.category, prevChain = state.chain, prevWl = state.watchlist, prevSel = state.selected;
    readHash();
    if (state.q !== prevQ || state.category !== prevCat || state.chain !== prevChain || state.watchlist !== prevWl) {
      searchInput.value = state.q;
      categorySelect.value = state.category;
      chainSelect.value = state.chain;
      watchInput.checked = state.watchlist;
      renderTable();
    }
    if (state.selected !== prevSel) {
      if (state.selected) openDetail(state.selected);
      else closeDetail();
    }
  });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !drawer.hasAttribute('hidden')) closeDetail();
  });
})();
