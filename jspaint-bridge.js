/**
 * jspaint-bridge.js
 * ─────────────────
 * postMessage bridge that allows the Jay OS parent window to read from and
 * write to jspaint's main canvas for the Magic AI feature.
 *
 * ── INTEGRATION STEPS ───────────────────────────────────────────────────
 *
 * STEP 1 — Expose canvas + undo hook from jspaint's src/app.js
 * ─────────────────────────────────────────────────────────────
 * Find the block where `$canvas` is first defined (typically near the top of
 * the large IIFE / module in src/app.js).  Look for the line that creates it:
 *
 *   var $canvas = $("<canvas>");
 *   (or:  let $canvas = $(canvas);  depending on version)
 *
 * Right after jspaint's full initialization (near the very bottom of app.js,
 * after all tool/history setup), add:
 *
 *   // ── Jay OS AI Bridge ──
 *   window._jspaintCanvas    = $canvas[0];
 *   window._jspaintUndoable  = (typeof undoable === 'function') ? undoable : null;
 *
 * STEP 2 — Include this file in jspaint's index.html
 * ───────────────────────────────────────────────────
 * Add at the very END of <body>, after all other <script> tags:
 *
 *   <script src="jspaint-bridge.js"></script>
 *
 * STEP 3 — Set the iframe data-src in Jay OS to your deployed fork URL
 * ─────────────────────────────────────────────────────────────────────
 * In jay-os/src/index.html, find the paint-iframe and update:
 *
 *   data-src="https://YOUR_JSPAINT_FORK.vercel.app"
 *
 * ── PROTOCOL ────────────────────────────────────────────────────────────
 *
 *   Parent → iframe:  { type: 'JSPAINT_GET_CANVAS', requestId: string }
 *   iframe → parent:  { type: 'JSPAINT_CANVAS_DATA', requestId, dataURL, width, height }
 *                   | { type: 'JSPAINT_CANVAS_DATA', requestId, error: string }
 *
 *   Parent → iframe:  { type: 'JSPAINT_SET_CANVAS', requestId, payload: { dataURL } }
 *   iframe → parent:  { type: 'JSPAINT_SET_COMPLETE', requestId }
 *                   | { type: 'JSPAINT_SET_ERROR',    requestId, error: string }
 *
 *   iframe → parent:  { type: 'JSPAINT_READY' }   (fired once on script load)
 *
 * ────────────────────────────────────────────────────────────────────────
 */
(function () {
  'use strict';

  // ── Canvas resolution ─────────────────────────────────────────────────

  /**
   * Locate jspaint's main drawing canvas.
   * Preference order:
   *   1. window._jspaintCanvas  (explicit export from app.js — preferred)
   *   2. DOM query inside the canvas-and-grid container
   *   3. First <canvas> on the page (last resort)
   */
  function getMainCanvas() {
    if (window._jspaintCanvas instanceof HTMLCanvasElement) {
      return window._jspaintCanvas;
    }
    // jspaint DOM selectors (checked against multiple versions of the codebase)
    return (
      document.querySelector('.canvas-and-grid canvas#main-canvas') ||
      document.querySelector('.canvas-and-grid > canvas')           ||
      document.querySelector('#canvas-area canvas')                 ||
      document.querySelector('canvas#main-canvas')                  ||
      // last resort: largest canvas on page (jspaint's drawing canvas is always biggest)
      Array.from(document.querySelectorAll('canvas')).reduce(
        (best, c) => (c.width * c.height > (best ? best.width * best.height : 0) ? c : best),
        null
      )
    );
  }

  // ── Message handlers ──────────────────────────────────────────────────

  function handleGetCanvas(requestId) {
    const canvas = getMainCanvas();
    if (!canvas) {
      reply({ type: 'JSPAINT_CANVAS_DATA', requestId, error: 'Canvas element not found' });
      return;
    }
    try {
      const dataURL = canvas.toDataURL('image/png');
      reply({
        type: 'JSPAINT_CANVAS_DATA',
        requestId,
        dataURL,
        width:  canvas.width,
        height: canvas.height,
      });
    } catch (e) {
      reply({ type: 'JSPAINT_CANVAS_DATA', requestId, error: e.message });
    }
  }

  function handleSetCanvas(requestId, payload) {
    const canvas = getMainCanvas();
    if (!canvas) {
      reply({ type: 'JSPAINT_SET_ERROR', requestId, error: 'Canvas element not found' });
      return;
    }

    const img = new Image();

    img.onload = function () {
      try {
        const ctx = canvas.getContext('2d');

        if (typeof window._jspaintUndoable === 'function') {
          // ── jspaint-native undo integration ────────────────────────────
          // window._jspaintUndoable is the `undoable` function exported from
          // jspaint's app.js.  It accepts { name, do(args), undo(args), redo(args) }
          // where args = { canvas, ctx }.
          const prevData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const srcImg   = img; // capture for redo closure

          window._jspaintUndoable({
            name: 'AI Generation',
            do(args) {
              const c = args.canvas || canvas;
              const x = c.getContext('2d');
              x.clearRect(0, 0, c.width, c.height);
              x.drawImage(srcImg, 0, 0, c.width, c.height);
            },
            undo(args) {
              const c = args.canvas || canvas;
              c.getContext('2d').putImageData(prevData, 0, 0);
            },
            redo(args) {
              const c = args.canvas || canvas;
              const x = c.getContext('2d');
              x.clearRect(0, 0, c.width, c.height);
              x.drawImage(srcImg, 0, 0, c.width, c.height);
            },
          });
        } else {
          // ── Direct draw fallback ────────────────────────────────────────
          // No undo history integration; the AI result replaces the canvas.
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        }

        reply({ type: 'JSPAINT_SET_COMPLETE', requestId });
      } catch (e) {
        reply({ type: 'JSPAINT_SET_ERROR', requestId, error: e.message });
      }
    };

    img.onerror = function () {
      reply({ type: 'JSPAINT_SET_ERROR', requestId, error: 'Failed to load AI-generated image' });
    };

    img.src = payload.dataURL;
  }

  // ── Message routing ───────────────────────────────────────────────────

  function reply(msg) {
    window.parent.postMessage(msg, '*');
  }

  function onMessage(event) {
    // Guard: only handle our namespaced message types.
    // Do NOT use `event.source !== window.parent` — cross-origin Window
    // reference equality is unreliable and causes silent timeouts.
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (typeof msg.type !== 'string' || !msg.type.startsWith('JSPAINT_')) return;

    const { type, requestId, payload } = msg;

    switch (type) {
      case 'JSPAINT_GET_CANVAS':
        handleGetCanvas(requestId);
        break;
      case 'JSPAINT_SET_CANVAS':
        handleSetCanvas(requestId, payload || {});
        break;
      default:
        break;
    }
  }

  window.addEventListener('message', onMessage);
  window.addEventListener('unload',  function () {
    window.removeEventListener('message', onMessage);
  });

  // Signal to the parent that the bridge is alive and listening.
  reply({ type: 'JSPAINT_READY' });
})();
