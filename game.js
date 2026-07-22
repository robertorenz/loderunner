// ============================================================
//  LODE RUNNER HD — high-resolution remake of the 1983 classic
//  All 150 original Apple II levels. Vanilla JS + Canvas.
// ============================================================
'use strict';

// ---------------- Constants ----------------
const COLS = 28, ROWS = 16;
const T = { EMPTY: 0, BRICK: 1, SOLID: 2, LADDER: 3, ROPE: 4, TRAP: 5, HLADDER: 6 };
const CHAR_MAP = { ' ': T.EMPTY, '#': T.BRICK, '@': T.SOLID, 'H': T.LADDER, '-': T.ROPE, 'X': T.TRAP, 'S': T.HLADDER };

const RUN_SPEED   = 5.2;   // tiles / second
const CLIMB_SPEED = 4.4;
const FALL_SPEED  = 8.0;
const GUARD_FACTOR = 0.62;
const DIG_TIME    = 0.42;  // time to shovel out one brick
const HOLE_LIFE   = 6.2;   // seconds a dug hole stays open
const HOLE_CLOSE  = 0.42;  // closing animation time
const TRAP_TIME   = 2.3;   // guard stuck in hole before climbing out
const SPAWN_TIME  = 1.0;
const DIE_TIME    = 1.15;
const WIN_TIME    = 1.1;
const WIPE_TIME   = 0.65;  // iris circle close/open on death

const SCORE_GOLD  = 250;
const SCORE_TRAP  = 75;
const SCORE_KILL  = 150;
const SCORE_LEVEL = 1500;
const START_LIVES = 5;

// ---------------- Persistence ----------------
const SAVE_KEY = 'loderunner_hd';
function loadSave() {
  try { return Object.assign({ hi: 0, done: [], last: 0 }, JSON.parse(localStorage.getItem(SAVE_KEY) || '{}')); }
  catch { return { hi: 0, done: [], last: 0 }; }
}
function persist() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(SAVE)); } catch {} }
const SAVE = loadSave();

// ---------------- Game state ----------------
const G = {
  level: SAVE.last || 0,        // 0-based index
  tiles: null, goldMap: null,
  goldTotal: 0, goldLeft: 0,
  revealed: false, revealFlash: 0,
  holes: new Map(),             // key -> hole
  runner: null, guards: [],
  particles: [],
  score: 0, lives: START_LIVES,
  state: 'menu',                // menu|ready|play|dying|won|paused|gameover
  stateT: 0,
  time: 0,
};

const keyOf = (x, y) => y * COLS + x;

// ---------------- Level setup ----------------
function loadLevel(idx) {
  const rows = LEVELS[idx];
  G.tiles = []; G.goldMap = [];
  G.guards = []; G.holes.clear(); G.particles = [];
  G.goldTotal = 0; G.revealed = false; G.revealFlash = 0;
  for (let y = 0; y < ROWS; y++) {
    G.tiles[y] = []; G.goldMap[y] = [];
    for (let x = 0; x < COLS; x++) {
      const c = rows[y][x];
      G.goldMap[y][x] = false;
      if (c === '$') { G.tiles[y][x] = T.EMPTY; G.goldMap[y][x] = true; G.goldTotal++; }
      else if (c === '&') { G.tiles[y][x] = T.EMPTY; G.runner = makeActor(x, y, false); }
      else if (c === '0') { G.tiles[y][x] = T.EMPTY; G.guards.push(makeActor(x, y, true)); }
      else G.tiles[y][x] = CHAR_MAP[c] ?? T.EMPTY;
    }
  }
  G.goldLeft = G.goldTotal;
  // classic pacing: each guard's speed drops as the guard count rises
  // (derived from the original's move-scheduling table)
  const GUARD_SPEED = [0.67, 0.67, 0.50, 0.44, 0.42, 0.40, 0.39, 0.38, 0.375, 0.37, 0.367, 0.364];
  const f = GUARD_SPEED[Math.min(G.guards.length, GUARD_SPEED.length - 1)];
  for (const g of G.guards) g.speed = RUN_SPEED * f;
  G.level = idx;
  SAVE.last = idx; persist();
  updateHud(true);
}

function makeActor(x, y, guard) {
  return {
    x, y, dir: 1, guard,
    falling: false, fallDist: 0, digT: 0,
    state: 'normal',            // normal|trapped|exiting|spawning|dead
    t: 0,                       // state timer
    phase: Math.random() * 6,   // animation phase
    carry: false, carryT: 0,
    next: null,                 // guard: next cell target
    speed: guard ? RUN_SPEED * (GUARD_FACTOR + Math.random() * 0.05) : RUN_SPEED,
    homeX: x, homeY: y,
  };
}

// ---------------- Tile queries ----------------
function baseTile(x, y) {
  if (x < 0 || x >= COLS || y >= ROWS) return T.SOLID;
  if (y < 0) return T.EMPTY;
  return G.tiles[y][x];
}
// effective tile (holes open bricks, hidden ladders appear)
function tileAt(x, y) {
  const t = baseTile(x, y);
  if (t === T.BRICK && G.holes.has(keyOf(x, y))) {
    // while being shoveled out, the brick is still solid
    return G.holes.get(keyOf(x, y)).opening ? T.BRICK : T.EMPTY;
  }
  if (t === T.HLADDER) return G.revealed ? T.LADDER : T.EMPTY;
  if (t === T.TRAP) return T.EMPTY;   // false brick: passable, no support
  return t;
}
function solidAt(x, y) { const t = tileAt(x, y); return t === T.BRICK || t === T.SOLID; }
function ladderAt(x, y) { return tileAt(x, y) === T.LADDER; }
function ropeAt(x, y) { return tileAt(x, y) === T.ROPE; }
function trappedGuardAt(x, y) {
  return G.guards.some(g => (g.state === 'trapped' || g.state === 'exiting') &&
    Math.round(g.x) === x && Math.round(g.y) === y);
}
function supportAt(x, y) {
  if (y + 1 >= ROWS) return true;
  if (solidAt(x, y + 1) || ladderAt(x, y + 1)) return true;
  if (trappedGuardAt(x, y + 1)) return true;
  return false;
}
function holeAt(x, y) { return G.holes.get(keyOf(x, y)); }

// ---------------- Input ----------------
const Input = { left: false, right: false, up: false, down: false, digL: false, digR: false };
const KEYMAP = {
  ArrowLeft: 'left', a: 'left', A: 'left',
  ArrowRight: 'right', d: 'right', D: 'right',
  ArrowUp: 'up', w: 'up', W: 'up',
  ArrowDown: 'down', s: 'down', S: 'down',
  z: 'digL', Z: 'digL',
  x: 'digR', X: 'digR',
};

window.addEventListener('keydown', e => {
  if (e.key === 'p' || e.key === 'P') { togglePause(); e.preventDefault(); return; }
  if (e.key === 'm' || e.key === 'M') { toggleSound(); e.preventDefault(); return; }
  if (e.key === 'r' || e.key === 'R') { if (G.state === 'play' || G.state === 'ready') restartLevel(); return; }
  if (e.key === 'l' || e.key === 'L') { if (G.state === 'play' || G.state === 'ready') showLevelSelect(); return; }
  if (e.key === 'Escape' && G.state === 'paused') { togglePause(); return; }
  const k = KEYMAP[e.key];
  if (k) {
    Input[k] = true;
    Sfx.unlock();
    if (G.state === 'ready') { G.state = 'play'; }
    e.preventDefault();
  }
});
window.addEventListener('keyup', e => {
  const k = KEYMAP[e.key];
  if (k) { Input[k] = false; e.preventDefault(); }
});
window.addEventListener('blur', () => { for (const k in Input) Input[k] = false; });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && G.state === 'play') togglePause();
});

