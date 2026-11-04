(() => {
  const canvas = document.querySelector<HTMLCanvasElement>(".clouds");
  const gl = canvas?.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false });
  if (!canvas || !gl) return;

  // Clouds are soft, so they're drawn at a fraction of the screen's resolution and scaled up.
  const RESOLUTION = 0.4;
  const FRAME_MS = 1000 / 30;

  const vertexSource = `
attribute vec2 corner;
void main() {
  gl_Position = vec4(corner, 0.0, 1.0);
}`;

  const fragmentSource = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 resolution;
uniform float time;
uniform float scroll;

vec2 gradient(vec2 p) {
  p = fract(p * vec2(0.1031, 0.1030));
  p += dot(p, p.yx + 33.33);
  float angle = fract((p.x + p.y) * p.x) * 6.2831853;
  return vec2(cos(angle), sin(angle));
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(
    mix(dot(gradient(i), f), dot(gradient(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
    mix(dot(gradient(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)), dot(gradient(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  mat2 rotate = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) {
    value += amplitude * noise(p);
    p = rotate * p;
    amplitude *= 0.45;
  }
  return value;
}

// One sheet of cloud: scale sets how big the puffs are, depth how fast it moves with the page,
// and cover how much sky is left clear (higher is clearer).
vec4 sheet(vec2 uv, float scale, float drift, float depth, float cover, float opacity, vec2 seed) {
  vec2 p = uv * scale + seed;
  p.x += time * drift;
  p.y -= scroll * depth * scale;
  vec2 q = p + 0.35 * vec2(fbm(p + vec2(0.0, time * 0.02)), fbm(p + vec2(5.2, 1.3)));
  // Both fields are rescaled to roughly unit spread: the broad one gathers the puffs into a few
  // drifting banks with open sky between, and cover is how far above average a spot must be to cloud.
  float density = fbm(q) / 0.11;
  float bank = noise(p * 0.3 + seed.yx) / 0.19;
  float shape = smoothstep(cover, cover + 0.9, density + 0.8 * bank);
  float lit = clamp((fbm(q) - fbm(q + vec2(-0.04, 0.06))) * 9.0 + 0.55, 0.0, 1.0);
  vec3 color = mix(vec3(0.93, 0.91, 0.85), vec3(1.0), lit);
  float alpha = shape * opacity;
  return vec4(color * alpha, alpha);
}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.y;
  vec4 far = sheet(uv, 3.0, 0.022, 0.45, 1.75, 0.6, vec2(11.0, 3.0));
  vec4 near = sheet(uv, 1.6, 0.038, 1.35, 1.85, 0.82, vec2(-7.0, 19.0));
  gl_FragColor = near + far * (1.0 - near.a);
}`;

  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  };

  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
  gl.useProgram(program);

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const corner = gl.getAttribLocation(program, "corner");
  gl.enableVertexAttribArray(corner);
  gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);

  const resolution = gl.getUniformLocation(program, "resolution");
  const time = gl.getUniformLocation(program, "time");
  const scroll = gl.getUniformLocation(program, "scroll");

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const startedAt = performance.now();
  let frame = 0;
  let lastDrawn = -Infinity;

  const draw = () => {
    const elapsed = reducedMotion.matches ? 0 : (performance.now() - startedAt) / 1000;
    gl.uniform1f(time, elapsed);
    gl.uniform1f(scroll, reducedMotion.matches ? 0 : window.scrollY / window.innerHeight);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    canvas.classList.add("clouds--ready");
  };

  const tick = (now: number) => {
    frame = requestAnimationFrame(tick);
    if (now - lastDrawn < FRAME_MS) return;
    lastDrawn = now;
    draw();
  };

  const start = () => {
    cancelAnimationFrame(frame);
    if (reducedMotion.matches) {
      draw();
    } else {
      frame = requestAnimationFrame(tick);
    }
  };

  const resize = () => {
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * RESOLUTION));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * RESOLUTION));
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(resolution, canvas.width, canvas.height);
    draw();
  };

  new ResizeObserver(resize).observe(canvas);
  reducedMotion.addEventListener("change", start);
  start();
})();
