/**
 * Shared PNG export for solo Rating + Group Rate results grids.
 * ranked items: { song: { name, artists, image }, rating: number }
 * For Group Rate, pass average as `rating`.
 */

function loadImageForCanvas(src) {
  return new Promise((resolve) => {
    if (!src) {
      resolve(null);
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function formatScore(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '—';
  const v = Math.min(10, Math.max(0, Math.round(x * 10) / 10));
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/**
 * @param {Array<{ song: object, rating: number }>} ranked
 * @param {string} title
 * @param {{ modeLabel?: string }} [opts]
 * @returns {Promise<Blob>}
 */
export async function buildRatingResultsImageBlob(ranked, title, opts = {}) {
  const modeLabel = opts.modeLabel || 'Rating Mode';
  const n = ranked.length;
  const cols = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(n || 1))));
  const cell = 220;
  const gap = 16;
  const pad = 28;
  const headerH = 88;
  const labelH = 52;
  const rows = Math.max(1, Math.ceil(n / cols));
  const width = pad * 2 + cols * cell + (cols - 1) * gap;
  const height = pad * 2 + headerH + rows * (cell + labelH + gap) - gap;

  const canvas = document.createElement('canvas');
  const scale = 2;
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas not available');
  ctx.scale(scale, scale);

  const grad = ctx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, '#0f0a1a');
  grad.addColorStop(0.5, '#1a1030');
  grad.addColorStop(1, '#0c1222');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = 'rgba(167, 139, 250, 0.12)';
  ctx.beginPath();
  ctx.arc(width * 0.15, 40, 120, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(251, 191, 36, 0.1)';
  ctx.beginPath();
  ctx.arc(width * 0.85, height * 0.2, 100, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#f8fafc';
  ctx.font = '700 26px system-ui, Segoe UI, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(modeLabel, pad, pad + 28);
  ctx.fillStyle = '#c4b5fd';
  ctx.font = '600 16px system-ui, Segoe UI, sans-serif';
  const sub = `${title} · ${n} song${n === 1 ? '' : 's'}`;
  ctx.fillText(sub.length > 60 ? `${sub.slice(0, 57)}…` : sub, pad, pad + 54);

  const images = await Promise.all(
    ranked.map((e) => loadImageForCanvas(e.song?.image || null))
  );

  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = pad + col * (cell + gap);
    const y = pad + headerH + row * (cell + labelH + gap);
    const e = ranked[i];
    const img = images[i];
    const score = formatScore(e.rating);

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 8;
    roundRectPath(ctx, x, y, cell, cell, 16);
    ctx.fillStyle = '#1e1b2e';
    ctx.fill();
    ctx.restore();

    ctx.save();
    roundRectPath(ctx, x, y, cell, cell, 16);
    ctx.clip();
    if (img) {
      const iw = img.naturalWidth || img.width;
      const ih = img.naturalHeight || img.height;
      const s = Math.max(cell / iw, cell / ih);
      const dw = iw * s;
      const dh = ih * s;
      ctx.drawImage(img, x + (cell - dw) / 2, y + (cell - dh) / 2, dw, dh);
    } else {
      ctx.fillStyle = '#2a2140';
      ctx.fillRect(x, y, cell, cell);
      ctx.fillStyle = '#a78bfa';
      ctx.font = '48px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('♪', x + cell / 2, y + cell / 2);
    }
    const g = ctx.createLinearGradient(x, y + cell * 0.35, x, y + cell);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.72)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, cell, cell);
    ctx.restore();

    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    roundRectPath(ctx, x + 10, y + 10, 42, 22, 11);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`#${i + 1}`, x + 31, y + 21);

    // Score / group average over art — white fill + black outline
    ctx.font = '800 52px system-ui, Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const sx = x + cell / 2;
    const sy = y + cell / 2 + 6;
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#000';
    ctx.strokeText(score, sx, sy);
    ctx.fillStyle = '#fff';
    ctx.fillText(score, sx, sy);

    ctx.fillStyle = '#e2e8f0';
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    let t = e.song?.name || 'Unknown';
    while (ctx.measureText(t).width > cell - 4 && t.length > 3) {
      t = `${t.slice(0, -2)}…`;
    }
    ctx.fillText(t, x, y + cell + 8);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '500 11px system-ui, sans-serif';
    let a = e.song?.artists || '';
    while (ctx.measureText(a).width > cell - 4 && a.length > 3) {
      a = `${a.slice(0, -2)}…`;
    }
    ctx.fillText(a, x, y + cell + 26);
  }

  // Bottom-left site URL (small)
  ctx.fillStyle = 'rgba(148, 163, 184, 0.85)';
  ctx.font = '500 9px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText('https://playlist-bracket.onrender.com/', pad, height - 10);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Could not create image'));
      },
      'image/png',
      0.95
    );
  });
}

/**
 * @param {Blob} blob
 * @param {HTMLElement|null} btn
 * @param {string} [downloadPrefix]
 */
export async function copyOrDownloadRatingImage(
  blob,
  btn,
  downloadPrefix = 'rating-results'
) {
  const prev = btn?.textContent;
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob }),
      ]);
      if (btn) {
        btn.textContent = 'Image copied!';
        setTimeout(() => {
          if (btn.isConnected && prev != null) btn.textContent = prev;
        }, 2000);
      }
      return;
    }
  } catch {
    // fall through
  }
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${downloadPrefix}-${Date.now()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    if (btn) {
      btn.textContent = 'Downloaded PNG';
      setTimeout(() => {
        if (btn.isConnected && prev != null) btn.textContent = prev;
      }, 2000);
    }
  } catch {
    if (btn) btn.textContent = 'Export failed';
  }
}