// ---------------- Runner logic ----------------
function updateRunner(dt) {
  const r = G.runner;
  r.phase += dt * 10;

  if (r.digT > 0) { r.digT -= dt; return; }

  let cx = Math.round(r.x), cy = Math.round(r.y);
  const centeredY = Math.abs(r.y - cy) < 0.01;
  // a ladder anywhere the body overlaps keeps us from falling (allows standing on ladder tops)
  const onLadder = ladderAt(cx, Math.floor(r.y)) || ladderAt(cx, Math.ceil(r.y));
  const onRope = ropeAt(cx, cy) && centeredY;
  const grounded = centeredY && supportAt(cx, cy);

  // --- falling ---
  if (!onLadder && !onRope && !grounded) {
    const wasFalling = r.falling;
    r.falling = true;
    if (!wasFalling) { r.fallDist = 0; Sfx.fall(); }
    // drift x to column center while dropping
    r.x += Math.sign(cx - r.x) * Math.min(Math.abs(cx - r.x), RUN_SPEED * dt);
    const ny = r.y + FALL_SPEED * dt;
    const nextCy = Math.round(ny);
    // grab a rope when falling past its center, or land on support/ladder
    if (ropeAt(cx, nextCy) && r.y < nextCy && ny >= nextCy) {
      r.y = nextCy; r.falling = false; Sfx.land();
    } else if (ny >= nextCy && (supportAt(cx, nextCy) || ladderAt(cx, nextCy))) {
      r.y = nextCy; r.falling = false; Sfx.land();
    } else {
      r.y = ny; r.fallDist += FALL_SPEED * dt;
    }
    postMoveRunner();
    return;
  }
  r.falling = false;

  // --- digging ---
  if ((Input.digL || Input.digR) && !onRope) {
    const d = Input.digL ? -1 : 1;
    if (tryDig(cx, cy, d)) { r.dir = d; r.digT = DIG_TIME; return; }
  }

  // --- vertical movement ---
  if (Input.up) {
    const cyr = Math.round(r.y);
    if (ladderAt(cx, cyr)) {
      if (!solidAt(cx, cyr - 1) && r.y > 0) {
        r.y -= CLIMB_SPEED * dt;
        r.x += Math.sign(cx - r.x) * Math.min(Math.abs(cx - r.x), RUN_SPEED * dt);
        postMoveRunner();
        return;
      }
      r.y = Math.max(r.y, 0);
    } else if (ladderAt(cx, cyr + 1) && r.y > cyr) {
      // pop up on top of the ladder and stand there
      r.y = Math.max(cyr, r.y - CLIMB_SPEED * dt);
      r.x += Math.sign(cx - r.x) * Math.min(Math.abs(cx - r.x), RUN_SPEED * dt);
      postMoveRunner();
      return;
    }
  }
  if (Input.down) {
    if (onRope) { r.y = cy + 0.05; postMoveRunner(); return; }   // drop from rope
    if ((ladderAt(cx, cy) || ladderAt(cx, cy + 1)) && !solidAt(cx, cy + 1) && !trappedGuardAt(cx, cy + 1)) {
      r.y += CLIMB_SPEED * dt;
      r.x += Math.sign(cx - r.x) * Math.min(Math.abs(cx - r.x), RUN_SPEED * dt);
      postMoveRunner();
      return;
    }
  }

  // --- horizontal movement ---
  let d = 0;
  if (Input.left) d = -1;
  else if (Input.right) d = 1;
  if (d !== 0) {
    r.dir = d;
    const edge = d > 0 ? Math.ceil(r.x) : Math.floor(r.x);
    const targetCell = (d > 0 && r.x >= cx) || (d < 0 && r.x <= cx) ? cx + d : edge;
    if (solidAt(targetCell, cy) || trappedGuardAt(targetCell, cy)) {
      r.x += Math.sign(cx - r.x) * Math.min(Math.abs(cx - r.x), RUN_SPEED * dt); // press against wall
    } else {
      r.x += d * RUN_SPEED * dt;
    }
    r.x = Math.max(0, Math.min(COLS - 1, r.x));
    r.y += Math.sign(cy - r.y) * Math.min(Math.abs(cy - r.y), CLIMB_SPEED * dt);
  }
  postMoveRunner();
}

function postMoveRunner() {
  const r = G.runner;
  const cx = Math.round(r.x), cy = Math.round(r.y);
  // collect gold
  if (cy >= 0 && cy < ROWS && G.goldMap[cy] && G.goldMap[cy][cx] &&
      Math.abs(r.x - cx) < 0.3 && Math.abs(r.y - cy) < 0.3) {
    G.goldMap[cy][cx] = false;
    G.goldLeft--;
    G.score += SCORE_GOLD;
    spawnSparkle(cx, cy, '#ffd257');
    Sfx.gold();
    if (G.goldLeft === 0) {
      G.revealed = true; G.revealFlash = 1;
      Sfx.reveal();
    }
  }
  // reached the top with all gold -> level complete
  if (G.goldLeft === 0 && r.y <= 0.05) startWin();
}

function tryDig(cx, cy, d) {
  const tx = cx + d, ty = cy + 1;
  if (baseTile(tx, ty) !== T.BRICK) return false;
  if (G.holes.has(keyOf(tx, ty))) return false;
  const above = tileAt(tx, cy);
  if (above === T.BRICK || above === T.SOLID || above === T.LADDER) return false;
  if (G.goldMap[cy][tx]) return false;
  // a guard standing in the way blocks the dig
  for (const g of G.guards) {
    if (g.state === 'dead') continue;
    const gx = Math.round(g.x), gy = Math.round(g.y);
    if ((gx === tx && gy === ty) || (gx === tx && gy === cy)) return false;
  }
  G.holes.set(keyOf(tx, ty), { x: tx, y: ty, age: 0, closing: false, closeT: 0, opening: true, openT: 0, chip: 0 });
  Sfx.dig();
  return true;
}

// ---------------- Holes ----------------
function updateHoles(dt) {
  for (const [k, h] of [...G.holes]) {
    if (h.opening) {
      // being shoveled out: chip away with bursts of debris
      h.openT += dt;
      h.chip -= dt;
      if (h.chip <= 0) { h.chip = 0.13; spawnDebris(h.x, h.y, 4); }
      if (h.openT >= DIG_TIME) { h.opening = false; h.age = 0; }
      continue;
    }
    h.age += dt;
    if (!h.closing && h.age >= HOLE_LIFE) { h.closing = true; h.closeT = 0; }
    if (h.closing) {
      h.closeT += dt;
      if (h.closeT >= HOLE_CLOSE) {
        G.holes.delete(k);
        // crush whoever is inside
        const r = G.runner;
        if (Math.round(r.x) === h.x && Math.round(r.y) === h.y && G.state === 'play') { killRunner(); }
        for (const g of G.guards) {
          if (g.state !== 'dead' && Math.round(g.x) === h.x && Math.round(g.y) === h.y) {
            killGuard(g);
          }
        }
      }
    }
  }
}

function killGuard(g) {
  G.score += SCORE_KILL;
  Sfx.guardDie();
  spawnSparkle(Math.round(g.x), Math.round(g.y), '#e2574c');
  g.state = 'dead';
  g.t = 0.8 + Math.random() * 0.6;   // respawn delay
  // note: if carrying gold, the guard rematerializes still carrying it
  // (keeps every level winnable)
}

function respawnGuard(g) {
  // find a spawn spot near the top of the map
  for (let y = 0; y < ROWS; y++) {
    const options = [];
    for (let x = 0; x < COLS; x++) {
      if (solidAt(x, y)) continue;
      if (Math.abs(x - G.runner.x) < 4 && Math.abs(y - G.runner.y) < 4) continue;
      if (G.guards.some(o => o !== g && o.state !== 'dead' && Math.round(o.x) === x && Math.round(o.y) === y)) continue;
      options.push(x);
    }
    if (options.length) {
      g.x = options[Math.floor(Math.random() * options.length)];
      g.y = y;
      g.state = 'spawning'; g.t = SPAWN_TIME;
      g.falling = false; g.next = null;
      Sfx.respawn();
      return;
    }
  }
  g.t = 1; // no room right now, retry shortly
}

// ---------------- Guard AI ----------------
function guardBlocked(x, y, self) {
  if (solidAt(x, y)) return true;
  if (baseTile(x, y) === T.TRAP) return true;   // guards can't step into false bricks sideways
  if (G.guards.some(g => g !== self && (g.state === 'trapped' || g.state === 'exiting') &&
      Math.round(g.x) === x && Math.round(g.y) === y)) return true;
  return false;
}

// something under (x,y) an actor could stand on (used by the floor scans)
function footingAt(x, y) {
  if (y + 1 >= ROWS) return true;
  const b = tileAt(x, y + 1);
  return b === T.BRICK || b === T.SOLID || b === T.LADDER;
}

