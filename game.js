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
  G.terrainDirty = true;
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
      G.revealed = true; G.revealFlash = 1; G.terrainDirty = true;
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

// the guards' mental map: like tileAt, but dug holes still look like solid
// bricks — guards can't see holes, which is what makes them trappable
function aiTileAt(x, y) {
  const t = baseTile(x, y);
  if (t === T.HLADDER) return G.revealed ? T.LADDER : T.EMPTY;
  if (t === T.TRAP) return T.EMPTY;
  return t;
}
function aiSolidAt(x, y) { const t = aiTileAt(x, y); return t === T.BRICK || t === T.SOLID; }
function aiFootingAt(x, y) {
  if (y + 1 >= ROWS) return true;
  const b = aiTileAt(x, y + 1);
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
  // 1) same-row pursuit: if an unbroken walkable line reaches the runner, charge
  //    at him — judged on the base map, so dug holes don't deter the charge
  if (gy === ry && !G.runner.falling) {
    let x = gx;
    while (x !== rx) {
      const t = aiTileAt(x, gy);
      const below = gy + 1 >= ROWS ? T.SOLID : aiTileAt(x, gy + 1);
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
  // all probing below uses the guards' base-map view (aiTileAt): dug holes
  // are invisible, so guards happily plan routes straight across them
  const sideExit = (x, y) =>
    (x > 0 && (aiFootingAt(x - 1, y) || aiTileAt(x - 1, y) === T.ROPE)) ||
    (x < COLS - 1 && (aiFootingAt(x + 1, y) || aiTileAt(x + 1, y) === T.ROPE));

  // simulate dropping down from column x: where would we end up?
  const scanDown = (x, path) => {
    let y = gy;
    while (y < ROWS - 1 && !aiSolidAt(x, y + 1)) {
      // hanging onto a ladder/rope lets the guard exit sideways once level with the runner
      if (aiTileAt(x, y) !== T.EMPTY && sideExit(x, y) && y >= ry) break;
      y++;
    }
    consider(rate(x, y), path);
  };
  // simulate climbing the ladder at column x
  const scanUp = (x, path) => {
    let y = gy;
    while (y > 0 && aiTileAt(x, y) === T.LADDER) {
      y--;
      if (sideExit(x, y) && y <= ry) break;
    }
    consider(rate(x, y), path);
  };

  // find how far this floor extends (guards may drop off its ends);
  // the cells of the walking row itself use the live map (dug side-passages
  // are walkable) while the floor beneath uses the base map
  let x = gx;
  while (x > 0) {
    const t = tileAt(x - 1, gy);
    if (t === T.BRICK || t === T.SOLID) break;
    x--;
    if (!(t === T.LADDER || t === T.ROPE || aiFootingAt(x, gy))) break;
  }
  const leftEnd = x;
  x = gx;
  while (x < COLS - 1) {
    const t = tileAt(x + 1, gy);
    if (t === T.BRICK || t === T.SOLID) break;
    x++;
    if (!(t === T.LADDER || t === T.ROPE || aiFootingAt(x, gy))) break;
  }
  const rightEnd = x;

  // rate the guard's own column first, then sweep the floor from the far ends inward
  if (gy < ROWS - 1 && !aiSolidAt(gx, gy + 1)) scanDown(gx, 'down');
  if (aiTileAt(gx, gy) === T.LADDER) scanUp(gx, 'up');

  x = leftEnd;
  let path = 'left';
  while (true) {
    if (x === gx) {
      if (path === 'left' && rightEnd !== gx) { path = 'right'; x = rightEnd; }
      else break;
    }
    if (gy < ROWS - 1 && !aiSolidAt(x, gy + 1)) scanDown(x, path);
    if (aiTileAt(x, gy) === T.LADDER) scanUp(x, path);
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
    if (g.t <= 0) { g.state = 'exiting'; g.exitY = cy - 1; g.exitPhase = 'up'; }
    return;
  }

  if (g.state === 'exiting') {
    const ty = g.exitY;
    if (g.exitPhase === 'side') {
      // grace step: walk onto the floor beside the hole, immune to falling,
      // so we don't drop straight back into it
      const dx = g.exitTX - g.x;
      g.dir = Math.sign(dx) || g.dir;
      g.x += Math.sign(dx) * Math.min(Math.abs(dx), g.speed * dt);
      if (Math.abs(g.x - g.exitTX) < 0.005) {
        g.x = g.exitTX;
        g.state = 'normal'; g.exitPhase = null; g.next = null;
      }
      return;
    }
    // climb up to the fixed cell above the hole
    if (g.y > ty + 0.99) {
      // still fully inside: wait until the landing cell is clear
      if (guardBlocked(cx, ty, g) || ty < 0 ||
          G.guards.some(o => o !== g && o.state !== 'dead' && Math.round(o.x) === cx && Math.round(o.y) === ty)) {
        return;
      }
    }
    g.y -= CLIMB_SPEED * 0.8 * dt;
    if (g.y <= ty) {
      g.y = ty;
      // pick the exit side: toward the runner if that floor is open, else the other side
      const sideFree = (s) => !guardBlocked(cx + s, ty, g) &&
        !G.guards.some(o => o !== g && o.state === 'normal' &&
          Math.round(o.x) === cx + s && Math.round(o.y) === ty);
      const rdir = G.runner.x >= g.x ? 1 : -1;
      const side = sideFree(rdir) ? rdir : (sideFree(-rdir) ? -rdir : 0);
      if (side === 0) {
        // boxed in on both sides: give up the grace step
        g.state = 'normal'; g.exitPhase = null; g.next = null;
      } else {
        g.exitPhase = 'side';
        g.exitTX = cx + side;
        g.dir = side;
      }
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
      color: ['#b24a33', '#8a3423', '#d0714f'][Math.floor(Math.random() * 3)],
    });
  }
}
function spawnSparkle(cx, cy, color) {
  for (let i = 0; i < 16; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = 1 + Math.random() * 2.5;
    G.particles.push({
      x: cx, y: cy,
      vx: Math.cos(a) * s, vy: Math.sin(a) * s - 1,
      life: 0.4 + Math.random() * 0.35, maxLife: 0.7,
      size: 0.05 + Math.random() * 0.06,
      color, glow: true,
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

const sprites = {};  // prerendered layers
// actors are drawn into this scratch canvas first, then composited with an outline
const figCanvas = document.createElement('canvas');
const figCtx = figCanvas.getContext('2d');

function resize() {
  const stage = document.getElementById('stage');
  const availW = stage.clientWidth - 40, availH = stage.clientHeight - 40;
  S = Math.max(14, Math.floor(Math.min(availW / COLS, availH / ROWS)));
  DPR = window.devicePixelRatio || 1;
  canvas.style.width = COLS * S + 'px';
  canvas.style.height = ROWS * S + 'px';
  canvas.width = Math.round(COLS * S * DPR);
  canvas.height = Math.round(ROWS * S * DPR);
  figCanvas.width = figCanvas.height = Math.ceil(S * 3 * DPR);
  buildBackground();
  G.terrainDirty = true;
}
window.addEventListener('resize', resize);

// ---- deterministic per-cell randomness, so textures don't shimmer between rebuilds ----
function hashCell(x, y, salt) {
  let h = Math.imul(x + 101, 374761393) ^ Math.imul(y + 211, 668265263) ^ Math.imul(salt + 7, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}
function cellRng(x, y, salt) {
  let s = hashCell(x, y, salt) || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}
function rrect(g, x, y, w, h, r) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h);
}
// solid ground as far as surface lighting is concerned
function isGround(x, y) {
  if (y < 0) return false;
  const t = baseTile(x, y);
  return t === T.BRICK || t === T.SOLID || t === T.TRAP;
}

// ---- background: dim stone back wall, cool light from above ----
function buildBackground() {
  const c = sprites.bg || (sprites.bg = document.createElement('canvas'));
  c.width = canvas.width; c.height = canvas.height;
  const g = c.getContext('2d');
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
  const w = COLS * S, h = ROWS * S;
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#17223a');
  grad.addColorStop(0.55, '#0e1527');
  grad.addColorStop(1, '#080c17');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);

  // large staggered wall blocks, barely-there contrast
  const bw = S * 2, bh = S;
  for (let r = 0; r < ROWS; r++) {
    const off = (r % 2) * S;
    for (let i = -1; i <= COLS / 2; i++) {
      const rnd = cellRng(i, r, 5);
      const x = i * bw + off, y = r * bh, gap = Math.max(1, S * 0.06);
      rrect(g, x + gap / 2, y + gap / 2, bw - gap, bh - gap, S * 0.08);
      g.fillStyle = `rgba(130,160,220,${0.025 + rnd() * 0.035})`;
      g.fill();
      g.fillStyle = 'rgba(170,200,255,0.035)';
      g.fillRect(x + gap, y + gap / 2, bw - gap * 2, Math.max(1, S * 0.03));
      g.fillStyle = 'rgba(0,0,0,0.12)';
      g.fillRect(x + gap, y + bh - gap / 2 - Math.max(1, S * 0.04), bw - gap * 2, Math.max(1, S * 0.04));
      if (rnd() < 0.25) {
        // hairline crack
        g.strokeStyle = 'rgba(0,0,0,0.18)';
        g.lineWidth = Math.max(1, S * 0.02);
        g.beginPath();
        let cx = x + bw * (0.2 + rnd() * 0.6), cy = y + gap;
        g.moveTo(cx, cy);
        for (let k = 0; k < 3; k++) { cx += (rnd() - 0.5) * S * 0.5; cy += bh * 0.3; g.lineTo(cx, cy); }
        g.stroke();
      }
    }
  }

  // soft light shafts falling from above
  g.globalCompositeOperation = 'lighter';
  const shafts = [[0.18, 0.9], [0.52, 1.3], [0.82, 0.8]];
  for (const [fx, fw] of shafts) {
    const sx = w * fx, sw = S * 3 * fw;
    const lg = g.createLinearGradient(0, 0, 0, h * 0.95);
    lg.addColorStop(0, 'rgba(110,160,255,0.07)');
    lg.addColorStop(1, 'rgba(110,160,255,0)');
    g.fillStyle = lg;
    g.beginPath();
    g.moveTo(sx - sw * 0.35, 0); g.lineTo(sx + sw * 0.35, 0);
    g.lineTo(sx + sw * 0.35 + S * 5, h); g.lineTo(sx - sw * 0.35 + S * 3, h);
    g.closePath();
    g.fill();
  }
  const top = g.createRadialGradient(w / 2, -h * 0.25, 0, w / 2, -h * 0.25, h * 1.1);
  top.addColorStop(0, 'rgba(90,140,230,0.14)');
  top.addColorStop(1, 'rgba(90,140,230,0)');
  g.fillStyle = top;
  g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'source-over';

  // ground fog + vignette
  const fog = g.createLinearGradient(0, h * 0.6, 0, h);
  fog.addColorStop(0, 'rgba(3,5,10,0)');
  fog.addColorStop(1, 'rgba(3,5,10,0.45)');
  g.fillStyle = fog;
  g.fillRect(0, 0, w, h);
  const v = g.createRadialGradient(w / 2, h / 2, h * 0.45, w / 2, h / 2, h * 1.15);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.5)');
  g.fillStyle = v;
  g.fillRect(0, 0, w, h);
}

// ---- terrain tiles (drawn at absolute cell positions) ----
function drawBrick(g, x, y) {
  const px = x * S, py = y * S, rnd = cellRng(x, y, 11);
  g.fillStyle = '#2a120c';
  g.fillRect(px, py, S, S);
  const gap = Math.max(1, S * 0.045), ch = S / 3;
  const courses = [[0, 0.5, 1], [0, 0.25, 0.75, 1], [0, 0.5, 1]];
  const edge = Math.max(1, S * 0.028);
  for (let r = 0; r < 3; r++) {
    const xs = courses[r];
    for (let i = 0; i < xs.length - 1; i++) {
      const bx = px + xs[i] * S + gap / 2, by = py + r * ch + gap / 2;
      const bw = (xs[i + 1] - xs[i]) * S - gap, bh = ch - gap;
      const hue = 7 + rnd() * 10, sat = 48 + rnd() * 14, lit = 35 + rnd() * 10;
      const gr = g.createLinearGradient(0, by, 0, by + bh);
      gr.addColorStop(0, `hsl(${hue},${sat}%,${lit + 9}%)`);
      gr.addColorStop(1, `hsl(${hue},${sat}%,${lit - 6}%)`);
      g.fillStyle = gr;
      rrect(g, bx, by, bw, bh, S * 0.035);
      g.fill();
      // bevel: lit top edge, shaded bottom edge
      g.fillStyle = 'rgba(255,214,186,0.24)';
      g.fillRect(bx + edge, by, bw - edge * 2, edge);
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.fillRect(bx + edge * 0.5, by + bh - edge, bw - edge, edge);
      // grit
      const sz = Math.max(1, S * 0.03);
      for (let k = 0; k < 3; k++) {
        g.fillStyle = rnd() < 0.55 ? 'rgba(40,10,5,0.28)' : 'rgba(255,225,205,0.14)';
        g.fillRect(bx + rnd() * (bw - sz), by + edge + rnd() * (bh - sz - edge * 2), sz, sz);
      }
      if (rnd() < 0.2) {
        // chipped corner
        const cs = S * (0.05 + rnd() * 0.05), right = rnd() < 0.5;
        const cx = right ? bx + bw : bx;
        g.fillStyle = 'rgba(30,10,6,0.7)';
        g.beginPath();
        g.moveTo(cx, by); g.lineTo(cx + (right ? -cs : cs), by); g.lineTo(cx, by + cs);
        g.closePath();
        g.fill();
      }
    }
  }
  // exposed top surface catches the light
  if (!isGround(x, y - 1)) {
    const lg = g.createLinearGradient(0, py, 0, py + S * 0.18);
    lg.addColorStop(0, 'rgba(255,196,150,0.32)');
    lg.addColorStop(1, 'rgba(255,196,150,0)');
    g.fillStyle = lg;
    g.fillRect(px, py, S, S * 0.18);
    g.fillStyle = 'rgba(255,230,200,0.6)';
    g.fillRect(px, py, S, Math.max(1, S * 0.03));
  }
  if (!isGround(x, y + 1) && y + 1 < ROWS) {
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.fillRect(px, py + S * 0.9, S, S * 0.1);
  }
}

function drawSolid(g, x, y) {
  const px = x * S, py = y * S, rnd = cellRng(x, y, 23);
  const l = 29 + rnd() * 7;
  const gr = g.createLinearGradient(px, py, px + S, py + S);
  gr.addColorStop(0, `hsl(216,15%,${l + 7}%)`);
  gr.addColorStop(1, `hsl(222,18%,${l - 8}%)`);
  g.fillStyle = gr;
  g.fillRect(px, py, S, S);
  const b = S * 0.11;
  g.fillStyle = 'rgba(225,235,255,0.17)';
  g.beginPath();
  g.moveTo(px, py); g.lineTo(px + S, py); g.lineTo(px + S - b, py + b);
  g.lineTo(px + b, py + b); g.lineTo(px + b, py + S - b); g.lineTo(px, py + S);
  g.closePath(); g.fill();
  g.fillStyle = 'rgba(0,0,0,0.34)';
  g.beginPath();
  g.moveTo(px + S, py); g.lineTo(px + S, py + S); g.lineTo(px, py + S);
  g.lineTo(px + b, py + S - b); g.lineTo(px + S - b, py + S - b); g.lineTo(px + S - b, py + b);
  g.closePath(); g.fill();
  // mineral flecks
  const sz = Math.max(1, S * 0.028);
  for (let k = 0; k < 7; k++) {
    g.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.22)' : 'rgba(200,220,255,0.16)';
    g.fillRect(px + b + rnd() * (S - 2 * b - sz), py + b + rnd() * (S - 2 * b - sz), sz, sz);
  }
  if (rnd() < 0.35) {
    g.strokeStyle = 'rgba(8,12,20,0.55)';
    g.lineWidth = Math.max(1, S * 0.025);
    g.beginPath();
    let cx = px + b + rnd() * (S - 2 * b), cy = py + b;
    g.moveTo(cx, cy);
    for (let k = 0; k < 3; k++) { cx += (rnd() - 0.5) * S * 0.3; cy += (S - 2 * b) / 3; g.lineTo(cx, cy); }
    g.stroke();
  }
  g.strokeStyle = 'rgba(0,0,0,0.5)';
  g.lineWidth = Math.max(1, S * 0.025);
  g.strokeRect(px + 0.5, py + 0.5, S - 1, S - 1);
  if (!isGround(x, y - 1)) {
    g.fillStyle = 'rgba(210,228,255,0.45)';
    g.fillRect(px, py, S, Math.max(1, S * 0.03));
  }
}

function drawLadder(g, x, y) {
  const px = x * S, py = y * S;
  const railW = Math.max(2, S * 0.1);
  const lx = px + S * 0.17, rx = px + S * 0.83 - railW;
  // rungs sit behind the rails
  for (let i = 0; i < 3; i++) {
    const ry = py + S * (0.18 + i * 0.33), rh = Math.max(2, S * 0.08);
    const rg = g.createLinearGradient(0, ry - rh / 2, 0, ry + rh / 2);
    rg.addColorStop(0, '#dbe5f2');
    rg.addColorStop(0.5, '#9fb2cc');
    rg.addColorStop(1, '#5c6d88');
    g.fillStyle = rg;
    g.fillRect(lx + railW * 0.5, ry - rh / 2, rx - lx, rh);
  }
  for (const x0 of [lx, rx]) {
    const rg = g.createLinearGradient(x0, 0, x0 + railW, 0);
    rg.addColorStop(0, '#4f5f7a');
    rg.addColorStop(0.35, '#e2ebf7');
    rg.addColorStop(0.7, '#8397b4');
    rg.addColorStop(1, '#3d4a60');
    g.fillStyle = rg;
    g.fillRect(x0, py, railW, S);
  }
  // bolts where rungs meet rails
  g.fillStyle = 'rgba(40,52,72,0.8)';
  for (let i = 0; i < 3; i++) {
    const ry = py + S * (0.18 + i * 0.33);
    for (const x0 of [lx, rx]) {
      g.beginPath(); g.arc(x0 + railW / 2, ry, railW * 0.18, 0, 7); g.fill();
    }
  }
}

function drawRope(g, x, y) {
  const px = x * S, yy = y * S + S * 0.17;
  const th = Math.max(2, S * 0.085);
  const rg = g.createLinearGradient(0, yy - th / 2, 0, yy + th / 2);
  rg.addColorStop(0, '#f0d9a4');
  rg.addColorStop(0.5, '#c9a45f');
  rg.addColorStop(1, '#7c5a2b');
  g.fillStyle = rg;
  g.fillRect(px, yy - th / 2, S, th);
  // twisted strands
  g.strokeStyle = 'rgba(70,44,14,0.6)';
  g.lineWidth = Math.max(1, S * 0.022);
  g.beginPath();
  for (let i = 0; i < 6; i++) {
    const x0 = px + (i / 6) * S;
    g.moveTo(x0, yy - th / 2);
    g.lineTo(x0 + S / 10, yy + th / 2);
  }
  g.stroke();
  // rope ends get a knotted anchor where they meet a wall
  for (const s of [-1, 1]) {
    if (isGround(x + s, y)) {
      const ax = s < 0 ? px + S * 0.04 : px + S * 0.96;
      g.fillStyle = '#6d7c93';
      g.beginPath(); g.arc(ax, yy, th * 0.75, 0, 7); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.beginPath(); g.arc(ax - th * 0.2, yy - th * 0.2, th * 0.25, 0, 7); g.fill();
    }
  }
}

// static terrain + background, rebuilt only when the level, size or hidden ladders change
function buildTerrain() {
  const tc = sprites.tc || (sprites.tc = document.createElement('canvas'));
  tc.width = canvas.width; tc.height = canvas.height;
  const g = tc.getContext('2d');
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const b = G.tiles[y][x];
      if (b === T.BRICK || b === T.TRAP) drawBrick(g, x, y);
      else if (b === T.SOLID) drawSolid(g, x, y);
      else if (b === T.LADDER || (b === T.HLADDER && G.revealed)) drawLadder(g, x, y);
      else if (b === T.ROPE) drawRope(g, x, y);
    }
  }
  const L = sprites.terrain || (sprites.terrain = document.createElement('canvas'));
  L.width = canvas.width; L.height = canvas.height;
  const lg = L.getContext('2d');
  lg.drawImage(sprites.bg, 0, 0);
  // everything casts a soft shadow onto the back wall
  lg.save();
  lg.shadowColor = 'rgba(0,0,0,0.62)';
  lg.shadowBlur = S * 0.35 * DPR;
  lg.shadowOffsetX = S * 0.1 * DPR;
  lg.shadowOffsetY = S * 0.16 * DPR;
  lg.drawImage(tc, 0, 0);
  lg.restore();
  G.terrainDirty = false;
}

