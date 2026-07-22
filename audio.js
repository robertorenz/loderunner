// ============ Lode Runner HD — WebAudio synthesized sound effects ============
const Sfx = (() => {
  let ctx = null;
  let enabled = true;
  let master = null;

  function ensure() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = 0.25;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, dur, { type = 'square', vol = 1, attack = 0.004, slideTo = null, delay = 0 } = {}) {
    if (!enabled) return;
    const c = ensure();
    const t0 = c.currentTime + delay;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  function noise(dur, { vol = 1, freq = 900, delay = 0 } = {}) {
    if (!enabled) return;
    const c = ensure();
    const t0 = c.currentTime + delay;
    const len = Math.max(1, Math.floor(c.sampleRate * dur));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = 0.8;
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t0);
  }

  return {
    setEnabled(v) { enabled = v; if (v) ensure(); },
    get enabled() { return enabled; },
    unlock() { ensure(); },

    gold()      { tone(880, 0.07, { type: 'square', vol: 0.5 });
                  tone(1320, 0.09, { type: 'square', vol: 0.5, delay: 0.06 });
                  tone(1760, 0.14, { type: 'square', vol: 0.45, delay: 0.12 }); },
    dig()       { noise(0.16, { vol: 0.7, freq: 700 });
                  tone(160, 0.12, { type: 'triangle', vol: 0.6, slideTo: 60 }); },
    step()      { noise(0.03, { vol: 0.12, freq: 1800 }); },
    fall()      { tone(700, 0.25, { type: 'triangle', vol: 0.25, slideTo: 220 }); },
    land()      { noise(0.06, { vol: 0.3, freq: 400 }); },
    trap()      { tone(300, 0.18, { type: 'sawtooth', vol: 0.35, slideTo: 120 });
                  noise(0.14, { vol: 0.4, freq: 500, delay: 0.03 }); },
    guardDie()  { tone(500, 0.3, { type: 'sawtooth', vol: 0.35, slideTo: 90 }); },
    die()       { tone(600, 0.16, { type: 'square', vol: 0.5, slideTo: 400 });
                  tone(400, 0.2, { type: 'square', vol: 0.5, slideTo: 200, delay: 0.14 });
                  tone(200, 0.5, { type: 'square', vol: 0.5, slideTo: 60, delay: 0.3 }); },
    reveal()    { for (let i = 0; i < 5; i++) tone(700 + i * 180, 0.1, { type: 'triangle', vol: 0.4, delay: i * 0.05 }); },
    win()       { const n = [523, 659, 784, 1047, 784, 1047, 1319];
                  n.forEach((f, i) => tone(f, 0.15, { type: 'square', vol: 0.45, delay: i * 0.11 })); },
    gameOver()  { const n = [392, 370, 349, 330, 311, 294];
                  n.forEach((f, i) => tone(f, 0.22, { type: 'square', vol: 0.4, delay: i * 0.17 })); },
    respawn()   { tone(200, 0.2, { type: 'triangle', vol: 0.3, slideTo: 600 }); },
  };
})();