// ---- classic guard AI, ported from the original Apple II algorithm ----
// (same-row pursuit, then a floor scan rating every drop-off and ladder
//  by which row it reaches relative to the runner)
function guardChooseNext(g) {
  const gx = Math.round(g.x), gy = Math.round(g.y);
  const rx = Math.round(G.runner.x), ry = Math.round(G.runner.y);
  if (gx === rx && gy === ry) return null;
  const act = classicBestMove(g, gx, gy, rx, ry);
  switch (act) {
    case 'left':  return guardBlocked(gx - 1, gy, g) ? null : [gx - 1, gy];
    case 'right': return guardBlocked(gx + 1, gy, g) ? null : [gx + 1, gy];
    case 'up':    return (gy <= 0 || guardBlocked(gx, gy - 1, g)) ? null : [gx, gy - 1];
    case 'down':  return (gy + 1 >= ROWS || solidAt(gx, gy + 1)) ? null : [gx, gy + 1];
    default: return null;
  }
}

function classicBestMove(g, gx, gy, rx, ry) {
  // 1) same-row pursuit: if an unbroken walkable line reaches the runner, charge at him
  if (gy === ry && !G.runner.falling) {
    let x = gx;
    while (x !== rx) {
      const t = tileAt(x, gy);
      const below = gy + 1 >= ROWS ? T.SOLID : tileAt(x, gy + 1);
      const walkable = t === T.LADDER || t === T.ROPE ||
        below === T.SOLID || below === T.BRICK || below === T.LADDER || below === T.ROPE ||
        (gy + 1 < ROWS && (G.goldMap[gy + 1][x] || trappedGuardAt(x, gy + 1)));
      if (!walkable) break;
      x += x < rx ? 1 : -1;
    }
    if (x === rx) return gx < rx ? 'right' : gx > rx ? 'left' : (g.x < G.runner.x ? 'right' : 'left');
  }
  // 2) otherwise scan this floor for the best way toward the runner's row
  return scanFloor(gx, gy, rx, ry);
}

function scanFloor(gx, gy, rx, ry) {
  let bestRating = 255, bestPath = null;
  const rate = (x, y) => y === ry ? Math.abs(gx - x) : (y > ry ? y - ry + 200 : ry - y + 100);
  const consider = (r, path) => { if (r < bestRating) { bestRating = r; bestPath = path; } };
  const sideExit = (x, y) =>
    (x > 0 && (footingAt(x - 1, y) || tileAt(x - 1, y) === T.ROPE)) ||
    (x < COLS - 1 && (footingAt(x + 1, y) || tileAt(x + 1, y) === T.ROPE));

  // simulate dropping down from column x: where would we end up?
  const scanDown = (x, path) => {
    let y = gy;
    while (y < ROWS - 1 && !solidAt(x, y + 1)) {
      // hanging onto a ladder/rope lets the guard exit sideways once level with the runner
      if (tileAt(x, y) !== T.EMPTY && sideExit(x, y) && y >= ry) break;
      y++;
    }
    consider(rate(x, y), path);
  };
  // simulate climbing the ladder at column x
  const scanUp = (x, path) => {
    let y = gy;
    while (y > 0 && tileAt(x, y) === T.LADDER) {
      y--;
      if (sideExit(x, y) && y <= ry) break;
    }
    consider(rate(x, y), path);
  };

  // find how far this floor extends (guards may drop off its ends)
  let x = gx;
  while (x > 0) {
    const t = tileAt(x - 1, gy);
    if (t === T.BRICK || t === T.SOLID) break;
    x--;
    if (!(t === T.LADDER || t === T.ROPE || footingAt(x, gy))) break;
  }
  const leftEnd = x;
  x = gx;
  while (x < COLS - 1) {
    const t = tileAt(x + 1, gy);
    if (t === T.BRICK || t === T.SOLID) break;
    x++;
    if (!(t === T.LADDER || t === T.ROPE || footingAt(x, gy))) break;
  }
  const rightEnd = x;

  // rate the guard's own column first, then sweep the floor from the far ends inward
  if (gy < ROWS - 1 && !solidAt(gx, gy + 1)) scanDown(gx, 'down');
  if (tileAt(gx, gy) === T.LADDER) scanUp(gx, 'up');

  x = leftEnd;
  let path = 'left';
  while (true) {
    if (x === gx) {
      if (path === 'left' && rightEnd !== gx) { path = 'right'; x = rightEnd; }
      else break;
    }
    if (gy < ROWS - 1 && !solidAt(x, gy + 1)) scanDown(x, path);
    if (tileAt(x, gy) === T.LADDER) scanUp(x, path);
    x += path === 'left' ? 1 : -1;
  }
  return bestPath;
}

function updateGuard(g, dt) {
  g.phase += dt * 9;

  if (g.state === 'dead') { g.t -= dt; if (g.t <= 0) respawnGuard(g); return; }
  if (g.state === 'spawning') { g.t -= dt; if (g.t <= 0) { g.state = 'normal'; } return; }

  const cx = Math.round(g.x), cy = Math.round(g.y);

  if (g.state === 'trapped') {
    g.t -= dt;
    const h = holeAt(cx, cy);
    if (!h) { g.state = 'normal'; return; }   // hole already gone (death handled by hole close)
    if (g.t <= 0) { g.state = 'exiting'; g.exitY = cy - 1; }
    return;
  }

  if (g.state === 'exiting') {
    // climb out of the hole to the fixed cell above it
    const ty = g.exitY;
    if (g.y > ty + 0.99) {
      // still fully inside: wait until the landing cell is clear
      if (guardBlocked(cx, ty, g) || ty < 0 ||
          G.guards.some(o => o !== g && o.state !== 'dead' && Math.round(o.x) === cx && Math.round(o.y) === ty)) {
        return;
      }
    }
    g.y -= CLIMB_SPEED * 0.8 * dt;
    if (g.y <= ty) {
      g.y = ty; g.state = 'normal'; g.next = null;
      // step away from the hole so we don't instantly re-fall
      const away = !guardBlocked(cx + 1, ty, g) ? 1 : (!guardBlocked(cx - 1, ty, g) ? -1 : 0);
      if (away) g.next = [cx + away, ty];
    }
    return;
  }

  // --- normal ---
  const centeredY = Math.abs(g.y - cy) < 0.01;
  const t = tileAt(cx, cy);

  // sitting in an open hole -> trapped (checked before the fall logic:
  // holes catch guards even when there is only air beneath them)
  const h = holeAt(cx, cy);
  if (h && !h.opening && !h.closing && centeredY) {
    g.state = 'trapped';
    g.t = TRAP_TIME;
    g.next = null;
    g.falling = false;
    h.age = Math.min(h.age, HOLE_LIFE - 1.2);   // hole stays at least a bit longer
    G.score += SCORE_TRAP;
    Sfx.trap();
    if (g.carry) {
      // fling the gold out onto the ledge above
      if (cy > 0 && !G.goldMap[cy - 1][cx] && !solidAt(cx, cy - 1)) { G.goldMap[cy - 1][cx] = true; g.carry = false; }
    }
    return;
  }

  // falling (forced) — a ladder anywhere the body overlaps counts as support,
  // so guards can climb onto and stand on ladder tops without oscillating
  const onLadderBody = ladderAt(cx, Math.floor(g.y)) || ladderAt(cx, Math.ceil(g.y));
  const sup = (centeredY && supportAt(cx, cy)) || onLadderBody || (t === T.ROPE && centeredY);
  if (!sup) {
    g.falling = true; g.next = null;
    g.x += Math.sign(cx - g.x) * Math.min(Math.abs(cx - g.x), g.speed * dt);
    const ny = g.y + FALL_SPEED * 0.9 * dt;
    const nextCy = Math.round(ny);
    const hFall = holeAt(cx, nextCy);
    if (ropeAt(cx, nextCy) && g.y < nextCy && ny >= nextCy) { g.y = nextCy; g.falling = false; }
    // an open hole always catches a guard, even with nothing but air below it
    else if (hFall && !hFall.opening && !hFall.closing && g.y < nextCy && ny >= nextCy) { g.y = nextCy; g.falling = false; }
    else if (ny >= nextCy && (supportAt(cx, nextCy) || ladderAt(cx, nextCy))) { g.y = nextCy; g.falling = false; }
    else g.y = ny;
    postMoveGuard(g);
    return;
  }
  g.falling = false;

  // pick a destination when we arrive at a cell center
  if (!g.next) {
    if (Math.abs(g.x - cx) < 0.02 && centeredY) {
      g.x = cx; g.y = cy;
      g.next = guardChooseNext(g);
      if (!g.next) return;
    } else {
      g.next = [cx, cy]; // re-center first
    }
  }

  // guards don't stack: if another active guard already sits on our target, wait
  const [nx, ny] = g.next;
  if (G.guards.some(o => o !== g && o.state === 'normal' &&
      Math.round(o.x) === nx && Math.round(o.y) === ny) && !(nx === cx && ny === cy)) {
    g.next = null;
    return;
  }

  const dx = nx - g.x, dy = ny - g.y;
  const sp = g.speed * dt;
  if (Math.abs(dx) > 0.001) { g.dir = Math.sign(dx); g.x += Math.sign(dx) * Math.min(Math.abs(dx), sp); }
  else if (Math.abs(dy) > 0.001) { g.y += Math.sign(dy) * Math.min(Math.abs(dy), sp); }
  if (Math.abs(g.x - nx) < 0.001 && Math.abs(g.y - ny) < 0.001) { g.x = nx; g.y = ny; g.next = null; }

  postMoveGuard(g);
}

