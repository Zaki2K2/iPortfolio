/**
 * Living Developer Universe
 * A lightweight Canvas 2D / pseudo-3D network of "services" with flowing
 * request particles. No dependencies. Pauses when off-screen or when the tab
 * is hidden, and renders a single static frame for prefers-reduced-motion.
 */
(() => {
  'use strict';

  const hero = document.getElementById('hero');
  const canvas = document.getElementById('hu-canvas');
  if (!hero || !canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const COLORS = {
    cyan: [34, 211, 238],
    blue: [59, 130, 246],
    violet: [139, 92, 246]
  };

  // The architecture: major services and how they connect.
  const MAJORS = [
    { id: 'gateway', label: 'API Gateway', p: [0, 0, 0], r: 15, c: 'cyan' },
    { id: 'auth', label: 'Authentication', short: 'Auth', p: [-0.72, -0.58, 0.35], r: 11, c: 'violet' },
    { id: 'node', label: 'Node.js', p: [0.55, -0.55, -0.2], r: 13, c: 'cyan' },
    { id: 'redis', label: 'Redis', p: [1.0, 0.05, 0.4], r: 10, c: 'blue' },
    { id: 'mongo', label: 'MongoDB', p: [0.4, 0.78, -0.3], r: 11, c: 'cyan' },
    { id: 'docker', label: 'Docker', p: [-0.45, 0.7, 0.42], r: 10, c: 'blue' },
    { id: 'cloud', label: 'Cloud Infrastructure', short: 'Cloud', p: [-1.0, 0.02, -0.5], r: 13, c: 'violet' }
  ];
  const LINKS = [
    ['gateway', 'auth'], ['gateway', 'node'], ['gateway', 'docker'], ['gateway', 'cloud'],
    ['node', 'redis'], ['node', 'mongo'], ['auth', 'redis'], ['docker', 'cloud'],
    ['docker', 'mongo'], ['cloud', 'auth']
  ];

  const CAMERA = 3.4;
  const PULSE_SPEED = 0.42; // seconds per hop

  let nodes = [];
  let edges = [];
  let adjacency = [];
  let particles = [];
  let maxHop = 0;

  let width = 0;
  let height = 0;
  let dpr = 1;
  let scale3d = 100;
  let isCompact = false;

  let time = 0;
  let last = 0;
  let raf = 0;
  let running = false;
  let heroVisible = true;

  // Pointer state (smoothed)
  let pointerActive = false;
  let ptX = 0;
  let ptY = 0;
  let targetMx = 0;
  let targetMy = 0;
  let mx = 0;
  let my = 0;
  let hoverNode = null;

  let pulseStart = -1;
  let nextPulse = 3.4;

  const sprites = {};

  /* ---------- helpers ---------- */
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  function makeSprites() {
    Object.keys(COLORS).forEach((key) => {
      const c = COLORS[key];
      const glow = document.createElement('canvas');
      glow.width = glow.height = 128;
      const g = glow.getContext('2d');
      const gg = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      gg.addColorStop(0, rgba(c, 0.85));
      gg.addColorStop(0.25, rgba(c, 0.32));
      gg.addColorStop(0.6, rgba(c, 0.08));
      gg.addColorStop(1, rgba(c, 0));
      g.fillStyle = gg;
      g.fillRect(0, 0, 128, 128);

      const sphere = document.createElement('canvas');
      sphere.width = sphere.height = 128;
      const s = sphere.getContext('2d');
      const sg = s.createRadialGradient(46, 42, 4, 64, 64, 62);
      sg.addColorStop(0, 'rgba(255,255,255,0.95)');
      sg.addColorStop(0.3, rgba(c, 0.95));
      sg.addColorStop(1, rgba([c[0] * 0.25, c[1] * 0.25, c[2] * 0.4].map(Math.round), 1));
      s.fillStyle = sg;
      s.beginPath();
      s.arc(64, 64, 62, 0, Math.PI * 2);
      s.fill();

      sprites[key] = { glow, sphere };
    });
  }

  /* ---------- graph construction ---------- */
  function build() {
    const rand = mulberry32(20241);
    const minorCount = isCompact ? 6 : 16;
    nodes = MAJORS.map((m, i) => makeNode(m.id, m.label, m.p, m.r, m.c, true, i, rand, m.short));

    let guard = 0;
    while (nodes.length < MAJORS.length + minorCount && guard++ < 400) {
      const rad = 0.55 + rand() * 0.75;
      const th = rand() * Math.PI * 2;
      const ph = Math.acos(2 * rand() - 1);
      const p = [rad * Math.sin(ph) * Math.cos(th), rad * Math.cos(ph) * 0.85, rad * Math.sin(ph) * Math.sin(th) * 0.8];
      if (nodes.some((n) => dist3(n.t, p) < 0.3)) continue;
      const keys = ['cyan', 'blue', 'blue', 'violet'];
      nodes.push(makeNode('m' + nodes.length, '', p, 2.6 + rand() * 3.2, keys[Math.floor(rand() * keys.length)], false, nodes.length, rand));
    }

    edges = [];
    const byId = {};
    nodes.forEach((n, i) => { byId[n.id] = i; });
    const seen = new Set();
    const addEdge = (a, b) => {
      const k = a < b ? a + '-' + b : b + '-' + a;
      if (a === b || seen.has(k)) return;
      seen.add(k);
      edges.push({ a, b, h: 0, bend: rand() < 0.5 ? -1 : 1, p: 0 });
    };
    LINKS.forEach(([x, y]) => addEdge(byId[x], byId[y]));
    for (let i = MAJORS.length; i < nodes.length; i++) {
      const order = nodes
        .map((n, j) => ({ j, d: j === i ? Infinity : dist3(n.t, nodes[i].t) }))
        .sort((p, q) => p.d - q.d);
      addEdge(i, order[0].j);
      if (order[1] && order[1].d < 0.75) addEdge(i, order[1].j);
    }

    adjacency = nodes.map(() => []);
    edges.forEach((e, idx) => {
      adjacency[e.a].push(idx);
      adjacency[e.b].push(idx);
    });

    // Hop distance from the gateway drives the pulse wave.
    const hops = nodes.map(() => Infinity);
    hops[0] = 0;
    const queue = [0];
    while (queue.length) {
      const cur = queue.shift();
      adjacency[cur].forEach((ei) => {
        const e = edges[ei];
        const nb = e.a === cur ? e.b : e.a;
        if (hops[nb] === Infinity) { hops[nb] = hops[cur] + 1; queue.push(nb); }
      });
    }
    maxHop = 0;
    nodes.forEach((n, i) => {
      n.hop = hops[i] === Infinity ? 3 : hops[i];
      maxHop = Math.max(maxHop, n.hop);
    });

    // Particles
    particles = [];
    const count = isCompact ? 14 : 44;
    for (let i = 0; i < count; i++) spawnParticle(rand);
  }

  function makeNode(id, label, p, r, colorKey, major, index, rand, short) {
    const dir = [rand() - 0.5, rand() - 0.5, rand() - 0.5];
    const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const far = 2.4 + rand() * 0.8;
    return {
      id, label, short, major, r, color: colorKey, c: COLORS[colorKey],
      t: p.slice(),
      s: [dir[0] / len * far, dir[1] / len * far, dir[2] / len * far],
      phase: rand() * Math.PI * 2,
      speed: 0.25 + rand() * 0.35,
      delay: 0.1 + index * 0.05 + rand() * 0.25,
      p: 0, hover: 0, pulse: 0, ax: 0, ay: 0,
      px: 0, py: 0, sc: 1, depth: 0.5
    };
  }

  function spawnParticle(rand) {
    const edge = Math.floor(rand() * edges.length);
    particles.push({
      edge,
      fromA: rand() < 0.5,
      t: rand(),
      speed: 0.16 + rand() * 0.2,
      prev: -1,
      c: COLORS[['cyan', 'cyan', 'blue', 'violet'][Math.floor(rand() * 4)]]
    });
  }

  const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  /* ---------- sizing ---------- */
  function resize() {
    const rect = canvas.getBoundingClientRect();
    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));
    const compact = width < 600;
    dpr = Math.min(window.devicePixelRatio || 1, compact ? 1.5 : 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    scale3d = Math.min(width * (compact ? 0.27 : 0.3), height * 0.36);
    if (compact !== isCompact || !nodes.length) {
      isCompact = compact;
      build();
    }
    if (!running) renderStatic();
  }

  /* ---------- simulation ---------- */
  function project(n, dt) {
    const k = clampEase(time, n);
    n.p = k;
    const e = easeOutCubic(k);
    const fl = 0.04;
    const x = lerp(n.s[0], n.t[0], e) + Math.sin(time * n.speed + n.phase) * fl;
    const y = lerp(n.s[1], n.t[1], e) + Math.cos(time * n.speed * 0.9 + n.phase * 1.3) * fl;
    const z = lerp(n.s[2], n.t[2], e) + Math.sin(time * n.speed * 0.7 + n.phase * 0.6) * fl;

    const yaw = Math.sin(time * 0.15) * 0.28 + mx * 0.32;
    const pitch = -0.12 + my * 0.18 + Math.sin(time * 0.11) * 0.05;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const x1 = x * cy + z * sy;
    const z1 = -x * sy + z * cy;
    const y2 = y * cp - z1 * sp;
    const z2 = y * sp + z1 * cp;

    const persp = CAMERA / (CAMERA - z2);
    n.sc = persp;
    n.depth = clamp((z2 + 1.3) / 2.6, 0, 1);
    n.px = width / 2 + x1 * scale3d * persp;
    n.py = height / 2 + y2 * scale3d * persp;

    // Gentle localized attraction toward the cursor.
    let tx = 0, ty = 0;
    if (pointerActive) {
      const dx = ptX - n.px, dy = ptY - n.py;
      const d = Math.hypot(dx, dy);
      if (d < 170 && d > 0.001) {
        const pull = Math.pow(1 - d / 170, 2) * 16;
        tx = dx / d * pull;
        ty = dy / d * pull;
      }
    }
    const a = 1 - Math.exp(-dt * 4);
    n.ax += (tx - n.ax) * a;
    n.ay += (ty - n.ay) * a;
    n.px += n.ax;
    n.py += n.ay;
  }

  const lerp = (a, b, t) => a + (b - a) * t;
  const clampEase = (t, n) => clamp((t - n.delay) / 1.8, 0, 1);

  function update(dt) {
    const sm = 1 - Math.exp(-dt * 3);
    mx += (targetMx - mx) * sm;
    my += (targetMy - my) * sm;

    nodes.forEach((n) => project(n, dt));

    // Hover: nearest settled node under the cursor.
    hoverNode = null;
    if (pointerActive) {
      let best = Infinity;
      nodes.forEach((n) => {
        if (n.p < 0.95) return;
        const d = Math.hypot(ptX - n.px, ptY - n.py);
        const reach = Math.max(26, n.r * n.sc * 2.6);
        if (d < reach && d < best) { best = d; hoverNode = n; }
      });
    }
    const hk = 1 - Math.exp(-dt * 6);
    nodes.forEach((n) => { n.hover += ((n === hoverNode ? 1 : 0) - n.hover) * hk; });

    // Pulse wave from the gateway outward.
    if (time >= nextPulse) {
      pulseStart = time;
      nextPulse = time + 7 + Math.random() * 2;
    }
    const tau = pulseStart < 0 ? -1 : time - pulseStart;
    nodes.forEach((n) => {
      if (tau < 0 || tau > (maxHop + 3) * PULSE_SPEED) { n.pulse = 0; return; }
      const front = tau / PULSE_SPEED;
      n.pulse = Math.exp(-Math.pow(n.hop - front, 2) / 0.45);
    });

    edges.forEach((e) => {
      const na = nodes[e.a], nb = nodes[e.b];
      e.p = Math.min(na.p, nb.p);
      const target = hoverNode && (na === hoverNode || nb === hoverNode) ? 1 : 0;
      e.h += (target - e.h) * hk;
      e.pulse = (na.pulse + nb.pulse) / 2;
    });

    particles.forEach((p) => {
      const edge = edges[p.edge];
      if (edge.p < 0.98) return;
      p.t += p.speed * dt;
      if (p.t >= 1) {
        const endNode = p.fromA ? edge.b : edge.a;
        const options = adjacency[endNode].filter((i) => i !== p.edge);
        const pool = options.length ? options : adjacency[endNode];
        const next = pool[Math.floor(Math.random() * pool.length)];
        p.edge = next;
        p.fromA = edges[next].a === endNode;
        p.t = 0;
      }
    });
  }

  /* ---------- drawing ---------- */
  function controlPoint(e) {
    const a = nodes[e.a], b = nodes[e.b];
    const mxp = (a.px + b.px) / 2, myp = (a.py + b.py) / 2;
    const dx = b.px - a.px, dy = b.py - a.py;
    const len = Math.hypot(dx, dy) || 1;
    const off = len * 0.09 * e.bend;
    return [mxp - dy / len * off, myp + dx / len * off];
  }

  function bez(a, b, c, t) {
    const u = 1 - t;
    return [u * u * a.px + 2 * u * t * c[0] + t * t * b.px, u * u * a.py + 2 * u * t * c[1] + t * t * b.py];
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'lighter';

    const dim = hoverNode ? 0.7 : 1;

    // Connections
    edges.forEach((e) => {
      if (e.p <= 0.01) return;
      const a = nodes[e.a], b = nodes[e.b];
      const c = controlPoint(e);
      e.cp = c;
      const depth = (a.depth + b.depth) / 2;
      let alpha = 0.13 + 0.2 * depth;
      alpha += e.h * 0.5 + e.pulse * 0.55;
      if (hoverNode && e.h < 0.05) alpha *= dim;
      alpha *= e.p * e.p;
      ctx.strokeStyle = rgba(e.h > 0.05 || e.pulse > 0.1 ? [140, 215, 255] : [110, 165, 235], clamp(alpha, 0, 1));
      ctx.lineWidth = 0.6 + depth * 0.7 + e.h * 0.8;
      ctx.beginPath();
      ctx.moveTo(a.px, a.py);
      ctx.quadraticCurveTo(c[0], c[1], b.px, b.py);
      ctx.stroke();
    });

    // Data particles with short trails
    particles.forEach((p) => {
      const e = edges[p.edge];
      if (e.p < 0.98 || !e.cp) return;
      const a = nodes[e.a], b = nodes[e.b];
      const boost = 0.55 + e.h * 0.4 + e.pulse * 0.4;
      for (let k = 0; k < 5; k++) {
        const t = clamp(p.t - k * 0.022, 0, 1);
        const pos = bez(a, b, e.cp, p.fromA ? t : 1 - t);
        const size = (k === 0 ? 2.2 : 1.7 - k * 0.22) * (0.8 + ((a.sc + b.sc) / 2 - 1) * 0.6);
        ctx.fillStyle = rgba(p.c, clamp((k === 0 ? 0.95 : 0.4 - k * 0.07) * boost, 0, 1));
        ctx.beginPath();
        ctx.arc(pos[0], pos[1], Math.max(0.6, size), 0, Math.PI * 2);
        ctx.fill();
      }
    });

    // Nodes, far to near
    const order = nodes.slice().sort((p, q) => p.depth - q.depth);
    order.forEach((n) => {
      if (n.p <= 0.01) return;
      const sp = sprites[n.color];
      const base = n.r * n.sc;
      const glowSize = base * (5 + n.hover * 3 + n.pulse * 3);
      let ga = (0.3 + 0.35 * n.depth + 0.45 * n.hover + 0.5 * n.pulse) * n.p;
      if (hoverNode && n !== hoverNode && n.hover < 0.05) ga *= dim;
      ctx.globalAlpha = clamp(ga, 0, 1);
      ctx.drawImage(sp.glow, n.px - glowSize, n.py - glowSize, glowSize * 2, glowSize * 2);

      const core = base * (1 + n.hover * 0.14 + n.pulse * 0.1);
      ctx.globalAlpha = clamp((0.55 + 0.4 * n.depth) * n.p, 0, 1);
      ctx.drawImage(sp.sphere, n.px - core, n.py - core, core * 2, core * 2);

      if (n.major) {
        ctx.globalAlpha = clamp((0.18 + 0.4 * n.hover + 0.3 * n.pulse) * n.p, 0, 1);
        ctx.strokeStyle = rgba(n.c, 1);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(n.px, n.py, base * 1.9, 0, Math.PI * 2);
        ctx.stroke();
      }
    });
    ctx.globalAlpha = 1;

    // Labels (normal blending so they stay crisp)
    ctx.globalCompositeOperation = 'source-over';
    ctx.textAlign = 'center';
    ctx.font = `500 ${isCompact ? 10 : 11}px "Open Sans", sans-serif`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '1.2px';
    nodes.forEach((n) => {
      if (!n.major || n.p < 0.6) return;
      const a = clamp((0.4 + 0.2 * n.depth + 0.5 * n.hover + 0.25 * n.pulse) * n.p, 0, 1);
      ctx.fillStyle = `rgba(205,228,255,${a})`;
      ctx.fillText((isCompact && n.short ? n.short : n.label).toUpperCase(), n.px, n.py + n.r * n.sc * 2.5 + 12);
    });
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  }

  function frame(now) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    time += dt;
    update(dt);
    draw();
  }

  function renderStatic() {
    // Fully assembled, motionless frame with particles frozen along the paths.
    time = 10;
    mx = my = targetMx = targetMy = 0;
    pointerActive = false;
    nodes.forEach((n) => { n.hover = 0; n.pulse = 0; n.ax = n.ay = 0; });
    update(0);
    draw();
  }

  function start() {
    if (running || reduceMotion.matches || !heroVisible || document.hidden) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  /* ---------- events ---------- */
  function onPointerMove(e) {
    if (reduceMotion.matches || e.pointerType === 'touch') return;
    const rect = canvas.getBoundingClientRect();
    ptX = e.clientX - rect.left;
    ptY = e.clientY - rect.top;
    pointerActive = ptX > -60 && ptX < width + 60 && ptY > -60 && ptY < height + 60;
    const hr = hero.getBoundingClientRect();
    targetMx = clamp(((e.clientX - hr.left) / hr.width - 0.5) * 2, -1, 1);
    targetMy = clamp(((e.clientY - hr.top) / hr.height - 0.5) * 2, -1, 1);
  }

  function onPointerLeave() {
    pointerActive = false;
    targetMx = targetMy = 0;
  }

  function onMotionChange() {
    if (reduceMotion.matches) { stop(); renderStatic(); } else { time = 0; nodes.forEach((n) => { n.p = 0; }); start(); }
  }

  function init() {
    makeSprites();
    resize();
    hero.addEventListener('pointermove', onPointerMove, { passive: true });
    hero.addEventListener('pointerleave', onPointerLeave, { passive: true });

    if ('ResizeObserver' in window) new ResizeObserver(resize).observe(canvas);
    else window.addEventListener('resize', resize);

    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => {
        heroVisible = entries[0].isIntersecting;
        heroVisible ? start() : stop();
      }, { threshold: 0.05 }).observe(hero);
    }
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
    if (reduceMotion.addEventListener) reduceMotion.addEventListener('change', onMotionChange);

    if (reduceMotion.matches) renderStatic(); else start();
  }

  if ('requestIdleCallback' in window) requestIdleCallback(init, { timeout: 600 });
  else setTimeout(init, 0);
})();
