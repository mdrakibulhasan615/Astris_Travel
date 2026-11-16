import { useEffect, useRef } from 'react';
import { useReducedMotion } from 'motion/react';

/**
 * An underwater-fluid backdrop: a full-screen WebGL fragment shader (domain-warped noise) that sways
 * a glowing orange crest over teal water, plus a film-grain overlay. Purely animated: it does not
 * react to the pointer. If WebGL is unavailable the CSS gradient underneath stays as the fallback.
 */

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
uniform vec2  uRes;
uniform float uTime;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2(17.1, 9.3);
    a *= 0.5;
  }
  return v;
}

// Colour by depth below the crest of the wave: black, red, orange, amber, grey-green, teal
vec3 ramp(float d) {
  vec3 black = vec3(0.016);
  vec3 red   = vec3(0.50, 0.05, 0.03);
  vec3 ora   = vec3(1.00, 0.27, 0.07);
  vec3 amb   = vec3(0.95, 0.63, 0.22);
  vec3 gry   = vec3(0.50, 0.57, 0.55);
  vec3 teal  = vec3(0.17, 0.38, 0.39);
  vec3 deep  = vec3(0.025, 0.15, 0.17);
  vec3 c = black;
  c = mix(c, red,  smoothstep(-0.04, 0.04, d));
  c = mix(c, ora,  smoothstep( 0.03, 0.13, d));
  c = mix(c, amb,  smoothstep( 0.12, 0.22, d));
  c = mix(c, gry,  smoothstep( 0.20, 0.35, d));
  c = mix(c, teal, smoothstep( 0.36, 0.64, d));
  c = mix(c, deep, smoothstep( 0.62, 1.05, d));
  return c;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float asp = uRes.x / uRes.y;
  vec2 p = vec2(uv.x * asp, uv.y);
  float t = uTime * 0.10;

  // Slow sub-surface currents: domain-warped noise bends the whole picture
  vec2 q = vec2(fbm(p * 1.2 + vec2(0.0, t * 1.5)), fbm(p * 1.2 + vec2(5.2, 1.3) - t * 1.2));
  vec2 w = p + (q - 0.5) * 0.40;

  // The glowing crest: a few swaying waves plus noise
  float crest = 0.79
    + 0.09 * sin(w.x * 2.1 + t * 5.0)
    + 0.05 * sin(w.x * 4.3 - t * 3.5 + 1.7)
    + (fbm(w * vec2(0.9, 0.6) + t) - 0.5) * 0.22
    + 0.07 * (0.5 - uv.x);

  float d = crest - w.y;                                   // depth below the crest
  d += (fbm(w * 2.2 + vec2(t * 2.0, 0.0)) - 0.5) * 0.20;  // ragged colour edges
  d += (noise(vec2(w.x * 1.4, t * 2.0)) - 0.5) * 0.26;     // teal pools sit lower in places
  d *= 1.35;                                               // a thinner glowing band

  vec3 c = ramp(d);

  // Light bleeding up into the dark above the crest
  c += vec3(0.42, 0.08, 0.02) * exp(-max(-d, 0.0) * 9.0) * 0.45;

  // A little caustic shimmer in the teal
  float sh = fbm(w * 5.0 + vec2(t * 3.0, -t * 2.0));
  c += vec3(0.02, 0.05, 0.05) * smoothstep(0.35, 0.8, d) * sh;

  // Vignette and fine in-shader grain
  c *= 1.0 - 0.45 * dot(uv - 0.5, uv - 0.5);
  c += (hash(gl_FragCoord.xy + floor(uTime * 24.0)) - 0.5) * 0.035;

  gl_FragColor = vec4(c, 1.0);
}
`;

const GRAIN =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1.4 -0.2'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")";

/** The water is soft, so it is drawn below full resolution and scaled up: cheap and smooth. */
const QUALITY = 0.7;

export function WaterBackground() {
  const reduce = useReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'high-performance' });
    if (!gl) return;

    const compile = (type: number, src: string) => {
      const s = gl.createShader(type);
      if (!s) return null;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(s));
        return null;
      }
      return s;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) return;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(prog));
      return;
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    const uRes = gl.getUniformLocation(prog, 'uRes');
    const uTime = gl.getUniformLocation(prog, 'uTime');

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const w = Math.max(2, Math.round(canvas.clientWidth * dpr * QUALITY));
      const h = Math.max(2, Math.round(canvas.clientHeight * dpr * QUALITY));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    };
    window.addEventListener('resize', resize);
    resize();

    const speed = reduce ? 0.25 : 1;
    const start = performance.now();
    let raf = 0;
    const frame = () => {
      // The offset gives a nicer starting shape
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, ((performance.now() - start) / 1000) * speed + 10);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
    };
  }, [reduce]);

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 block h-full w-full"
        style={{
          background:
            'radial-gradient(120% 70% at 30% 18%, #ff4a12 0%, #c9821f 22%, rgba(120,130,125,0) 48%), linear-gradient(to bottom, #050505 0%, #050505 12%, #8a948f 55%, #0c3a3d 100%)',
        }}
      />
      {/* Film grain, jittered in steps so it flickers like film */}
      <div
        className="water-grain absolute -inset-1/2"
        style={{ backgroundImage: GRAIN, opacity: 0.22, mixBlendMode: 'overlay', animation: reduce ? 'none' : undefined }}
      />
    </div>
  );
}