function postMoveGuard(g) {
  const cx = Math.round(g.x), cy = Math.round(g.y);
  if (cy < 0 || cy >= ROWS) return;
  // gold pickup / drop
  if (g.state === 'normal') {
    if (!g.carry && G.goldMap[cy][cx] && Math.abs(g.x - cx) < 0.2 && Math.abs(g.y - cy) < 0.2) {
      // classic: guards always take gold they pass, and carry it 14-39 steps
      g.carry = true;
      g.carryT = (14 + Math.floor(Math.random() * 26)) / g.speed;
      G.goldMap[cy][cx] = false;
    }
  }
}

function updateGuardCarry(g, dt) {
  if (!g.carry || g.state !== 'normal') return;
  g.carryT -= dt;
  const cx = Math.round(g.x), cy = Math.round(g.y);
  if (g.carryT <= 0 && cy >= 0 && cy < ROWS &&
      !G.goldMap[cy][cx] && tileAt(cx, cy) === T.EMPTY &&
      supportAt(cx, cy) && !holeAt(cx, cy) &&
      Math.abs(g.x - cx) < 0.1 && Math.abs(g.y - cy) < 0.1) {
    G.goldMap[cy][cx] = true;
    g.carry = false;
  }
}

// ---------------- Death / win ----------------
function killRunner() {
  if (G.state !== 'play') return;
  G.state = 'dying'; G.stateT = 0;
  Sfx.die();
}

function startWin() {
  if (G.state !== 'play') return;
  G.state = 'won'; G.stateT = 0;
  G.score += SCORE_LEVEL;
  G.lives = Math.min(99, G.lives + 1);
  if (!SAVE.done.includes(G.level)) SAVE.done.push(G.level);
  if (G.score > SAVE.hi) SAVE.hi = G.score;
  persist();
  Sfx.win();
}

function checkGuardCollision() {
  const r = G.runner;
  for (const g of G.guards) {
    if (g.state !== 'normal') continue;
    if (Math.abs(g.x - r.x) < 0.55 && Math.abs(g.y - r.y) < 0.55) { killRunner(); return; }
  }
}

// ---------------- Particles ----------------
function spawnDebris(cx, cy, count = 12) {
  for (let i = 0; i < count; i++) {
    G.particles.push({
      x: cx + (Math.random() - 0.5) * 0.6,
      y: cy + (Math.random() - 0.5) * 0.4,
      vx: (Math.random() - 0.5) * 5,
      vy: -Math.random() * 5 - 1,
      life: 0.5 + Math.random() * 0.3,
      maxLife: 0.7,
      size: 0.05 + Math.random() * 0.08,
      color: Math.random() < 0.5 ? '#a5402f' : '#7c2d21',
    });
  }
}
function spawnSparkle(cx, cy, color) {
  for (let i = 0; i < 10; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = 1 + Math.random() * 2.5;
    G.particles.push({
      x: cx, y: cy,
      vx: Math.cos(a) * s, vy: Math.sin(a) * s - 1,
      life: 0.4 + Math.random() * 0.35, maxLife: 0.7,
      size: 0.04 + Math.random() * 0.05,
      color,
    });
  }
}
function updateParticles(dt) {
  for (let i = G.particles.length - 1; i >= 0; i--) {
    const p = G.particles[i];
    p.life -= dt;
    if (p.life <= 0) { G.particles.splice(i, 1); continue; }
    p.vy += 12 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }
}

// ---------------- Main update ----------------
function update(dt) {
  G.time += dt;
  if (G.revealFlash > 0) G.revealFlash = Math.max(0, G.revealFlash - dt * 0.9);
  updateParticles(dt);

  if (G.state === 'play') {
    updateRunner(dt);
    updateHoles(dt);
    for (const g of G.guards) { updateGuard(g, dt); updateGuardCarry(g, dt); }
    if (G.state === 'play') checkGuardCollision();
  } else if (G.state === 'dying') {
    G.stateT += dt;
    updateHoles(dt);
    if (G.stateT >= DIE_TIME) {
      G.lives--;
      // iris closes on the spot where the runner died
      G.wipeX = G.runner.x; G.wipeY = G.runner.y;
      G.state = 'wipeout'; G.stateT = 0;
    }
  } else if (G.state === 'wipeout') {
    G.stateT += dt;
    if (G.stateT >= WIPE_TIME) {
      if (G.lives <= 0) { gameOver(); }
      else {
        // ...and reopens on the runner back at his starting stance
        loadLevel(G.level);
        G.wipeX = G.runner.x; G.wipeY = G.runner.y;
        G.state = 'wipein'; G.stateT = 0;
      }
    }
  } else if (G.state === 'wipein') {
    G.stateT += dt;
    if (G.stateT >= WIPE_TIME) { G.state = 'ready'; }
  } else if (G.state === 'won') {
    G.stateT += dt;
    if (G.stateT >= WIN_TIME) showLevelComplete();
  }
  updateHud();
}

function restartLevel() {
  loadLevel(G.level);
  G.state = 'ready';
  hideModal();
}

function gameOver() {
  G.state = 'gameover';
  if (G.score > SAVE.hi) { SAVE.hi = G.score; persist(); }
  Sfx.gameOver();
  showGameOver();
}

// ============================================================
//                       RENDERING
// ============================================================
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let S = 40;          // tile size in CSS pixels
let DPR = 1;

const sprites = {};  // prerendered tiles

function resize() {
  const stage = document.getElementById('stage');
  const availW = stage.clientWidth - 20, availH = stage.clientHeight - 20;
  S = Math.max(14, Math.floor(Math.min(availW / COLS, availH / ROWS)));
  DPR = window.devicePixelRatio || 1;
  canvas.style.width = COLS * S + 'px';
  canvas.style.height = ROWS * S + 'px';
  canvas.width = Math.round(COLS * S * DPR);
  canvas.height = Math.round(ROWS * S * DPR);
  buildSprites();
}
window.addEventListener('resize', resize);

function makeTileCanvas(draw) {
  const c = document.createElement('canvas');
  c.width = c.height = Math.max(2, Math.round(S * DPR));
  const g = c.getContext('2d');
  g.scale(DPR, DPR);
  draw(g, S);
  return c;
}

