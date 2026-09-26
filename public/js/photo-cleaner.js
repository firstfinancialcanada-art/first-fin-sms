// public/js/photo-cleaner.js — cover a supplier's sign instead of binning the photo
//
// The signage scan started by hiding any photo the sign appeared in. Franco,
// 2026-09-25: "the hidden the whole image does not work.. if the door is open
// and the sign is there you hide half the photos." He is right. Looking at a
// real SmartBuy gallery, the sign turns up small and at the EDGE of frame — in
// the rear 3/4 and the side angles, which are the shots that sell the car. A
// listing with six photos converts worse than one with fifteen, so hiding was
// costing more than it saved.
//
// So: paint over the sign and keep the photo. The box is stored as fractions
// of the image (not pixels) per tenant per URL, so it is drawn once and
// remembered forever at whatever size the photo is served.
//
// All of this happens in the browser. SmartBuy's storage sends
// Access-Control-Allow-Origin:*, so the photos can be drawn to a canvas and
// exported without tainting it — no server CPU, no API key, no proxy.
(function () {
  'use strict';

  var MAX_BOXES = 12;

  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.crossOrigin = 'anonymous';        // must be set BEFORE src
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('could not load photo')); };
      img.src = url;
    });
  }

  // Fill each box with the colour of the pixels just outside it, so the patch
  // reads as more wall/sky/fence rather than as a black rectangle. A buyer
  // should see a clean photo, not an obviously censored one.
  function paintBoxes(ctx, img, boxes) {
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      var x = Math.round(b.x * img.width);
      var y = Math.round(b.y * img.height);
      var w = Math.round(b.w * img.width);
      var h = Math.round(b.h * img.height);
      if (w < 1 || h < 1) continue;

      // Sample a ring just outside the box and average it.
      var pad = Math.max(2, Math.round(Math.min(w, h) * 0.12));
      var sx = Math.max(0, x - pad), sy = Math.max(0, y - pad);
      var sw = Math.min(img.width - sx, w + pad * 2);
      var sh = Math.min(img.height - sy, h + pad * 2);
      var r = 0, g = 0, bl = 0, n = 0;
      try {
        var d = ctx.getImageData(sx, sy, sw, sh).data;
        for (var p = 0; p < d.length; p += 4 * 7) {       // every 7th pixel is plenty
          r += d[p]; g += d[p + 1]; bl += d[p + 2]; n++;
        }
      } catch (e) { /* tainted canvas — fall back to grey */ }
      var fill = n ? 'rgb(' + ((r / n) | 0) + ',' + ((g / n) | 0) + ',' + ((bl / n) | 0) + ')' : '#8a8f98';

      ctx.fillStyle = fill;
      ctx.fillRect(x, y, w, h);
      // A touch of noise stops it looking like a printed swatch.
      ctx.globalAlpha = 0.06;
      for (var k = 0; k < Math.min(400, (w * h) / 900); k++) {
        ctx.fillStyle = k % 2 ? '#000' : '#fff';
        ctx.fillRect(x + Math.random() * w, y + Math.random() * h, 2, 2);
      }
      ctx.globalAlpha = 1;
    }
  }

  // Returns a blob: URL of the cleaned photo, or the original URL when there
  // is nothing to cover or anything goes wrong — never a broken image.
  function render(url, boxes) {
    if (!boxes || !boxes.length) return Promise.resolve(url);
    return loadImage(url).then(function (img) {
      var c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      var ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      paintBoxes(ctx, img, boxes);
      return new Promise(function (resolve) {
        c.toBlob(function (blob) {
          resolve(blob ? URL.createObjectURL(blob) : url);
        }, 'image/jpeg', 0.92);
      });
    }).catch(function () { return url; });
  }

  // ── The editor ──────────────────────────────────────────────────────
  // Drag a box over the sign. Click an existing box to drop it.
  // opts: { hidden, onHide }  — hiding lives here too, because this is the
  // only place the photo is big enough to judge. Deciding from a 70px
  // thumbnail is how you end up binning a good rear 3/4.
  function open(url, boxes, onSave, opts) {
    opts = opts || {};
    var working = (boxes || []).slice();

    var wrap = document.createElement('div');
    wrap.style.cssText =
      'position:fixed;inset:0;z-index:100000;background:rgba(6,10,20,.92);display:flex;' +
      'flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:16px;' +
      'font-family:Outfit,system-ui,sans-serif;';

    var hint = document.createElement('div');
    hint.textContent = 'Drag a box over the sign. Click a box to remove it.';
    hint.style.cssText = 'color:#cbd5e1;font-size:13px;font-weight:600;';
    wrap.appendChild(hint);

    var stage = document.createElement('div');
    stage.style.cssText = 'position:relative;line-height:0;max-width:94vw;max-height:74vh;cursor:crosshair;';
    wrap.appendChild(stage);

    var im = document.createElement('img');
    im.crossOrigin = 'anonymous';
    im.src = url;
    im.style.cssText = 'max-width:94vw;max-height:74vh;border-radius:6px;user-select:none;';
    im.draggable = false;
    stage.appendChild(im);

    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:absolute;inset:0;';
    stage.appendChild(overlay);

    function redraw() {
      overlay.innerHTML = '';
      working.forEach(function (b, idx) {
        var d = document.createElement('div');
        d.style.cssText =
          'position:absolute;left:' + (b.x * 100) + '%;top:' + (b.y * 100) + '%;' +
          'width:' + (b.w * 100) + '%;height:' + (b.h * 100) + '%;' +
          'background:rgba(239,68,68,.35);border:2px solid #ef4444;cursor:pointer;';
        d.title = 'Click to remove';
        d.onclick = function (ev) { ev.stopPropagation(); working.splice(idx, 1); redraw(); };
        overlay.appendChild(d);
      });
      count.textContent = working.length ? working.length + ' box' + (working.length === 1 ? '' : 'es') : 'no boxes yet';
    }

    // drag to draw
    var startX = 0, startY = 0, live = null;
    stage.addEventListener('mousedown', function (e) {
      if (e.target !== im && e.target !== overlay) return;      // clicking a box removes it
      if (working.length >= MAX_BOXES) return;
      var r = im.getBoundingClientRect();
      startX = (e.clientX - r.left) / r.width;
      startY = (e.clientY - r.top) / r.height;
      live = document.createElement('div');
      live.style.cssText = 'position:absolute;background:rgba(239,68,68,.3);border:2px dashed #ef4444;';
      overlay.appendChild(live);
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!live) return;
      var r = im.getBoundingClientRect();
      var cx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      var cy = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      var x = Math.min(startX, cx), y = Math.min(startY, cy);
      var w = Math.abs(cx - startX), h = Math.abs(cy - startY);
      live.style.left = (x * 100) + '%'; live.style.top = (y * 100) + '%';
      live.style.width = (w * 100) + '%'; live.style.height = (h * 100) + '%';
      live._box = { x: x, y: y, w: w, h: h };
    });
    window.addEventListener('mouseup', function () {
      if (!live) return;
      var b = live._box;
      live.remove(); live = null;
      if (b && b.w > 0.01 && b.h > 0.01) working.push(b);
      redraw();
    });

    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;align-items:center;';
    wrap.appendChild(bar);

    var count = document.createElement('span');
    count.style.cssText = 'color:#94a3b8;font-size:12px;margin-right:6px;';
    bar.appendChild(count);

    function button(label, primary) {
      var b = document.createElement('button');
      b.textContent = label;
      b.style.cssText =
        'padding:8px 16px;border-radius:6px;border:0;cursor:pointer;font-family:inherit;' +
        'font-size:13px;font-weight:700;' +
        (primary ? 'background:#1e5af6;color:#fff;' : 'background:#334155;color:#e2e8f0;');
      bar.appendChild(b);
      return b;
    }
    button('Save', true).onclick = function () { wrap.remove(); onSave(working); };
    button('Clear all').onclick   = function () { working = []; redraw(); };
    if (opts.onHide) {
      var hb = button(opts.hidden ? 'Use this photo' : 'Hide this photo');
      hb.style.background = opts.hidden ? '#0a8f6a' : '#7f1d1d';
      hb.style.color = '#fff';
      hb.onclick = function () { wrap.remove(); opts.onHide(!opts.hidden); };
    }
    button('Cancel').onclick      = function () { wrap.remove(); };

    im.onload = redraw;
    redraw();
    document.body.appendChild(wrap);
  }

  window.FFPhotoCleaner = { open: open, render: render };
})();
