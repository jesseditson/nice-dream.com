(() => {
  const canvas = document.querySelector<HTMLCanvasElement>("canvas.film-scenes");
  const context = canvas?.getContext("2d", { alpha: false });
  const urls = (canvas?.dataset.scenes ?? "").split(/\s+/).filter(Boolean);
  if (!canvas || !context || urls.length === 0) return;
  const ctx = context;

  const FRAME_MS = 1000 / 24;
  const HOLD_MS = 9000;
  const FADE_MS = 2400;
  const MAX_SIDE = 1280;
  const GRAIN_TILE = 160;
  const PANS: [number, number][] = [
    [-1, 0.4],
    [1, -0.3],
    [0.4, 1],
    [-0.5, -1],
  ];
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // main is its own stacking context (z-index 2), so the backdrop has to sit directly under body.
  document.body.prepend(canvas);

  const images: (HTMLImageElement | null)[] = urls.map(() => null);
  const loading = new Map<number, Promise<HTMLImageElement | null>>();
  const load = (index: number): Promise<HTMLImageElement | null> => {
    const known = loading.get(index);
    if (known) return known;
    const image = new Image();
    image.decoding = "async";
    image.src = urls[index];
    const ready = image
      .decode()
      .then(() => {
        images[index] = image;
        return image;
      })
      .catch(() => null);
    loading.set(index, ready);
    return ready;
  };

  const grain = Array.from({ length: 6 }, () => {
    const tile = document.createElement("canvas");
    tile.width = tile.height = GRAIN_TILE;
    const tileContext = tile.getContext("2d")!;
    const noise = tileContext.createImageData(GRAIN_TILE, GRAIN_TILE);
    for (let i = 0; i < noise.data.length; i += 4) {
      const value = Math.random() * 255;
      noise.data[i] = noise.data[i + 1] = noise.data[i + 2] = value;
      noise.data[i + 3] = 255;
    }
    tileContext.putImageData(noise, 0, 0);
    return ctx.createPattern(tile, "repeat")!;
  });

  let vignette: CanvasGradient | null = null;
  const resize = () => {
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const w = canvas.width;
    const h = canvas.height;
    vignette = ctx.createRadialGradient(w / 2, h * 0.42, Math.min(w, h) * 0.25, w / 2, h / 2, Math.hypot(w, h) * 0.62);
    vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
    vignette.addColorStop(1, "rgba(0, 0, 0, 0.66)");
  };

  type Showing = { index: number; since: number };
  let current: Showing | null = null;
  let previous: Showing | null = null;
  let weave = { x: 0, y: 0 };
  let lamp = 1;
  let scratch: { x: number; frames: number; drift: number } | null = null;

  const drawScene = (showing: Showing, now: number, alpha: number) => {
    const image = images[showing.index];
    if (!image) return;
    const w = canvas.width;
    const h = canvas.height;
    const progress = still ? 0.5 : Math.min(1.25, (now - showing.since) / (HOLD_MS + FADE_MS));
    const scale = Math.max(w / image.naturalWidth, h / image.naturalHeight) * (1.06 + 0.08 * progress);
    const dw = image.naturalWidth * scale;
    const dh = image.naturalHeight * scale;
    const [panX, panY] = PANS[showing.index % PANS.length];
    const travel = (progress - 0.5) * 1.5;
    const x = (w - dw) / 2 + (panX * travel * (dw - w)) / 2 + weave.x;
    const y = (h - dh) / 2 + (panY * travel * (dh - h)) / 2 + weave.y;
    ctx.globalAlpha = alpha;
    ctx.drawImage(image, x, y, dw, dh);
    ctx.globalAlpha = 1;
  };

  const drawFilm = (now: number) => {
    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = "#050505";
    ctx.fillRect(0, 0, w, h);

    if (previous && current && now - current.since < FADE_MS) drawScene(previous, now, 1);
    if (current) drawScene(current, now, still ? 1 : Math.min(1, (now - current.since) / FADE_MS));

    ctx.fillStyle = `rgba(8, 6, 4, ${0.5 + (1 - lamp) * 0.6})`;
    ctx.fillRect(0, 0, w, h);

    if (vignette) {
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, w, h);
    }

    if (scratch) {
      ctx.fillStyle = "rgba(255, 248, 230, 0.16)";
      ctx.fillRect(scratch.x, 0, Math.max(1, w / 900), h);
    }
    if (!still && Math.random() < 0.2) {
      for (let speck = Math.ceil(Math.random() * 3); speck > 0; speck--) {
        ctx.fillStyle = Math.random() < 0.5 ? "rgba(0, 0, 0, 0.55)" : "rgba(255, 250, 235, 0.3)";
        ctx.beginPath();
        ctx.arc(Math.random() * w, Math.random() * h, 0.5 + Math.random() * 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.save();
    ctx.globalCompositeOperation = "overlay";
    ctx.globalAlpha = 0.32;
    const offsetX = Math.random() * GRAIN_TILE;
    const offsetY = Math.random() * GRAIN_TILE;
    ctx.translate(-offsetX, -offsetY);
    ctx.fillStyle = grain[Math.floor(Math.random() * grain.length)];
    ctx.fillRect(0, 0, w + offsetX, h + offsetY);
    ctx.restore();
  };

  const advance = (now: number) => {
    lamp += (0.93 + Math.random() * 0.07 - lamp) * 0.5;
    weave = {
      x: Math.sin(now / 730) * 0.6 + (Math.random() - 0.5) * 0.5,
      y: Math.sin(now / 1130) * 0.8 + (Math.random() - 0.5) * 0.5,
    };
    if (scratch) {
      scratch.frames -= 1;
      scratch.x += scratch.drift;
      if (scratch.frames <= 0) scratch = null;
    } else if (Math.random() < 0.025) {
      scratch = { x: Math.random() * canvas.width, frames: 3 + Math.floor(Math.random() * 8), drift: (Math.random() - 0.5) * 1.5 };
    }
    if (!current) return;
    const next = (current.index + 1) % urls.length;
    if (urls.length > 1 && now - current.since >= HOLD_MS && images[next]) {
      previous = current;
      current = { index: next, since: now };
      void load((next + 1) % urls.length);
    }
  };

  let lastFrame = 0;
  const tick = (now: number) => {
    requestAnimationFrame(tick);
    if (now - lastFrame < FRAME_MS) return;
    lastFrame = now;
    advance(now);
    drawFilm(now);
  };

  resize();
  window.addEventListener("resize", () => {
    resize();
    if (still) drawFilm(performance.now());
  });
  canvas.hidden = false;
  document.body.classList.add("film-scenes-live");

  void load(0).then((image) => {
    if (!image) return;
    current = { index: 0, since: performance.now() };
    if (still) drawFilm(current.since);
    else if (urls.length > 1) void load(1);
  });
  if (still) drawFilm(performance.now());
  else requestAnimationFrame(tick);
})();