function buildSprites() {
  // --- brick ---
  sprites.brick = makeTileCanvas((g, s) => {
    const grad = g.createLinearGradient(0, 0, 0, s);
    grad.addColorStop(0, '#b04a35');
    grad.addColorStop(1, '#8c3526');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
    // mortar
    g.strokeStyle = 'rgba(30,12,8,0.85)';
    g.lineWidth = Math.max(1, s * 0.045);
    g.beginPath();
    g.moveTo(0, s / 3); g.lineTo(s, s / 3);
    g.moveTo(0, 2 * s / 3); g.lineTo(s, 2 * s / 3);
    g.moveTo(s / 2, 0); g.lineTo(s / 2, s / 3);
    g.moveTo(s / 4, s / 3); g.lineTo(s / 4, 2 * s / 3);
    g.moveTo(3 * s / 4, s / 3); g.lineTo(3 * s / 4, 2 * s / 3);
    g.moveTo(s / 2, 2 * s / 3); g.lineTo(s / 2, s);
    g.stroke();
    // top highlight
    g.fillStyle = 'rgba(255,190,150,0.14)';
    g.fillRect(0, 0, s, s * 0.08);
    // bottom shade
    g.fillStyle = 'rgba(0,0,0,0.22)';
    g.fillRect(0, s * 0.94, s, s * 0.06);
  });

  // --- solid bedrock ---
  sprites.solid = makeTileCanvas((g, s) => {
    const grad = g.createLinearGradient(0, 0, s, s);
    grad.addColorStop(0, '#454f63');
    grad.addColorStop(1, '#2b3342');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
    g.strokeStyle = 'rgba(150,170,200,0.18)';
    g.lineWidth = Math.max(1, s * 0.05);
    g.strokeRect(s * 0.06, s * 0.06, s * 0.88, s * 0.88);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(0, s * 0.9, s, s * 0.1);
    g.fillStyle = 'rgba(255,255,255,0.07)';
    g.fillRect(0, 0, s, s * 0.08);
    // rivets
    g.fillStyle = 'rgba(160,180,210,0.4)';
    const rr = s * 0.035;
    for (const [px, py] of [[0.16, 0.16], [0.84, 0.16], [0.16, 0.84], [0.84, 0.84]]) {
      g.beginPath(); g.arc(px * s, py * s, rr, 0, 7); g.fill();
    }
  });

  // --- ladder ---
  sprites.ladder = makeTileCanvas((g, s) => {
    const rail = Math.max(2, s * 0.09);
    g.lineCap = 'round';
    g.strokeStyle = '#8ba3c4';
    g.lineWidth = rail;
    g.beginPath();
    g.moveTo(s * 0.22, 0); g.lineTo(s * 0.22, s);
    g.moveTo(s * 0.78, 0); g.lineTo(s * 0.78, s);
    g.stroke();
    g.strokeStyle = '#a9bedb';
    g.lineWidth = Math.max(2, s * 0.075);
    g.beginPath();
    for (let i = 0; i < 3; i++) {
      const y = s * (0.18 + i * 0.33);
      g.moveTo(s * 0.22, y); g.lineTo(s * 0.78, y);
    }
    g.stroke();
    // subtle glow
    g.strokeStyle = 'rgba(170,200,240,0.15)';
    g.lineWidth = rail * 2;
    g.beginPath();
    g.moveTo(s * 0.22, 0); g.lineTo(s * 0.22, s);
    g.moveTo(s * 0.78, 0); g.lineTo(s * 0.78, s);
    g.stroke();
  });

  // --- rope ---
  sprites.rope = makeTileCanvas((g, s) => {
    g.strokeStyle = '#c9a86b';
    g.lineWidth = Math.max(2, s * 0.07);
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(0, s * 0.16);
    g.quadraticCurveTo(s / 2, s * 0.24, s, s * 0.16);
    g.stroke();
    g.strokeStyle = 'rgba(60,40,15,0.5)';
    g.lineWidth = Math.max(1, s * 0.02);
    for (let i = 1; i < 6; i++) {
      const x = (i / 6) * s;
      const y = 0.16 * s + 0.08 * s * Math.sin(Math.PI * i / 6) - 0.03 * s;
      g.beginPath();
      g.moveTo(x - s * 0.03, y);
      g.lineTo(x + s * 0.03, y + s * 0.09);
      g.stroke();
    }
  });

  // --- background ---
  sprites.bg = document.createElement('canvas');
  sprites.bg.width = canvas.width; sprites.bg.height = canvas.height;
  {
    const g = sprites.bg.getContext('2d');
    g.scale(DPR, DPR);
    const w = COLS * S, h = ROWS * S;
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#101725');
    grad.addColorStop(0.6, '#0c111c');
    grad.addColorStop(1, '#080b12');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    // faint distant texture
    for (let i = 0; i < 90; i++) {
      const x = Math.random() * w, y = Math.random() * h;
      g.fillStyle = `rgba(120,150,200,${0.015 + Math.random() * 0.03})`;
      g.fillRect(x, y, 2, 2);
    }
    // vignette
    const v = g.createRadialGradient(w / 2, h / 2, h * 0.4, w / 2, h / 2, h * 1.05);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.42)');
    g.fillStyle = v;
    g.fillRect(0, 0, w, h);
  }
}

