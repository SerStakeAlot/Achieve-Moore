/* Live nav countdown to the Hands of Time Gala — Dec 5, 2026, 7:00 PM ET. */
(() => {
  "use strict";
  const nav = document.querySelector("nav");
  if (!nav || document.querySelector(".gala-count")) return;
  const TARGET = new Date("2026-12-05T19:00:00-05:00").getTime();

  const style = document.createElement("style");
  style.textContent = `
.gala-count{display:inline-flex;align-items:center;gap:8px;flex:none;
  border:1px solid rgba(200,146,10,.45);border-radius:999px;padding:6px 14px;
  background:rgba(255,255,255,.9);text-decoration:none;
  transition:border-color .25s,box-shadow .25s;}
.gala-count:hover{border-color:#c8920a;box-shadow:0 4px 14px rgba(200,146,10,.25);}
.gala-count-ico{font-size:12px;line-height:1;}
.gala-count-time{font-family:'Montserrat',sans-serif;font-size:12px;font-weight:700;
  color:#c8920a;letter-spacing:.08em;font-variant-numeric:tabular-nums;}
.gala-count-label{font-family:'Montserrat',sans-serif;font-size:9px;font-weight:700;
  letter-spacing:.2em;text-transform:uppercase;color:rgba(26,26,26,.55);white-space:nowrap;}
@media (max-width:1150px){.gala-count-label{display:none;}}
@media (max-width:768px){
  .gala-count{padding:5px 10px;gap:6px;margin-left:auto;margin-right:12px;}
  .gala-count-time{font-size:11px;}
}
@media (max-width:400px){.gala-count{display:none;}}`;
  document.head.appendChild(style);

  const chip = document.createElement("a");
  chip.className = "gala-count";
  chip.href = "/gala";
  chip.setAttribute("aria-label", "Countdown to the Hands of Time Gala, December 5, 2026");
  chip.innerHTML = '<span class="gala-count-ico" aria-hidden="true">&#9203;</span>' +
    '<span class="gala-count-time"></span>' +
    '<span class="gala-count-label">Until the Gala</span>';
  nav.insertBefore(chip, nav.querySelector(".nav-links"));

  const timeEl = chip.querySelector(".gala-count-time");
  const pad = n => String(n).padStart(2, "0");
  function tick() {
    const ms = TARGET - Date.now();
    if (ms <= 0) {
      timeEl.textContent = "Tonight";
      return;
    }
    const d = Math.floor(ms / 864e5);
    const h = Math.floor(ms / 36e5) % 24;
    const m = Math.floor(ms / 6e4) % 60;
    const s = Math.floor(ms / 1e3) % 60;
    timeEl.textContent = `${d}d ${pad(h)}:${pad(m)}:${pad(s)}`;
  }
  tick();
  setInterval(tick, 1000);
})();
