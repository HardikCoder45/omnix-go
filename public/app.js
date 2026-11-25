const FRAME_COUNT = 192;
const FRAME_PATH = (frame) => `/story-frames/frame-${String(frame).padStart(4, "0")}.jpg`;
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));

const nav = document.querySelector("[data-nav]");
const story = document.querySelector("[data-story]");
const canvas = document.querySelector("#story-canvas");
const progressBar = document.querySelector("#story-progress-bar");
const frameStatus = document.querySelector("#frame-status");
const beats = [...document.querySelectorAll("[data-beat]")];
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const ctx = canvas?.getContext("2d", { alpha: false, desynchronized: true });
const frameCache = new Map();
let activeFrame = 1;
let drawnFrame = 0;
let frameRequest = 0;
let scrollRaf = 0;
let resizeRaf = 0;

function loadFrame(frame, priority = false) {
  const safeFrame = Math.round(clamp(frame, 1, FRAME_COUNT));
  const cached = frameCache.get(safeFrame);
  if (cached) return cached.promise;

  const image = new Image();
  image.decoding = "async";
  if (priority && "fetchPriority" in image) image.fetchPriority = "high";

  const entry = { image, loaded: false, promise: null };
  entry.promise = new Promise((resolve, reject) => {
    image.addEventListener("load", () => {
      entry.loaded = true;
      resolve(image);
      if (safeFrame === activeFrame) drawFrame(safeFrame);
    }, { once: true });
    image.addEventListener("error", reject, { once: true });
  });

  image.src = FRAME_PATH(safeFrame);
  frameCache.set(safeFrame, entry);
  pruneFrameCache(safeFrame);
  return entry.promise;
}

function pruneFrameCache(centerFrame) {
  if (frameCache.size <= 42) return;
  const entries = [...frameCache.keys()]
    .map((frame) => ({ frame, distance: Math.abs(frame - centerFrame) }))
    .sort((a, b) => b.distance - a.distance);

  while (frameCache.size > 34 && entries.length) {
    const { frame } = entries.shift();
    if (frame === activeFrame || frame === 1 || frame === FRAME_COUNT) continue;
    frameCache.delete(frame);
  }
}

function warmFrames(frame) {
  const offsets = [0, 1, -1, 2, -2, 4, -4, 7, -7, 11, -11];
  for (const offset of offsets) {
    const candidate = frame + offset;
    if (candidate >= 1 && candidate <= FRAME_COUNT) loadFrame(candidate).catch(() => {});
  }
}

function resizeCanvas() {
  if (!canvas || !ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 1.6);
  const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  drawFrame(activeFrame, true);
}

function drawCover(image) {
  if (!canvas || !ctx || !image?.naturalWidth) return;
  const cw = canvas.width;
  const ch = canvas.height;
  const ir = image.naturalWidth / image.naturalHeight;
  const cr = cw / ch;
  let sx = 0;
  let sy = 0;
  let sw = image.naturalWidth;
  let sh = image.naturalHeight;

  if (ir > cr) {
    sw = image.naturalHeight * cr;
    sx = (image.naturalWidth - sw) / 2;
  } else {
    sh = image.naturalWidth / cr;
    sy = (image.naturalHeight - sh) / 2;
  }

  ctx.fillStyle = "#02070a";
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, cw, ch);
}

function drawFrame(frame, force = false) {
  if (!ctx || (!force && frame === drawnFrame)) return;
  const entry = frameCache.get(frame);
  if (entry?.loaded) {
    drawCover(entry.image);
    drawnFrame = frame;
    return;
  }

  let nearest = null;
  let nearestDistance = Infinity;
  for (const [candidate, cached] of frameCache) {
    if (!cached.loaded) continue;
    const distance = Math.abs(candidate - frame);
    if (distance < nearestDistance) {
      nearest = cached.image;
      nearestDistance = distance;
    }
  }
  if (nearest) drawCover(nearest);
}

function setActiveBeat(progress) {
  const index = Math.min(beats.length - 1, Math.floor(clamp(progress) * beats.length));
  beats.forEach((beat, beatIndex) => beat.classList.toggle("is-active", beatIndex === index));
}

function updateStory() {
  scrollRaf = 0;
  if (!story || !canvas) return;

  const rect = story.getBoundingClientRect();
  const travel = Math.max(1, rect.height - window.innerHeight);
  const progress = reduceMotion.matches ? 0.5 : clamp(-rect.top / travel);
  const nextFrame = Math.round(progress * (FRAME_COUNT - 1)) + 1;

  activeFrame = nextFrame;
  progressBar?.style.setProperty("width", `${(progress * 100).toFixed(2)}%`);
  if (frameStatus) frameStatus.textContent = `${String(nextFrame).padStart(3, "0")} / ${FRAME_COUNT}`;
  setActiveBeat(progress);

  const cached = frameCache.get(nextFrame);
  if (cached?.loaded) {
    drawFrame(nextFrame);
  } else {
    const requestId = ++frameRequest;
    loadFrame(nextFrame, true).then(() => {
      if (requestId === frameRequest || nextFrame === activeFrame) drawFrame(nextFrame);
    }).catch(() => {});
  }
  warmFrames(nextFrame);
}

function queueStoryUpdate() {
  if (!scrollRaf) scrollRaf = requestAnimationFrame(updateStory);
  nav?.classList.toggle("is-scrolled", window.scrollY > 18);
}

function queueResize() {
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    resizeCanvas();
    updateStory();
  });
}

function setupReveal() {
  const items = document.querySelectorAll(".reveal");
  if (reduceMotion.matches || !("IntersectionObserver" in window)) {
    items.forEach((item) => item.classList.add("is-visible"));
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.12, rootMargin: "0px 0px -7% 0px" });

  items.forEach((item) => observer.observe(item));
}

function setupDeviceParallax() {
  const shell = document.querySelector(".hero-device");
  const device = document.querySelector(".device-frame");
  if (!shell || !device || reduceMotion.matches || !window.matchMedia("(pointer:fine)").matches) return;

  shell.addEventListener("pointermove", (event) => {
    const rect = shell.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    device.style.transform = `rotateY(${(-10 + x * 5).toFixed(2)}deg) rotateX(${(5 - y * 4).toFixed(2)}deg) rotateZ(1.3deg) translate3d(${(x * 5).toFixed(1)}px, ${(y * 4).toFixed(1)}px, 0)`;
  });

  shell.addEventListener("pointerleave", () => {
    device.style.transform = "rotateY(-10deg) rotateX(5deg) rotateZ(1.3deg)";
  });
}

async function initializeStory() {
  if (!canvas || !ctx) return;
  const initialFrame = reduceMotion.matches ? 96 : 1;
  activeFrame = initialFrame;
  await loadFrame(initialFrame, true).catch(() => null);
  resizeCanvas();
  warmFrames(initialFrame);
  updateStory();
}

setupReveal();
setupDeviceParallax();
initializeStory();
queueStoryUpdate();

window.addEventListener("scroll", queueStoryUpdate, { passive: true });
window.addEventListener("resize", queueResize, { passive: true });
reduceMotion.addEventListener?.("change", () => {
  document.querySelectorAll(".reveal").forEach((item) => item.classList.add("is-visible"));
  queueResize();
});