// --- gold (drawn live for pulse animation) ---
function drawGold(x, y, t) {
  const px = x * S, py = y * S;
  const pulse = 0.75 + 0.25 * Math.sin(t * 3 + x * 1.7 + y);
  ctx.save();
  ctx.translate(px + S / 2, py + S * 0.68);
  // glow
  const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, S * 0.55);
  glow.addColorStop(0, `rgba(255,210,87,${0.28 * pulse})`);
  glow.addColorStop(1, 'rgba(255,210,87,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(-S * 0.6, -S * 0.6, S * 1.2, S * 1.2);
  // ingot stack
  const ing = (w, h, yy) => {
    const grad = ctx.createLinearGradient(0, yy - h, 0, yy);
    grad.addColorStop(0, '#ffe38a');
    grad.addColorStop(0.5, '#f2b632');
    grad.addColorStop(1, '#b57e12');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(-w / 2, yy);
    ctx.lineTo(-w / 2 + h * 0.35, yy - h);
    ctx.lineTo(w / 2 - h * 0.35, yy - h);
    ctx.lineTo(w / 2, yy);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(90,60,0,0.55)';
    ctx.lineWidth = Math.max(1, S * 0.02);
    ctx.stroke();
  };
  ing(S * 0.62, S * 0.2, 0);
  ing(S * 0.44, S * 0.19, -S * 0.19);
  // sparkle
  const sa = t * 2.2 + x * 3 + y * 5;
  const sx = Math.cos(sa) * S * 0.12, sy = -S * 0.25 + Math.sin(sa * 0.7) * S * 0.06;
  ctx.fillStyle = `rgba(255,255,255,${0.5 + 0.5 * Math.sin(t * 5 + x)})`;
  ctx.beginPath();
  const r = S * 0.045;
  ctx.moveTo(sx, sy - r * 2); ctx.lineTo(sx + r * 0.6, sy - r * 0.6);
  ctx.lineTo(sx + r * 2, sy); ctx.lineTo(sx + r * 0.6, sy + r * 0.6);
  ctx.lineTo(sx, sy + r * 2); ctx.lineTo(sx - r * 0.6, sy + r * 0.6);
  ctx.lineTo(sx - r * 2, sy); ctx.lineTo(sx - r * 0.6, sy - r * 0.6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// --- humanoid figure (runner + guards), vector-drawn, smoothly animated ---
function drawFigure(a, colors) {
  const px = a.x * S + S / 2;
  const py = a.y * S + S / 2;
  const h = S * 0.82;                     // figure height
  const lw = Math.max(2, S * 0.085);      // limb width
  const ph = a.phase;
  const dir = a.dir || 1;

  let pose = 'stand';
  if (a === G.runner && G.state === 'dying') pose = 'dying';
  else if (a.digT > 0) pose = 'dig';
  else if (a.state === 'trapped') pose = 'trapped';
  else if (a.state === 'spawning') pose = 'spawn';
  else if (a.falling) pose = 'fall';
  else {
    const cx = Math.round(a.x), cy = Math.round(a.y);
    const onRope = ropeAt(cx, cy) && Math.abs(a.y - cy) < 0.05;
    const onLadder = ladderAt(cx, cy) && Math.abs(a.y - cy) > 0.02;
    const movingX = a.guard ? (a.next && a.next[0] !== cx) : (Input.left || Input.right);
    const movingY = a.guard ? (a.next && a.next[1] !== cy) : (Input.up || Input.down);
    if (onRope) pose = 'rope';
    else if ((ladderAt(cx, cy) || ladderAt(cx, cy + 1)) && movingY) pose = 'climb';
    else if (movingX) pose = 'run';
  }

  ctx.save();
  ctx.translate(px, py);
  if (pose === 'spawn') ctx.globalAlpha = 0.25 + 0.5 * Math.abs(Math.sin(ph * 2.4));
  if (pose === 'dying') {
    ctx.globalAlpha = Math.max(0, 1 - G.stateT / DIE_TIME);
    ctx.translate(0, -G.stateT * S * 0.6);
  }

  // ground shadow
  if (pose !== 'fall' && pose !== 'rope' && pose !== 'dying') {
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(0, h * 0.52, S * 0.24, S * 0.055, 0, 0, 7);
    ctx.fill();
  }

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const headR = h * 0.14;
  let headY = -h * 0.33;
  let hipY = h * 0.08;
  let neckY = headY + headR * 0.9;
  let lean = 0;

  // limb endpoints (relative)
  let armL, armR, legL, legR;
  const swing = Math.sin(ph);
  const swing2 = Math.sin(ph + Math.PI);

  switch (pose) {
    case 'run': {
      lean = dir * 0.14;
      const la = swing * 0.85, lb = swing2 * 0.85;
      legL = [Math.sin(la) * h * 0.3, hipY + Math.cos(la) * h * 0.42];
      legR = [Math.sin(lb) * h * 0.3, hipY + Math.cos(lb) * h * 0.42];
      armL = [Math.sin(lb) * h * 0.26, neckY + h * 0.3 + Math.abs(Math.cos(lb)) * h * 0.05];
      armR = [Math.sin(la) * h * 0.26, neckY + h * 0.3 + Math.abs(Math.cos(la)) * h * 0.05];
      break;
    }
    case 'climb': {
      const c = Math.sin(ph * 1.2);
      armL = [-h * 0.18, headY - h * 0.14 + c * h * 0.08];
      armR = [h * 0.18, headY - h * 0.14 - c * h * 0.08];
      legL = [-h * 0.12, hipY + h * 0.38 - c * h * 0.1];
      legR = [h * 0.12, hipY + h * 0.38 + c * h * 0.1];
      break;
    }
    case 'rope': {
      headY += h * 0.12; neckY += h * 0.12; hipY += h * 0.1;
      const ropeY = headY - h * 0.2;
      const cx0 = Math.round(a.x);
      const moving = a.guard ? (a.next && a.next[0] !== cx0) : (Input.left || Input.right);
      if (moving) {
        // hand over hand: the cycle is tied to distance traveled, so each
        // hand releases, swings past the other, and re-grips the rope
        const t = a.x * Math.PI * 2.4;
        const s1 = Math.sin(t), s2 = Math.sin(t + Math.PI);
        armL = [s1 * h * 0.26, ropeY + (1 - Math.abs(s1)) * h * 0.10];
        armR = [s2 * h * 0.26, ropeY + (1 - Math.abs(s2)) * h * 0.10];
        const sway = Math.sin(t) * 0.05;
        legL = [(-0.08 - sway) * h - dir * h * 0.06, hipY + h * 0.34];
        legR = [(0.08 - sway) * h - dir * h * 0.06, hipY + h * 0.36];
      } else {
        const c = Math.sin(ph * 0.8) * 0.06;
        armL = [-h * 0.14, ropeY];
        armR = [h * 0.14, ropeY];
        legL = [(-0.1 + c) * h, hipY + h * 0.36];
        legR = [(0.1 + c) * h, hipY + h * 0.36];
      }
      break;
    }
    case 'fall': {
      const c = Math.sin(ph * 2) * 0.08;
      armL = [-h * 0.3, neckY - h * 0.1 + c * h];
      armR = [h * 0.3, neckY - h * 0.1 - c * h];
      legL = [-h * 0.18 + c * h, hipY + h * 0.36];
      legR = [h * 0.18 - c * h, hipY + h * 0.36];
      break;
    }
    case 'dig': {
      // chopping swing driven by dig progress
      const p = 1 - Math.max(0, a.digT || 0) / DIG_TIME;
      const bob = Math.sin(p * Math.PI * 4) * h * 0.06;
      lean = dir * (0.26 + bob / h);
      hipY += h * 0.06;
      armL = [dir * h * 0.42, hipY + h * 0.16 + bob];
      armR = [dir * h * 0.30, hipY + h * 0.24 + bob];
      legL = [-dir * h * 0.2, hipY + h * 0.36];
      legR = [dir * h * 0.16, hipY + h * 0.4];
      break;
    }
    case 'trapped': {
      headY += h * 0.28; neckY += h * 0.28; hipY += h * 0.3;
      const c = Math.sin(ph * 3) * h * 0.1;
      armL = [-h * 0.26, headY - h * 0.18 + c];
      armR = [h * 0.26, headY - h * 0.18 - c];
      legL = [-h * 0.08, hipY + h * 0.2];
      legR = [h * 0.08, hipY + h * 0.2];
      break;
    }
    default: { // stand / spawn / dying
      armL = [-h * 0.14, neckY + h * 0.32];
      armR = [h * 0.14, neckY + h * 0.32];
      legL = [-h * 0.11, hipY + h * 0.42];
      legR = [h * 0.11, hipY + h * 0.42];
    }
  }

  ctx.rotate(lean);

  const shoulderY = neckY + h * 0.05;
  const backView = pose === 'climb';   // climbing a ladder shows the character's back

  const limbPath = (x0, y0, x1, y1, bowSign) => {
    // limbs bend softly at an implied joint (knee/elbow)
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const bow = h * 0.055;
    const jx = mx + (-dy / len) * bow * bowSign;
    const jy = my + (dx / len) * bow * 0.35;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(jx, jy, x1, y1);
    ctx.stroke();
  };

  const drawLeg = ([fx, fy], pants, shade) => {
    ctx.strokeStyle = shade ? colors.pantsDark : colors.pants;
    ctx.lineWidth = lw * 1.05;
    limbPath(0, hipY, fx, fy - h * 0.03, fx >= 0 ? 1 : -1);
    // shoe: flat oval oriented toward facing direction
    ctx.fillStyle = colors.shoes;
    ctx.beginPath();
    ctx.ellipse(fx + dir * h * 0.035, fy, h * 0.075, h * 0.038, 0, 0, 7);
    ctx.fill();
  };

  const drawArm = ([hx, hy], shade) => {
    ctx.strokeStyle = shade ? colors.shirtDark : colors.shirt;
    ctx.lineWidth = lw * 0.85;
    limbPath(0, shoulderY, hx, hy, hx >= 0 ? 1 : -1);
    // hand
    ctx.fillStyle = colors.skin;
    ctx.beginPath();
    ctx.arc(hx, hy, lw * 0.5, 0, 7);
    ctx.fill();
  };

  // back limbs (shaded)
  drawLeg(legR, colors.pants, true);
  drawArm(armR, true);

  // torso: shirt tapering from shoulders to hips
  const shW = h * 0.155, hipW = h * 0.115;
  const grad = ctx.createLinearGradient(-shW, 0, shW, 0);
  grad.addColorStop(0, colors.shirtDark);
  grad.addColorStop(0.45, colors.shirt);
  grad.addColorStop(1, colors.shirt);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(-shW, shoulderY);
  ctx.quadraticCurveTo(0, shoulderY - h * 0.045, shW, shoulderY);
  ctx.lineTo(hipW, hipY + h * 0.02);
  ctx.lineTo(-hipW, hipY + h * 0.02);
  ctx.closePath();
  ctx.fill();
  // belt
  ctx.fillStyle = colors.belt;
  ctx.fillRect(-hipW, hipY - h * 0.015, hipW * 2, h * 0.045);

  // front limbs
  drawLeg(legL, colors.pants, false);
  drawArm(armL, false);

  // neck + head
  ctx.fillStyle = colors.skin;
  ctx.fillRect(-lw * 0.4, headY + headR * 0.6, lw * 0.8, neckY - headY - headR * 0.4);
  ctx.beginPath();
  ctx.arc(0, headY, headR, 0, 7);
  ctx.fill();
  // hair: covers the top of the head (all of it in back view)
  ctx.fillStyle = colors.hair;
  ctx.beginPath();
  if (backView) {
    ctx.arc(0, headY, headR, 0, 7);
  } else {
    ctx.arc(0, headY, headR, Math.PI * 1.02, Math.PI * 1.98);
    ctx.quadraticCurveTo(dir * headR * 0.9, headY - headR * 0.35, dir * headR * 0.95, headY - headR * 0.1);
    ctx.quadraticCurveTo(0, headY - headR * 0.35, -dir * headR * 0.98, headY - headR * 0.05);
  }
  ctx.closePath();
  ctx.fill();
  if (!backView) {
    // eye + simple profile shading on the facing side
    ctx.fillStyle = '#1c2430';
    ctx.beginPath();
    ctx.arc(dir * headR * 0.45, headY + headR * 0.02, headR * 0.13, 0, 7);
    ctx.fill();
    // nose hint
    ctx.strokeStyle = 'rgba(120,80,50,0.45)';
    ctx.lineWidth = Math.max(1, lw * 0.2);
    ctx.beginPath();
    ctx.moveTo(dir * headR * 0.78, headY + headR * 0.1);
    ctx.lineTo(dir * headR * 0.92, headY + headR * 0.28);
    ctx.stroke();
  }
  // guards wear a peaked cap
  if (colors.cap) {
    ctx.fillStyle = colors.cap;
    ctx.beginPath();
    ctx.arc(0, headY - headR * 0.15, headR * 1.02, Math.PI, Math.PI * 2);
    ctx.closePath();
    ctx.fill();
    if (!backView) {
      ctx.fillRect(dir > 0 ? 0 : -headR * 1.45, headY - headR * 0.3, headR * 1.45, headR * 0.22);
    }
    ctx.fillStyle = colors.belt;
    ctx.fillRect(-headR * 0.18, headY - headR * 0.75, headR * 0.36, headR * 0.2);
  }

  // shovel while digging
  if (pose === 'dig') {
    const [hx1, hy1] = armL;   // lower/leading hand grips the shaft
    const [hx0, hy0] = armR;
    const tipX = hx1 + dir * h * 0.30, tipY = hy1 + h * 0.26;
    // wooden shaft runs through both hands to the blade
    ctx.strokeStyle = '#8a6238';
    ctx.lineWidth = lw * 0.5;
    ctx.beginPath();
    ctx.moveTo(hx0 - dir * h * 0.1, hy0 - h * 0.12);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    // steel blade
    ctx.save();
    ctx.translate(tipX, tipY);
    ctx.rotate(dir * 0.85);
    const bg2 = ctx.createLinearGradient(0, -h * 0.1, 0, h * 0.1);
    bg2.addColorStop(0, '#d3dde9');
    bg2.addColorStop(1, '#8fa2b8');
    ctx.fillStyle = bg2;
    ctx.beginPath();
    ctx.moveTo(-h * 0.07, -h * 0.1);
    ctx.lineTo(h * 0.07, -h * 0.1);
    ctx.quadraticCurveTo(h * 0.09, h * 0.06, 0, h * 0.12);
    ctx.quadraticCurveTo(-h * 0.09, h * 0.06, -h * 0.07, -h * 0.1);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(40,55,75,0.6)';
    ctx.lineWidth = Math.max(1, lw * 0.2);
    ctx.stroke();
    ctx.restore();
  }

  // carried gold
  if (a.carry) {
    ctx.fillStyle = '#f2b632';
    ctx.strokeStyle = 'rgba(90,60,0,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(-h * 0.1, headY - headR - h * 0.16, h * 0.2, h * 0.1);
    ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

const RUNNER_COLORS = {
  skin: '#e9bb8f', hair: '#6b4a2f',
  shirt: '#e8eef7', shirtDark: '#aebccf',
  pants: '#3a6ea5', pantsDark: '#2a5078',
  shoes: '#26303e', belt: '#f2b632', cap: null,
};
const GUARD_COLORS = {
  skin: '#dda878', hair: '#2e2622',
  shirt: '#d9534a', shirtDark: '#9c352e',
  pants: '#41332f', pantsDark: '#2e2320',
  shoes: '#1b1512', belt: '#f0a13a', cap: '#37424f',
};

// --- frame ---
function render() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.drawImage(sprites.bg, 0, 0, COLS * S, ROWS * S);

  const t = G.time;

  // terrain
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const b = G.tiles[y][x];
      const px = x * S, py = y * S;
      if (b === T.BRICK || b === T.TRAP) {
        const h = b === T.BRICK ? holeAt(x, y) : null;
        if (!h) {
          ctx.drawImage(sprites.brick, px, py, S, S);
        } else if (h.opening) {
          // brick being shoveled out: excavation grows from the top down
          ctx.drawImage(sprites.brick, px, py, S, S);
          const p = Math.min(1, h.openT / DIG_TIME);
          ctx.save();
          ctx.beginPath();
          ctx.rect(px, py, S, S * p);
          ctx.clip();
          drawHole(px, py);
          ctx.restore();
          // cracks spreading ahead of the excavation
          ctx.strokeStyle = 'rgba(20,8,5,0.6)';
          ctx.lineWidth = Math.max(1, S * 0.03);
          ctx.beginPath();
          ctx.moveTo(px + S * 0.3, py + S * p);
          ctx.lineTo(px + S * 0.22, py + Math.min(S, S * (p + 0.3)));
          ctx.moveTo(px + S * 0.7, py + S * p);
          ctx.lineTo(px + S * 0.78, py + Math.min(S, S * (p + 0.25)));
          ctx.stroke();
        } else if (h.closing) {
          // brick regrows from the top down
          const p = Math.min(1, h.closeT / HOLE_CLOSE);
          drawHole(px, py);
          ctx.save();
          ctx.beginPath();
          ctx.rect(px, py, S, S * p);
          ctx.clip();
          ctx.drawImage(sprites.brick, px, py, S, S);
          ctx.restore();
        } else {
          drawHole(px, py);
          if (h.age > HOLE_LIFE - 1.0) {
            // warning shimmer just before it closes
            ctx.fillStyle = `rgba(226,87,76,${0.12 + 0.1 * Math.sin(t * 14)})`;
            ctx.fillRect(px, py, S, S);
          }
        }
      } else if (b === T.SOLID) {
        ctx.drawImage(sprites.solid, px, py, S, S);
      } else if (b === T.LADDER) {
        ctx.drawImage(sprites.ladder, px, py, S, S);
      } else if (b === T.HLADDER && G.revealed) {
        ctx.drawImage(sprites.ladder, px, py, S, S);
        if (G.revealFlash > 0) {
          ctx.fillStyle = `rgba(255,210,87,${G.revealFlash * 0.45})`;
          ctx.fillRect(px, py, S, S);
        }
      } else if (b === T.ROPE) {
        ctx.drawImage(sprites.rope, px, py, S, S);
      }
    }
  }

  // gold
  for (let y = 0; y < ROWS; y++)
    for (let x = 0; x < COLS; x++)
      if (G.goldMap[y][x]) drawGold(x, y, t);

  // actors
  for (const g of G.guards) if (g.state !== 'dead') drawFigure(g, GUARD_COLORS);
  if (G.state !== 'wipeout') drawFigure(G.runner, RUNNER_COLORS);

  // particles
  for (const p of G.particles) {
    ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
    ctx.fillStyle = p.color;
    const sz = p.size * S;
    ctx.fillRect(p.x * S + S / 2 - sz / 2, p.y * S + S / 2 - sz / 2, sz, sz);
  }
  ctx.globalAlpha = 1;

  // iris wipe: circle closes where the runner died, reopens at the start stance
  if (G.state === 'wipeout' || G.state === 'wipein') {
    const w = COLS * S, hgt = ROWS * S;
    let p = Math.min(1, G.stateT / WIPE_TIME);
    p = p * p * (3 - 2 * p);   // smoothstep easing
    const frac = G.state === 'wipeout' ? 1 - p : p;
    const cx = G.wipeX * S + S / 2, cy = G.wipeY * S + S / 2;
    const maxR = Math.max(
      Math.hypot(cx, cy), Math.hypot(w - cx, cy),
      Math.hypot(cx, hgt - cy), Math.hypot(w - cx, hgt - cy));
    const r = Math.max(0.001, maxR * frac);
    ctx.fillStyle = '#04060a';
    ctx.beginPath();
    ctx.rect(0, 0, w, hgt);
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill('evenodd');
    // thin golden rim on the iris edge
    ctx.strokeStyle = 'rgba(242,182,50,0.35)';
    ctx.lineWidth = Math.max(1.5, S * 0.06);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // overlays
  if (G.state === 'ready') {
    banner(`LEVEL ${String(G.level + 1).padStart(3, '0')}`, 'press any movement key to begin');
  } else if (G.state === 'won') {
    ctx.fillStyle = `rgba(255,210,87,${0.12 * Math.sin(G.stateT * 10) + 0.12})`;
    ctx.fillRect(0, 0, COLS * S, ROWS * S);
  }
}

function drawHole(px, py) {
  ctx.fillStyle = '#05070c';
  ctx.fillRect(px, py, S, S);
  // ragged edge
  ctx.fillStyle = 'rgba(140,53,38,0.5)';
  const n = 5;
  for (let i = 0; i < n; i++) {
    const w = S / n;
    ctx.fillRect(px + i * w, py, w * 0.7, S * 0.08 * ((i * 7 + 3) % 3 + 1) / 3);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(px, py, S * 0.1, S);
  ctx.fillRect(px + S * 0.9, py, S * 0.1, S);
}

function banner(title, sub) {
  const w = COLS * S, h = ROWS * S;
  ctx.fillStyle = 'rgba(5,8,13,0.55)';
  ctx.fillRect(0, h * 0.36, w, h * 0.24);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#f2b632';
  ctx.font = `800 ${S * 1.15}px "Segoe UI", sans-serif`;
  ctx.shadowColor = 'rgba(242,182,50,0.5)';
  ctx.shadowBlur = S * 0.5;
  ctx.fillText(title, w / 2, h * 0.47);
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#8b98ac';
  ctx.font = `500 ${S * 0.42}px "Segoe UI", sans-serif`;
  ctx.fillText(sub, w / 2, h * 0.55);
}

// ---------------- HUD ----------------
const hudEls = {
  level: document.getElementById('hud-level'),
  score: document.getElementById('hud-score'),
  hi: document.getElementById('hud-hiscore'),
  gold: document.getElementById('hud-gold'),
  lives: document.getElementById('hud-lives'),
};
const hudCache = {};
function setHud(el, v) { if (hudCache[el] !== v) { hudCache[el] = v; hudEls[el].textContent = v; } }
function updateHud() {
  setHud('level', String(G.level + 1).padStart(3, '0'));
  setHud('score', String(G.score));
  setHud('hi', String(Math.max(SAVE.hi, G.score)));
  setHud('gold', `${G.goldTotal - G.goldLeft}/${G.goldTotal}`);
  setHud('lives', String(G.lives));
}

// ---------------- Modals ----------------
const backdrop = document.getElementById('modal-backdrop');
const modalContent = document.getElementById('modal-content');
function showModal(html) { modalContent.innerHTML = html; backdrop.classList.remove('hidden'); }
function hideModal() { backdrop.classList.add('hidden'); }

function showStart() {
  G.state = 'menu';
  const resume = SAVE.last > 0 ? `<button class="btn" id="m-resume">CONTINUE — LEVEL ${SAVE.last + 1}</button>` : '';
  showModal(`
    <div class="modal-title">LODE RUNNER</div>
    <div class="modal-sub">HD REMASTER &middot; ALL 150 ORIGINAL LEVELS &middot; 1983 CLASSIC</div>
    <div class="help-grid">
      <span class="k">← → ↑ ↓</span><span>Run, climb ladders, hang from ropes</span>
      <span class="k">Z / X</span><span>Dig left / right through brick floors</span>
      <span class="k">P &nbsp; R &nbsp; M</span><span>Pause &middot; Restart level &middot; Sound on/off</span>
    </div>
    <div class="modal-sub" style="margin-top:1rem">
      Collect every gold chest, then climb to the top.<br>
      Trap guards in dug holes — but watch out, they climb back out.
    </div>
    <div class="modal-actions">
      <button class="btn primary" id="m-start">START — LEVEL 1</button>
      ${resume}
      <button class="btn" id="m-levels">LEVEL SELECT</button>
    </div>`);
  document.getElementById('m-start').onclick = () => { startGame(0); };
  document.getElementById('m-levels').onclick = () => showLevelSelect();
  const res = document.getElementById('m-resume');
  if (res) res.onclick = () => { startGame(SAVE.last); };
}

function showLevelSelect() {
  const wasPlaying = G.state === 'play' || G.state === 'ready';
  G.state = 'paused';
  let cells = '';
  for (let i = 0; i < LEVELS.length; i++) {
    const cls = i === G.level && wasPlaying ? 'current' : (SAVE.done.includes(i) ? 'done' : '');
    cells += `<button class="level-cell ${cls}" data-level="${i}">${i + 1}</button>`;
  }
  showModal(`
    <div class="modal-title">SELECT LEVEL</div>
    <div class="modal-sub">${SAVE.done.length} / ${LEVELS.length} COMPLETED</div>
    <div class="level-grid">${cells}</div>
    <div class="modal-actions"><button class="btn" id="m-back">BACK</button></div>`);
  modalContent.querySelectorAll('.level-cell').forEach(b => {
    b.onclick = () => startGame(parseInt(b.dataset.level, 10));
  });
  document.getElementById('m-back').onclick = () => {
    if (wasPlaying) { G.state = 'ready'; hideModal(); } else showStart();
  };
}

function showLevelComplete() {
  G.state = 'paused';
  const next = G.level + 1;
  const hasNext = next < LEVELS.length;
  showModal(`
    <div class="modal-title">LEVEL ${G.level + 1} CLEAR</div>
    <div class="modal-sub">+${SCORE_LEVEL} BONUS &middot; +1 LIFE</div>
    <div class="modal-big-score">${G.score}</div>
    <div class="modal-actions">
      ${hasNext ? '<button class="btn primary" id="m-next">NEXT LEVEL</button>' : ''}
      <button class="btn" id="m-replay">REPLAY</button>
      <button class="btn" id="m-menu">LEVELS</button>
    </div>
    ${hasNext ? '' : '<div class="modal-sub" style="margin-top:1rem">You have finished all 150 levels. Legend.</div>'}`);
  if (hasNext) document.getElementById('m-next').onclick = () => { loadLevel(next); G.state = 'ready'; hideModal(); };
  document.getElementById('m-replay').onclick = () => { loadLevel(G.level); G.state = 'ready'; hideModal(); };
  document.getElementById('m-menu').onclick = () => showLevelSelect();
}

function showGameOver() {
  const isHi = G.score >= SAVE.hi && G.score > 0;
  showModal(`
    <div class="modal-title" style="color:var(--danger);text-shadow:0 0 22px rgba(226,87,76,.4)">GAME OVER</div>
    ${isHi ? '<div class="modal-sub" style="color:var(--gold)">★ NEW HIGH SCORE ★</div>' : ''}
    <div class="modal-big-score">${G.score}</div>
    <div class="modal-sub">LEVEL ${G.level + 1} &middot; HIGH SCORE ${SAVE.hi}</div>
    <div class="modal-actions">
      <button class="btn primary" id="m-retry">TRY AGAIN</button>
      <button class="btn" id="m-menu">MENU</button>
    </div>`);
  document.getElementById('m-retry').onclick = () => {
    G.score = 0; G.lives = START_LIVES;
    loadLevel(G.level); G.state = 'ready'; hideModal();
  };
  document.getElementById('m-menu').onclick = () => showStart();
}

function togglePause() {
  if (G.state === 'play' || G.state === 'ready') {
    G.state = 'paused';
    showModal(`
      <div class="modal-title">PAUSED</div>
      <div class="modal-actions">
        <button class="btn primary" id="m-resume">RESUME</button>
        <button class="btn" id="m-restart">RESTART LEVEL</button>
        <button class="btn" id="m-levels">LEVELS</button>
      </div>`);
    document.getElementById('m-resume').onclick = () => { G.state = 'ready'; hideModal(); };
    document.getElementById('m-restart').onclick = () => restartLevel();
    document.getElementById('m-levels').onclick = () => showLevelSelect();
  } else if (G.state === 'paused') {
    G.state = 'ready';
    hideModal();
  }
}

function toggleSound() {
  Sfx.setEnabled(!Sfx.enabled);
  document.getElementById('btn-sound').textContent = 'SOUND: ' + (Sfx.enabled ? 'ON' : 'OFF');
}

function startGame(levelIdx) {
  G.score = 0;
  G.lives = START_LIVES;
  loadLevel(levelIdx);
  G.state = 'ready';
  hideModal();
  Sfx.unlock();
}

// HUD buttons
document.getElementById('btn-pause').onclick = () => togglePause();
document.getElementById('btn-restart').onclick = () => { if (G.state !== 'menu') restartLevel(); };
document.getElementById('btn-sound').onclick = () => toggleSound();
document.getElementById('btn-levels').onclick = () => showLevelSelect();

// ---------------- Main loop ----------------
let lastTime = 0, acc = 0;
const STEP = 1 / 120;
function frame(ts) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (ts - lastTime) / 1000 || 0);
  lastTime = ts;
  try {
    if (G.state !== 'paused' && G.state !== 'menu' && G.state !== 'gameover') {
      acc += dt;
      while (acc >= STEP) { update(STEP); acc -= STEP; }
    }
    if (G.tiles) render();
  } catch (e) {
    console.error('[LodeRunner] frame error:', e);
  }
}

// ---------------- Boot ----------------
G.runner = makeActor(0, 0, false);
loadLevel(SAVE.last || 0);
resize();
showStart();
requestAnimationFrame(frame);
