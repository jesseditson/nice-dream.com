(() => {
  const canvas = document.getElementById("bg-shader") as HTMLCanvasElement | null;
  const barRadio = document.getElementById("nd-area-bar") as HTMLInputElement | null;
  const gl = canvas?.getContext("webgl2", { alpha: false, antialias: false });
  if (!canvas || !barRadio || !gl) return;

  const vertexSource = `#version 300 es
void main() {
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

  const fragmentSource = `#version 300 es
precision highp float;
uniform vec3 iResolution;
uniform float iTime;
out vec4 outColor;

const vec3 MUSTARD = vec3(0.80, 0.62, 0.13);
const vec3 LILAC   = vec3(0.78, 0.64, 0.78);

void mainImage(out vec4 fragColor, vec2 fragCoord) {
    float mr = min(iResolution.x, iResolution.y);
    vec2 uv = (fragCoord * 2.0 - iResolution.xy) / mr;

    float d = -iTime * 0.5;
    float a = 0.0;
    for (float i = 0.0; i < 8.0; ++i) {
        a += cos(i - d - a * uv.x);
        d += sin(uv.y * i + a);
    }
    d += iTime * 0.5;
    vec3 col = vec3(cos(uv * vec2(d, a)) * 0.6 + 0.4, cos(a + d) * 0.5 + 0.5);
    col = cos(col * cos(vec3(d, a, 2.5)) * 0.5 + 0.5);

    // Blue barely varies in the source palette; red vs. green carries the hue, red + green the light.
    float hue   = smoothstep(-0.25, 0.17, col.r - col.g);
    float light = smoothstep(0.55, 0.95, (col.r + col.g) * 0.5);
    col = mix(MUSTARD, LILAC, hue) * mix(0.85, 1.12, light);
    fragColor = vec4(col, 1);
}

void main() {
  mainImage(outColor, gl_FragCoord.xy);
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
  const resolution = gl.getUniformLocation(program, "iResolution");
  const time = gl.getUniformLocation(program, "iTime");

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let frame = 0;

  const draw = (now: number) => {
    gl.uniform1f(time, reducedMotion.matches ? 0 : now / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!reducedMotion.matches) frame = requestAnimationFrame(draw);
  };

  const update = () => {
    cancelAnimationFrame(frame);
    canvas.classList.toggle("visible", barRadio.checked);
    if (barRadio.checked) frame = requestAnimationFrame(draw);
  };

  const resize = () => {
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform3f(resolution, canvas.width, canvas.height, 1);
    update();
  };

  new ResizeObserver(resize).observe(canvas);
  document.querySelectorAll<HTMLInputElement>('input[name="area"]').forEach((radio) => {
    radio.addEventListener("change", update);
  });
})();