// ---- ambient dust drifting through the light (stateless: a function of time) ----
const MOTES = Array.from({ length: 46 }, (_, i) => {
  const r = cellRng(i, 3, 91);
  return { x: r() * COLS, y: r() * ROWS, vx: (r() - 0.5) * 0.25, vy: 0.08 + r() * 0.18,
           sz: 0.02 + r() * 0.035, ph: r() * 6.28, a: 0.15 + r() * 0.3 };
});
function drawMotes(t) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const m of MOTES) {
    const x = ((m.x + t * m.vx + Math.sin(t * 0.7 + m.ph) * 0.4) % COLS + COLS) % COLS;
    const y = ((m.y - t * m.vy) % ROWS + ROWS) % ROWS;
    const a = m.a * (0.6 + 0.4 * Math.sin(t * 1.3 + m.ph));
    ctx.fillStyle = `rgba(190,215,255,${a})`;
    ctx.beginPath();
    ctx.arc(x * S, y * S, Math.max(0.8, m.sz * S), 0, 7);
    ctx.fill();
  }
  ctx.restore();
}

// --- gold (drawn live: gentle bob, glow and a traveling glint) ---
function drawGold(x, y, t) {
  const pulse = 0.75 + 0.25 * Math.sin(t * 3 + x * 1.7 + y);
  const bob = Math.sin(t * 2.2 + x * 0.9 + y * 1.3) * S * 0.025;
  const cx = x * S + S / 2, base = y * S + S * 0.93 + bob;
  ctx.save();
  // bloom
  ctx.globalCompositeOperation = 'lighter';
  const glow = ctx.createRadialGradient(cx, base - S * 0.22, 0, cx, base - S * 0.22, S * 0.8);
  glow.addColorStop(0, `rgba(255,200,80,${0.3 * pulse})`);
  glow.addColorStop(1, 'rgba(255,200,80,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(cx - S, base - S * 1.1, S * 2, S * 1.4);
  ctx.globalCompositeOperation = 'source-over';
  // contact shadow
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(cx, y * S + S * 0.96, S * 0.36, S * 0.05, 0, 0, 7);
  ctx.fill();

  const iw = S * 0.34, ih = S * 0.17;
  const ingot = (x0, yb) => {
    const top = iw * 0.62;
    const grad = ctx.createLinearGradient(0, yb - ih, 0, yb);
    grad.addColorStop(0, '#fff3c4');
    grad.addColorStop(0.35, '#ffd257');
    grad.addColorStop(0.75, '#e0a21f');
    grad.addColorStop(1, '#9a650c');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(x0 - iw / 2, yb);
    ctx.lineTo(x0 - top / 2, yb - ih);
    ctx.lineTo(x0 + top / 2, yb - ih);
    ctx.lineTo(x0 + iw / 2, yb);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(80,48,0,0.75)';
    ctx.lineWidth = Math.max(1, S * 0.02);
    ctx.stroke();
    // polished top face
    ctx.fillStyle = 'rgba(255,252,225,0.75)';
    ctx.fillRect(x0 - top / 2 + 1, yb - ih, top - 2, Math.max(1, ih * 0.14));
    // diagonal specular stripe
    ctx.save();
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.beginPath();
    ctx.moveTo(x0 - iw * 0.18, yb); ctx.lineTo(x0 - iw * 0.02, yb - ih);
    ctx.lineTo(x0 + iw * 0.08, yb - ih); ctx.lineTo(x0 - iw * 0.08, yb);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };
  ingot(cx - iw * 0.52, base);
  ingot(cx + iw * 0.52, base);
  ingot(cx, base - ih);

  // glint: a four-point flare that sweeps across now and then
  const ph = (t * 0.55 + (hashCell(x, y, 3) % 1000) / 1000) % 1;
  if (ph < 0.3) {
    const k = Math.sin(ph / 0.3 * Math.PI);
    const gx = cx - iw * 0.6 + (ph / 0.3) * iw * 1.2, gy = base - ih * 1.55;
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(255,255,240,${0.9 * k})`;
    const r = S * 0.2 * k, n = r * 0.16;
    ctx.beginPath();
    ctx.moveTo(gx, gy - r); ctx.lineTo(gx + n, gy - n); ctx.lineTo(gx + r, gy);
    ctx.lineTo(gx + n, gy + n); ctx.lineTo(gx, gy + r); ctx.lineTo(gx - n, gy + n);
    ctx.lineTo(gx - r, gy); ctx.lineTo(gx - n, gy - n);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

// --- humanoid figure (runner + guards): jointed skeleton with shaded, volumetric limbs ---
// Drawn into figCtx (see drawActor). Legs and arms are two-bone chains (thigh/shin,
// upper arm/forearm); the run cycle is driven by distance traveled so feet don't slide.
function drawFigure(a, colors) {
  const ctx = figCtx;
  const px = a.x * S + S / 2;
  const py = a.y * S + S / 2;
  const h = S * 0.95;                     // figure height
  const dir = a.dir || 1;
  const ph = a.phase;

  let pose = 'stand';
  const cxr = Math.round(a.x), cyr = Math.round(a.y);
  if (a === G.runner && G.state === 'dying') pose = 'dying';
  else if (a.digT > 0) pose = 'dig';
  else if (a.state === 'trapped') pose = 'trapped';
  else if (a.state === 'spawning') pose = 'spawn';
  else if (a.falling) pose = 'fall';
  else {
    const onRope = ropeAt(cxr, cyr) && Math.abs(a.y - cyr) < 0.05;
    const offGrid = Math.abs(a.y - cyr) > 0.02;
    const movingX = a.guard ? (a.next && a.next[0] !== cxr) || a.state === 'exiting' : (Input.left || Input.right);
    // on a ladder the figure stays in the climbing pose for the whole trip,
    // including pauses mid-ladder; only a floor underfoot turns it back around
    const onLadderBody = ladderAt(cxr, Math.floor(a.y)) || ladderAt(cxr, Math.ceil(a.y));
    const floorBelow = cyr + 1 >= ROWS || solidAt(cxr, cyr + 1);
    const climbing = onLadderBody && (offGrid || (ladderAt(cxr, cyr) && !floorBelow));
    if (onRope) pose = movingX ? 'ropeMove' : 'rope';
    else if (movingX && !offGrid) pose = 'run';
    else if (climbing) pose = 'climb';
  }

  ctx.save();
  ctx.translate(px, py);
  if (pose === 'spawn') ctx.globalAlpha = 0.25 + 0.5 * Math.abs(Math.sin(ph * 2.4));
  if (pose === 'dying') {
    ctx.globalAlpha = Math.max(0, 1 - G.stateT / DIE_TIME);
    ctx.translate(0, -G.stateT * S * 0.6);
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // skeleton proportions
  const TH = h * 0.24, SH = h * 0.235;    // thigh, shin
  const UA = h * 0.165, FA = h * 0.16;    // upper arm, forearm
  const TORSO = h * 0.27, headR = h * 0.125;
  const limbW = h * 0.12;

  // forward kinematics: angles are measured from straight down, positive = toward facing
  const legFK = (hx, hy, th, kn) => {
    const kx = hx + Math.sin(th) * dir * TH, ky = hy + Math.cos(th) * TH;
    const sa = th - kn;
    return [[hx, hy], [kx, ky], [kx + Math.sin(sa) * dir * SH, ky + Math.cos(sa) * SH]];
  };
  const armFK = (sx, sy, ua, e) => {
    const ex = sx + Math.sin(ua) * dir * UA, ey = sy + Math.cos(ua) * UA;
    const fa = ua + e;
    return [[sx, sy], [ex, ey], [ex + Math.sin(fa) * dir * FA, ey + Math.cos(fa) * FA]];
  };
  // two-bone IK: reach a target, bending the middle joint to side s (+1 clockwise)
  const ik = (rx, ry, tx, ty, l1, l2, s) => {
    let dx = tx - rx, dy = ty - ry, d = Math.hypot(dx, dy);
    const maxd = (l1 + l2) * 0.999;
    if (d > maxd) { tx = rx + dx / d * maxd; ty = ry + dy / d * maxd; d = maxd; }
    d = Math.max(d, 1e-3);
    const c = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d);
    const ang = Math.acos(Math.max(-1, Math.min(1, c)));
    const base = Math.atan2(ty - ry, tx - rx);
    return [[rx, ry], [rx + Math.cos(base + s * ang) * l1, ry + Math.sin(base + s * ang) * l1], [tx, ty]];
  };

  let hipX = 0, hipY = h * 0.02, lean = 0.03;
  let legNear, legFar, armNear, armFar;
  let back = false;              // climbing shows the character's back
  let shadowScale = 1;

  const shoulderOf = () => [hipX + Math.sin(lean) * dir * TORSO, hipY - Math.cos(lean) * TORSO];

  switch (pose) {
    case 'run': {
      // one full stride every 1.7 tiles, phase tied to position
      const p = a.x * dir * (Math.PI * 2 / 1.7);
      const legAng = (q) => {
        const c = Math.cos(q);
        return [0.12 + 0.72 * Math.sin(q),
                0.25 + 1.35 * Math.pow(Math.max(0, c), 1.3) + 0.3 * Math.max(0, -c)];
      };
      // body is lowest at mid-stance, highest in flight
      hipY = h * 0.012 + h * 0.035 * Math.abs(Math.cos(p));
      lean = 0.2;
      shadowScale = 0.8 + 0.2 * Math.abs(Math.cos(p));
      const [n1, n2] = legAng(p), [f1, f2] = legAng(p + Math.PI);
      legNear = legFK(hipX, hipY, n1, n2);
      legFar = legFK(hipX, hipY, f1, f2);
      const [sx, sy] = shoulderOf();
      // arms counter-swing: the near arm follows the far leg
      const arm = (q) => [0.85 * Math.sin(q) - 0.1, 1.45 + 0.4 * Math.sin(q)];
      const [an1, an2] = arm(p + Math.PI), [af1, af2] = arm(p);
      armNear = armFK(sx, sy, an1, an2);
      armFar = armFK(sx - dir * h * 0.02, sy, af1, af2);
      break;
    }
    case 'climb': {
      back = true;
      // one full hand-foot cycle every two rungs, tied to height climbed
      const c = Math.sin(a.y * Math.PI * 3);
      hipY = h * 0.0;
      const shY = hipY - TORSO;
      const hy = shY - h * 0.15;
      // diagonal pairs move together: left hand with right foot, and vice versa;
      // elbows and knees point outward
      armFar = ik(-h * 0.1, shY, -h * 0.18, hy - c * h * 0.13, UA, FA, -1);
      armNear = ik(h * 0.1, shY, h * 0.18, hy + c * h * 0.13, UA, FA, 1);
      legFar = ik(-h * 0.055, hipY, -h * 0.1, h * 0.47 - Math.max(0, c) * h * 0.13, TH, SH, 1);
      legNear = ik(h * 0.055, hipY, h * 0.1, h * 0.47 - Math.max(0, -c) * h * 0.13, TH, SH, -1);
      shadowScale = 0;
      break;
    }
    case 'rope':
    case 'ropeMove': {
      const ropeY = -S * 0.33;
      hipY = h * 0.18; lean = 0;
      const shY = hipY - TORSO;
      let hn, hf;
      if (pose === 'ropeMove') {
        // hand over hand: each hand releases, swings past the other, and re-grips
        const t = a.x * Math.PI * 2.4;
        const s1 = Math.sin(t), s2 = Math.sin(t + Math.PI);
        hn = [s1 * h * 0.24, ropeY + (1 - Math.abs(s1)) * h * 0.09];
        hf = [s2 * h * 0.24, ropeY + (1 - Math.abs(s2)) * h * 0.09];
        const sway = Math.sin(t) * 0.12;
        legNear = legFK(hipX, hipY, 0.1 - sway, 0.7);
        legFar = legFK(hipX, hipY, 0.35 - sway, 0.9);
      } else {
        const c = Math.sin(ph * 0.8) * 0.06;
        hn = [dir * h * 0.13, ropeY];
        hf = [-dir * h * 0.1, ropeY];
        legNear = legFK(hipX, hipY, 0.25 + c, 0.6);
        legFar = legFK(hipX, hipY, 0.05 + c, 0.55);
      }
      // elbows point back and down while hanging
      armNear = ik(dir * h * 0.02, shY, hn[0], hn[1], UA, FA, -dir);
      armFar = ik(-dir * h * 0.02, shY, hf[0], hf[1], UA, FA, -dir);
      shadowScale = 0;
      break;
    }
    case 'fall': {
      const c = Math.sin(ph * 2) * 0.25;
      lean = -0.08;
      legNear = legFK(hipX, hipY, 0.55 + c, 1.2);
      legFar = legFK(hipX, hipY, -0.15 - c, 0.9);
      const [sx, sy] = shoulderOf();
      armNear = armFK(sx, sy, Math.PI - 0.6 + c, 0.35);
      armFar = armFK(sx, sy, Math.PI + 0.5 - c, -0.3);
      shadowScale = 0;
      break;
    }
    case 'dig': {
      // chopping swing driven by dig progress
      const p = 1 - Math.max(0, a.digT || 0) / DIG_TIME;
      const bob = Math.sin(p * Math.PI * 4) * h * 0.05;
      lean = 0.5 + bob / h;
      hipY = h * 0.08;
      legNear = legFK(hipX, hipY, 0.55, 1.05);
      legFar = legFK(hipX, hipY, -0.35, 0.45);
      const [sx, sy] = shoulderOf();
      armNear = ik(sx, sy, dir * h * 0.4, hipY + h * 0.12 + bob, UA, FA, dir);
      armFar = ik(sx - dir * h * 0.02, sy, dir * h * 0.22, hipY - h * 0.04 + bob, UA, FA, dir);
      break;
    }
    case 'trapped': {
      hipY = h * 0.32; lean = 0;
      const c = Math.sin(ph * 3) * h * 0.08;
      const shY = hipY - TORSO;
      armNear = ik(dir * h * 0.04, shY, dir * h * 0.24, shY - h * 0.24 + c, UA, FA, dir);
      armFar = ik(-dir * h * 0.04, shY, -dir * h * 0.2, shY - h * 0.24 - c, UA, FA, -dir);
      legNear = legFK(hipX, hipY, 0.3, 0.6);
      legFar = legFK(hipX, hipY, -0.2, 0.5);
      shadowScale = 0;
      break;
    }
    default: { // stand / spawn / dying: relaxed stance, gentle breathing
      const br = Math.sin(ph * 0.35) * h * 0.006;
      hipY = h * 0.02 + br;
      lean = 0.03;
      legNear = legFK(hipX, hipY, 0.07, 0.1);
      legFar = legFK(hipX, hipY, -0.07, 0.06);
      const [sx, sy] = shoulderOf();
      armNear = armFK(sx, sy + br, 0.1, 0.22);
      armFar = armFK(sx - dir * h * 0.02, sy + br, -0.08, 0.3);
    }
  }

  // contact shadow
  if (shadowScale > 0 && pose !== 'dying') {
    ctx.fillStyle = `rgba(0,0,0,${0.32 * shadowScale})`;
    ctx.beginPath();
    ctx.ellipse(0, h * 0.515, S * 0.26 * shadowScale, S * 0.055, 0, 0, 7);
    ctx.fill();
  }

  // ---- volumetric drawing helpers ----
  // a cylinder-ish segment: dark base, mid tone, and a thin highlight toward the light (upper-left/front)
  const seg = (x0, y0, x1, y1, w, dark, mid, light) => {
    ctx.strokeStyle = dark; ctx.lineWidth = w;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    const o = w * 0.1;
    ctx.strokeStyle = mid; ctx.lineWidth = w * 0.7;
    ctx.beginPath(); ctx.moveTo(x0 - o, y0 - o); ctx.lineTo(x1 - o, y1 - o); ctx.stroke();
    if (light) {
      const o2 = w * 0.2;
      ctx.strokeStyle = light; ctx.lineWidth = w * 0.22;
      ctx.beginPath(); ctx.moveTo(x0 - o2, y0 - o2); ctx.lineTo(x1 - o2, y1 - o2); ctx.stroke();
    }
  };
  const shade = (pts, w) => {   // far-side limbs sit in shadow
    ctx.strokeStyle = 'rgba(4,8,18,0.34)'; ctx.lineWidth = w;
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    ctx.lineTo(pts[1][0], pts[1][1]); ctx.lineTo(pts[2][0], pts[2][1]); ctx.stroke();
  };
  const drawShoe = (leg, far) => {
    const [kx, ky] = leg[1], [fx, fy] = leg[2];
    ctx.save();
    ctx.translate(fx, fy);
    if (back) {
      ctx.fillStyle = far ? colors.shoes : colors.shoesLight;
      ctx.beginPath(); ctx.ellipse(0, h * 0.01, h * 0.05, h * 0.035, 0, 0, 7); ctx.fill();
      ctx.restore();
      return;
    }
    ctx.scale(dir, 1);
    // toe points down when the shin trails behind the knee
    const shinBack = Math.atan2(-(fx - kx) * dir, fy - ky);
    ctx.rotate(Math.max(0, Math.min(0.9, shinBack * 0.8)));
    const sg = ctx.createLinearGradient(0, -h * 0.04, 0, h * 0.03);
    sg.addColorStop(0, colors.shoesLight);
    sg.addColorStop(1, colors.shoes);
    ctx.fillStyle = sg;
    rrect(ctx, -h * 0.045, -h * 0.04, h * 0.15, h * 0.065, h * 0.03);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(-h * 0.04, h * 0.014, h * 0.14, h * 0.012);
    if (far) { ctx.fillStyle = 'rgba(4,8,18,0.3)'; rrect(ctx, -h * 0.045, -h * 0.04, h * 0.15, h * 0.065, h * 0.03); ctx.fill(); }
    ctx.restore();
  };
  const drawLeg = (leg, far) => {
    const [[hx, hy], [kx, ky], [fx, fy]] = leg;
    seg(hx, hy, kx, ky, limbW * 1.1, colors.pantsDark, colors.pants, colors.pantsLight);
    seg(kx, ky, fx, fy, limbW, colors.pantsDark, colors.pants, colors.pantsLight);
    if (far) shade(leg, limbW * 1.1);
    drawShoe(leg, far);
  };
  const drawHand = (x, y) => {
    const r = h * 0.042;
    const hg = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r);
    hg.addColorStop(0, colors.skinLight);
    hg.addColorStop(1, colors.skinDark);
    ctx.fillStyle = hg;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  };
  const drawArm = (arm, far) => {
    const [[sx, sy], [ex, ey], [hx, hy]] = arm;
    seg(sx, sy, ex, ey, limbW * 0.92, colors.shirtDark, colors.shirt, colors.shirtLight);
    seg(ex, ey, hx, hy, limbW * 0.82, colors.shirtDark, colors.shirt, colors.shirtLight);
    drawHand(hx, hy);
    if (far) shade(arm, limbW * 0.95);
  };
  const drawTorso = () => {
    ctx.save();
    ctx.translate(hipX, hipY);
    ctx.rotate(lean * dir);
    if (!back) ctx.scale(dir, 1);
    const w0 = h * 0.095, w1 = back ? h * 0.145 : h * 0.115;
    const tg = ctx.createLinearGradient(-w1, 0, w1, 0);
    if (back) {
      tg.addColorStop(0, colors.shirtDark); tg.addColorStop(0.45, colors.shirt);
      tg.addColorStop(0.6, colors.shirtLight); tg.addColorStop(1, colors.shirtDark);
    } else {
      tg.addColorStop(0, colors.shirtDark); tg.addColorStop(0.55, colors.shirt);
      tg.addColorStop(0.85, colors.shirtLight); tg.addColorStop(1, colors.shirt);
    }
    ctx.fillStyle = tg;
    ctx.beginPath();
    ctx.moveTo(-w0, h * 0.03);
    ctx.lineTo(w0, h * 0.03);
    ctx.quadraticCurveTo(w1 * 1.05, -TORSO * 0.55, w1 * 0.75, -TORSO - h * 0.01);
    ctx.quadraticCurveTo(0, -TORSO - h * 0.045, -w1 * 0.85, -TORSO);
    ctx.quadraticCurveTo(-w1 * 1.05, -TORSO * 0.5, -w0, h * 0.03);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = Math.max(1, h * 0.012);
    ctx.stroke();
    // belt + buckle
    ctx.fillStyle = colors.belt;
    ctx.fillRect(-w0 * 1.02, -h * 0.02, w0 * 2.04, h * 0.05);
    if (!back) {
      ctx.fillStyle = colors.buckle;
      ctx.fillRect(w0 * 0.45, -h * 0.018, h * 0.035, h * 0.045);
    }
    ctx.restore();
  };
  const headPos = () => [hipX + Math.sin(lean) * dir * (TORSO + h * 0.15), hipY - Math.cos(lean) * (TORSO + h * 0.15)];
  const drawHead = () => {
    const [sx, sy] = shoulderOf();
    const [hx, hy] = headPos();
    // neck
    seg(sx, sy, hx, hy + headR * 0.5, h * 0.07, colors.skinDark, colors.skin, null);
    ctx.save();
    ctx.translate(hx, hy);
    if (!back) ctx.scale(dir, 1);
    const r = headR;
    const sg = ctx.createRadialGradient(r * 0.35, -r * 0.4, r * 0.1, 0, 0, r * 1.15);
    sg.addColorStop(0, colors.skinLight);
    sg.addColorStop(0.55, colors.skin);
    sg.addColorStop(1, colors.skinDark);
    ctx.fillStyle = sg;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill();
    const hg = ctx.createLinearGradient(0, -r, 0, r * 0.5);
    hg.addColorStop(0, colors.hairLight);
    hg.addColorStop(1, colors.hair);
    if (back) {
      // back of the head: hair all over, ears peeking out
      ctx.fillStyle = colors.skinDark;
      ctx.beginPath(); ctx.ellipse(-r * 0.95, r * 0.1, r * 0.18, r * 0.26, 0, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.ellipse(r * 0.95, r * 0.1, r * 0.18, r * 0.26, 0, 0, 7); ctx.fill();
      ctx.fillStyle = hg;
      ctx.beginPath(); ctx.arc(0, -r * 0.05, r * 1.02, 0, 7); ctx.fill();
    } else {
      // nose
      ctx.fillStyle = colors.skin;
      ctx.beginPath(); ctx.arc(r * 0.93, r * 0.12, r * 0.2, 0, 7); ctx.fill();
      // ear
      ctx.fillStyle = colors.skinDark;
      ctx.beginPath(); ctx.ellipse(-r * 0.15, r * 0.12, r * 0.17, r * 0.24, 0, 0, 7); ctx.fill();
      // hair over the top and back
      ctx.fillStyle = hg;
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.06, Math.PI * 0.62, Math.PI * 1.9);
      ctx.quadraticCurveTo(r * 0.3, -r * 0.45, -r * 0.3, -r * 0.2);
      ctx.quadraticCurveTo(-r * 0.5, r * 0.3, Math.cos(Math.PI * 0.62) * r * 1.06, Math.sin(Math.PI * 0.62) * r * 1.06);
      ctx.closePath();
      ctx.fill();
      // eye
      ctx.fillStyle = '#f4f6fa';
      ctx.beginPath(); ctx.ellipse(r * 0.5, -r * 0.05, r * 0.17, r * 0.22, 0, 0, 7); ctx.fill();
      ctx.fillStyle = colors.eye;
      ctx.beginPath(); ctx.arc(r * 0.58, -r * 0.03, r * 0.11, 0, 7); ctx.fill();
      // brow (guards scowl)
      ctx.strokeStyle = colors.hair;
      ctx.lineWidth = Math.max(1, r * 0.13);
      ctx.beginPath();
      if (colors.cap) { ctx.moveTo(r * 0.28, -r * 0.42); ctx.lineTo(r * 0.72, -r * 0.26); }
      else { ctx.moveTo(r * 0.3, -r * 0.34); ctx.lineTo(r * 0.7, -r * 0.36); }
      ctx.stroke();
      // mouth
      ctx.strokeStyle = 'rgba(90,40,30,0.7)';
      ctx.lineWidth = Math.max(1, r * 0.09);
      ctx.beginPath(); ctx.moveTo(r * 0.5, r * 0.5); ctx.lineTo(r * 0.75, r * 0.46); ctx.stroke();
    }
    // guards wear a peaked cap
    if (colors.cap) {
      const cg = ctx.createLinearGradient(0, -r * 1.2, 0, 0);
      cg.addColorStop(0, colors.capLight);
      cg.addColorStop(1, colors.cap);
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.arc(0, -r * 0.15, r * 1.08, Math.PI, Math.PI * 2);
      ctx.closePath();
      ctx.fill();
      if (!back) {
        ctx.fillStyle = colors.cap;
        rrect(ctx, r * 0.1, -r * 0.3, r * 1.4, r * 0.24, r * 0.1);
        ctx.fill();
      }
      ctx.fillStyle = colors.buckle;
      ctx.fillRect(back ? -r * 0.18 : r * 0.35, -r * 0.62, r * 0.3, r * 0.22);
    }
    ctx.restore();
  };

  // ---- paint back-to-front ----
  if (back) {
    drawLeg(legFar, false); drawLeg(legNear, false);
    drawTorso();
    drawHead();
    drawArm(armFar, false); drawArm(armNear, false);
  } else {
    drawArm(armFar, true);
    drawLeg(legFar, true);
    drawTorso();
    drawLeg(legNear, false);
    drawHead();
    drawArm(armNear, false);
  }

  // shovel while digging
  if (pose === 'dig') {
    const [hx1, hy1] = armNear[2];   // leading hand grips low on the shaft
    const [hx0, hy0] = armFar[2];
    const ang = Math.atan2(hy1 - hy0, hx1 - hx0);
    const tipX = hx1 + Math.cos(ang) * h * 0.2, tipY = hy1 + Math.sin(ang) * h * 0.2;
    ctx.strokeStyle = '#6e4a26';
    ctx.lineWidth = limbW * 0.42;
    ctx.beginPath();
    ctx.moveTo(hx0 - Math.cos(ang) * h * 0.1, hy0 - Math.sin(ang) * h * 0.1);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    ctx.strokeStyle = '#b08256';
    ctx.lineWidth = limbW * 0.14;
    ctx.stroke();
    ctx.save();
    ctx.translate(tipX, tipY);
    ctx.rotate(ang - Math.PI / 2);
    const bg2 = ctx.createLinearGradient(-h * 0.08, 0, h * 0.08, 0);
    bg2.addColorStop(0, '#8fa2b8');
    bg2.addColorStop(0.45, '#eef3f9');
    bg2.addColorStop(1, '#7d90a8');
    ctx.fillStyle = bg2;
    ctx.beginPath();
    ctx.moveTo(-h * 0.07, 0);
    ctx.lineTo(h * 0.07, 0);
    ctx.quadraticCurveTo(h * 0.09, h * 0.12, 0, h * 0.16);
    ctx.quadraticCurveTo(-h * 0.09, h * 0.12, -h * 0.07, 0);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(40,55,75,0.7)';
    ctx.lineWidth = Math.max(1, limbW * 0.15);
    ctx.stroke();
    ctx.restore();
  }

  // carried gold
  if (a.carry) {
    const [hx, hy] = headPos();
    const gy = hy - headR - h * 0.13;
    const gg = ctx.createLinearGradient(0, gy, 0, gy + h * 0.1);
    gg.addColorStop(0, '#fff0b0');
    gg.addColorStop(1, '#c98a14');
    ctx.fillStyle = gg;
    ctx.strokeStyle = 'rgba(90,60,0,0.7)';
    ctx.lineWidth = Math.max(1, h * 0.012);
    ctx.beginPath();
    ctx.moveTo(hx - h * 0.12, gy + h * 0.1); ctx.lineTo(hx - h * 0.07, gy);
    ctx.lineTo(hx + h * 0.07, gy); ctx.lineTo(hx + h * 0.12, gy + h * 0.1);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

const RUNNER_COLORS = {
  skin: '#efc39a', skinLight: '#ffe2c8', skinDark: '#b27b52',
  hair: '#4f321d', hairLight: '#8a5a36', eye: '#1c2430',
  shirt: '#e9eff8', shirtLight: '#ffffff', shirtDark: '#8d9fba',
  pants: '#3b73b3', pantsLight: '#79a8dd', pantsDark: '#1f3f66',
  shoes: '#23272f', shoesLight: '#56606f',
  belt: '#5a3c22', buckle: '#f2b632', cap: null,
};
const GUARD_COLORS = {
  skin: '#d9a171', skinLight: '#f3c79b', skinDark: '#94623e',
  hair: '#231a16', hairLight: '#4a3a31', eye: '#141a22',
  shirt: '#d44a3e', shirtLight: '#ff8c74', shirtDark: '#86251f',
  pants: '#3d3431', pantsLight: '#6a5b55', pantsDark: '#1e1816',
  shoes: '#14100e', shoesLight: '#40352f',
  belt: '#1a1412', buckle: '#c9ccd4', cap: '#2c3748', capLight: '#5a6d88',
};

// draw an actor via the scratch canvas so the whole figure gets one crisp dark outline
function drawActor(a, colors) {
  const box = S * 3;
  const ax = a.x * S + S / 2, ay = a.y * S + S / 2;
  // soft light around each actor: warm for the runner, a red menace for guards
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const lr = a.guard ? S * 1.3 : S * 2.4;
  const lg = ctx.createRadialGradient(ax, ay, 0, ax, ay, lr);
  lg.addColorStop(0, a.guard ? 'rgba(255,70,50,0.10)' : 'rgba(255,215,150,0.13)');
  lg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = lg;
  ctx.fillRect(ax - lr, ay - lr, lr * 2, lr * 2);
  ctx.restore();

  figCtx.setTransform(1, 0, 0, 1, 0, 0);
  figCtx.clearRect(0, 0, figCanvas.width, figCanvas.height);
  figCtx.setTransform(DPR, 0, 0, DPR, (box / 2 - ax) * DPR, (box / 2 - ay) * DPR);
  drawFigure(a, colors);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.shadowColor = 'rgba(2,4,8,0.95)';
  ctx.shadowBlur = Math.max(1.5, S * 0.07) * DPR;
  ctx.drawImage(figCanvas, Math.round((ax - box / 2) * DPR), Math.round((ay - box / 2) * DPR));
  ctx.restore();
}

// --- frame ---
function render() {
  if (G.terrainDirty) buildTerrain();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(sprites.terrain, 0, 0);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

  const t = G.time;

  // dynamic terrain: holes being dug, open, or closing
  for (const h of G.holes.values()) {
    const px = h.x * S, py = h.y * S;
    if (h.opening) {
      // brick being shoveled out: excavation grows from the top down
      const p = Math.min(1, h.openT / DIG_TIME);
      ctx.save();
      ctx.beginPath();
      ctx.rect(px, py, S, S * p);
      ctx.clip();
      drawHole(px, py);
      ctx.restore();
      // cracks spreading ahead of the excavation
      ctx.strokeStyle = 'rgba(20,8,5,0.7)';
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
      drawBrick(ctx, h.x, h.y);
      ctx.restore();
    } else {
      drawHole(px, py);
      if (h.age > HOLE_LIFE - 1.0) {
        // warning glow just before it closes
        const a = 0.18 + 0.14 * Math.sin(t * 14);
        const wg = ctx.createLinearGradient(0, py, 0, py + S);
        wg.addColorStop(0, `rgba(255,90,70,${a})`);
        wg.addColorStop(1, `rgba(255,90,70,${a * 0.2})`);
        ctx.fillStyle = wg;
        ctx.fillRect(px, py, S, S);
      }
    }
  }

  // freshly revealed escape ladders flash gold
  if (G.revealFlash > 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(255,200,80,${G.revealFlash * 0.5})`;
    for (let y = 0; y < ROWS; y++)
      for (let x = 0; x < COLS; x++)
        if (G.tiles[y][x] === T.HLADDER) ctx.fillRect(x * S, y * S, S, S);
    ctx.restore();
  }

  drawMotes(t);

  // gold
  for (let y = 0; y < ROWS; y++)
    for (let x = 0; x < COLS; x++)
      if (G.goldMap[y][x]) drawGold(x, y, t);

  // actors
  for (const g of G.guards) if (g.state !== 'dead') drawActor(g, GUARD_COLORS);
  if (G.state !== 'wipeout') drawActor(G.runner, RUNNER_COLORS);

  // particles
  ctx.save();
  for (const p of G.particles) {
    const a = Math.max(0, p.life / p.maxLife);
    const sz = p.size * S;
    const x = p.x * S + S / 2, y = p.y * S + S / 2;
    if (p.glow) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = a;
      const gg = ctx.createRadialGradient(x, y, 0, x, y, sz * 3);
      gg.addColorStop(0, p.color);
      gg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gg;
      ctx.fillRect(x - sz * 3, y - sz * 3, sz * 6, sz * 6);
      ctx.fillStyle = '#fffbe8';
      ctx.fillRect(x - sz * 0.4, y - sz * 0.4, sz * 0.8, sz * 0.8);
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
    }
  }
  ctx.restore();

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
    ctx.strokeStyle = 'rgba(242,182,50,0.45)';
    ctx.lineWidth = Math.max(1.5, S * 0.06);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // overlays
  if (G.state === 'ready') {
    banner(`LEVEL ${String(G.level + 1).padStart(3, '0')}`, 'PRESS ANY MOVEMENT KEY TO BEGIN');
  } else if (G.state === 'won') {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(255,200,90,${0.1 * Math.sin(G.stateT * 10) + 0.1})`;
    ctx.fillRect(0, 0, COLS * S, ROWS * S);
    ctx.restore();
    banner('LEVEL CLEAR', `+${SCORE_LEVEL} BONUS`);
  }
}

// an open dug hole: dark pit with cut brick walls and rubble at the bottom
function drawHole(px, py) {
  const pit = ctx.createLinearGradient(0, py, 0, py + S);
  pit.addColorStop(0, '#1c0d09');
  pit.addColorStop(1, '#060304');
  ctx.fillStyle = pit;
  ctx.fillRect(px, py, S, S);
  // cut faces of the surrounding bricks
  const wall = S * 0.12;
  const lw = ctx.createLinearGradient(px, 0, px + wall, 0);
  lw.addColorStop(0, 'rgba(150,62,42,0.75)');
  lw.addColorStop(1, 'rgba(150,62,42,0)');
  ctx.fillStyle = lw;
  ctx.fillRect(px, py, wall, S);
  const rw = ctx.createLinearGradient(px + S - wall, 0, px + S, 0);
  rw.addColorStop(0, 'rgba(60,20,12,0)');
  rw.addColorStop(1, 'rgba(60,20,12,0.85)');
  ctx.fillStyle = rw;
  ctx.fillRect(px + S - wall, py, wall, S);
  // jagged broken lip along the top
  ctx.fillStyle = '#8c3a28';
  ctx.beginPath();
  ctx.moveTo(px, py);
  const n = 6;
  for (let i = 0; i <= n; i++) {
    const jx = px + (i / n) * S;
    const jy = py + S * (0.03 + ((i * 7 + 3) % 4) * 0.022);
    ctx.lineTo(jx, jy);
  }
  ctx.lineTo(px + S, py);
  ctx.closePath();
  ctx.fill();
  // rubble
  ctx.fillStyle = 'rgba(120,48,32,0.7)';
  for (let i = 0; i < 5; i++) {
    const rx = px + S * (0.14 + i * 0.18), rs = S * (0.05 + ((i * 5) % 3) * 0.02);
    ctx.beginPath();
    ctx.ellipse(rx, py + S - rs * 0.5, rs, rs * 0.6, 0, Math.PI, 0);
    ctx.fill();
  }
}

function banner(title, sub) {
  const w = COLS * S, h = ROWS * S;
  const pw = Math.min(w * 0.6, S * 15), ph = S * 3.1;
  const x0 = (w - pw) / 2, y0 = h * 0.5 - ph / 2;
  ctx.save();
  ctx.fillStyle = 'rgba(3,6,12,0.35)';
  ctx.fillRect(0, 0, w, h);
  ctx.shadowColor = 'rgba(0,0,0,0.7)';
  ctx.shadowBlur = S * 0.9;
  const pg = ctx.createLinearGradient(0, y0, 0, y0 + ph);
  pg.addColorStop(0, 'rgba(30,41,64,0.94)');
  pg.addColorStop(1, 'rgba(14,20,34,0.94)');
  ctx.fillStyle = pg;
  rrect(ctx, x0, y0, pw, ph, S * 0.3);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(242,182,50,0.45)';
  ctx.lineWidth = Math.max(1, S * 0.035);
  ctx.stroke();
  ctx.fillStyle = '#f2b632';
  ctx.fillRect(x0 + pw * 0.32, y0 - Math.max(1, S * 0.03), pw * 0.36, Math.max(2, S * 0.07));

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${S * 0.1}px`;
  const tg = ctx.createLinearGradient(0, y0 + ph * 0.22, 0, y0 + ph * 0.58);
  tg.addColorStop(0, '#ffe7a0');
  tg.addColorStop(1, '#e8a526');
  ctx.fillStyle = tg;
  ctx.font = `800 ${S * 1.15}px "Segoe UI", system-ui, sans-serif`;
  ctx.shadowColor = 'rgba(242,182,50,0.55)';
  ctx.shadowBlur = S * 0.5;
  ctx.fillText(title, w / 2, y0 + ph * 0.42);
  ctx.shadowBlur = 0;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${S * 0.08}px`;
  ctx.fillStyle = `rgba(170,184,206,${0.65 + 0.35 * Math.sin(G.time * 3)})`;
  ctx.font = `600 ${S * 0.36}px "Segoe UI", system-ui, sans-serif`;
  ctx.fillText(sub, w / 2, y0 + ph * 0.76);
  ctx.restore();
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
const goldBar = document.getElementById('hud-gold-bar');
function setHud(el, v) { if (hudCache[el] !== v) { hudCache[el] = v; hudEls[el].textContent = v; } }
function updateHud() {
  setHud('level', String(G.level + 1).padStart(3, '0'));
  setHud('score', String(G.score));
  setHud('hi', String(Math.max(SAVE.hi, G.score)));
  setHud('gold', `${G.goldTotal - G.goldLeft}/${G.goldTotal}`);
  setHud('lives', String(G.lives));
  const pct = G.goldTotal ? Math.round(100 * (G.goldTotal - G.goldLeft) / G.goldTotal) : 0;
  if (hudCache.bar !== pct) { hudCache.bar = pct; goldBar.style.width = pct + '%'; }
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
