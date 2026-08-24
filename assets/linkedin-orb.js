/* Social orb pills — dot-matrix brand marks with traveling highlights, adapted
   from the brand-orbs specimen and re-themed to the site's gold palette. */
(() => {
  "use strict";
  const TAU = Math.PI * 2;
  const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
  const lerp = (a, b, m) => a + (b - a) * m;

  const LINKEDIN_PATH = "M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z";
  const INSTAGRAM_PATH = "M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077";

  /* one config per mark: invert carries the glyph as the hole in a dot box */
  const MARKS = {
    linkedin: { path: LINKEDIN_PATH, invert: true, motion: "scan" },
    instagram: { path: INSTAGRAM_PATH, motion: "sweep" }
  };

  const style = document.createElement("style");
  style.textContent = `
.linkedin-orb,.instagram-orb{display:inline-flex;align-items:center;gap:8px;padding:5px 14px 5px 7px;
  border:1px solid rgba(200,146,10,.45);border-radius:999px;background:rgba(255,255,255,.9);
  text-decoration:none;transition:border-color .25s,box-shadow .25s;}
.linkedin-orb:hover,.instagram-orb:hover{border-color:#c8920a;box-shadow:0 4px 14px rgba(200,146,10,.25);}
.linkedin-orb canvas,.instagram-orb canvas{width:24px;height:24px;display:block;}
.linkedin-orb span,.instagram-orb span{position:relative;font-size:13px;font-weight:700;letter-spacing:.1em;
  color:rgba(200,146,10,.75);}
.linkedin-orb span::before,.instagram-orb span::before{content:attr(data-text);position:absolute;inset:0;pointer-events:none;
  background-image:linear-gradient(90deg,transparent 40%,#f0c028 50%,transparent 60%);
  background-size:400% 100%;background-repeat:no-repeat;
  -webkit-background-clip:text;background-clip:text;color:transparent;
  animation:liOrbShimmer 2.6s linear infinite;}
@keyframes liOrbShimmer{0%{background-position:100% 0}to{background-position:0% 0}}
@media (prefers-reduced-motion:reduce){.linkedin-orb span::before,.instagram-orb span::before{animation:none}}`;
  document.head.appendChild(style);

  /* Sample a logo path as a dot lattice; with invert the glyph is the hole
     in a rounded box of dots (the specimen's invert:"box" mode). */
  function sampleMark(n, path, invert) {
    const px = 200, c = document.createElement("canvas");
    c.width = c.height = px;
    const g = c.getContext("2d");
    g.setTransform(px / 24, 0, 0, px / 24, 0, 0);
    g.fillStyle = "#fff";
    g.fill(new Path2D(path));
    const img = g.getImageData(0, 0, px, px).data;
    let x0 = px, x1 = -1, y0 = px, y1 = -1;
    for (let j = 0; j < px; j++) for (let i = 0; i < px; i++)
      if (img[(j * px + i) * 4 + 3] > 128) {
        if (i < x0) x0 = i; if (i > x1) x1 = i;
        if (j < y0) y0 = j; if (j > y1) y1 = j;
      }
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, m = Math.max(x1 - x0, y1 - y0);
    const pts = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const sx = mx + ((i + .5) / n * 2 - 1) * m / 2;
      const sy = my + ((j + .5) / n * 2 - 1) * m / 2;
      const ix = Math.round(sx), iy = Math.round(sy);
      if (ix < 0 || iy < 0 || ix >= px || iy >= px) continue;
      const on = img[(iy * px + ix) * 4 + 3] > 128;
      const nx = (sx - mx) / (m / 2), ny = (sy - my) / (m / 2);
      if (invert) {
        if (on) continue;
        if (Math.pow(Math.abs(nx), 4) + Math.pow(Math.abs(ny), 4) > Math.pow(.9, 4)) continue;
      } else if (!on) continue;
      pts.push([nx, ny]);
    }
    return pts;
  }

  const DEEP = [140, 100, 10], GOLD = [200, 146, 10], HI = [240, 192, 40];
  function goldOf(v) {
    const [a, b, m] = v < .5 ? [DEEP, GOLD, v * 2] : [GOLD, HI, v * 2 - 1];
    return `rgba(${lerp(a[0], b[0], m) | 0},${lerp(a[1], b[1], m) | 0},${lerp(a[2], b[2], m) | 0},${(.55 + .45 * v).toFixed(3)})`;
  }

  function boot(canvas, cfg) {
    const S = 24, dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = S * dpr;
    canvas.height = S * dpr;
    const ctx = canvas.getContext("2d");
    const pts = sampleMark(14, cfg.path, cfg.invert);
    const cx = S / 2, cy = S / 2, R = S / 2 * .88;
    const rs = Math.pow(S / 300, .6) * 1.8;
    return t => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, S, S);
      const yawA = .15 * Math.sin(t * .4), tiltA = .13 * Math.sin(t * .31);
      const st = Math.sin(tiltA), ct = Math.cos(tiltA);
      const sy = Math.sin(yawA), cyw = Math.cos(yawA);
      const wave = (((t * .38) % 1 + 1) % 1) * 2.4 - 1.2;
      const dots = [];
      for (const [gx, gy] of pts) {
        let crest;
        if (cfg.motion === "sweep") {
          const ph = ((Math.atan2(gy, gx) / TAU + .5 - t * .3) % 1 + 1) % 1;
          crest = Math.exp(-Math.pow(ph - .5, 2) / .02);
        } else {
          crest = Math.exp(-Math.pow(gy - wave, 2) / .05);
        }
        const X = gx, Y = -gy;
        const pxr = X * cyw, pz = -X * sy;
        const pyr = Y * ct - pz * st, z2 = Y * st + pz * ct;
        const dep = (z2 + 1) / 2;
        dots.push({
          x: cx + pxr * R, y: cy - pyr * R, z: z2,
          r: (.78 + .72 * dep + .45 * crest) * rs,
          v: clamp01(.5 + .15 * dep + .32 * crest)
        });
      }
      dots.sort((a, b) => a.z - b.z);
      for (const d of dots) {
        ctx.fillStyle = goldOf(d.v);
        ctx.beginPath();
        ctx.arc(d.x, d.y, Math.max(.3, d.r), 0, TAU);
        ctx.fill();
      }
    };
  }

  const frames = [];
  for (const [cls, cfg] of [[".linkedin-orb", MARKS.linkedin], [".instagram-orb", MARKS.instagram]])
    document.querySelectorAll(cls + " canvas").forEach(c => frames.push(boot(c, cfg)));
  if (!frames.length) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    frames.forEach(f => f(1.2));
    return;
  }
  const tick = () => {
    const t = performance.now() / 1e3;
    if (!document.hidden) frames.forEach(f => f(t));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();
