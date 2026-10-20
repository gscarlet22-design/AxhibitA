/**
 * GLSL ES 3.00 shaders. The dewarp math mirrors src/shared/dewarp/project.ts exactly — keep them in sync.
 */
export const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5); // y down
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

export const MAX_BOXES = 16

export const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform vec2 uSrcSize;    // full source size (px)
uniform vec4 uSrcRect;    // region covered by the texture (source px)
uniform vec2 uOutSize;    // viewport size (px)
uniform int uMode;        // 0 normal, 1 ptz, 2 pano, 3 dual pano
uniform vec2 uNormCenter; // normal: source px at viewport center
uniform float uNormScale; // normal: viewport px per source px
uniform vec3 uCalib;      // cx, cy, radius (px)
uniform float uFov;       // radians
uniform int uModel;       // 0 equidistant, 1 equisolid
uniform int uMount;       // 0 ceiling, 1 desk, 2 wall
uniform vec3 uPtz;        // pan, tilt, hfov (radians)
uniform vec3 uPano;       // offset, top, bottom (radians)
uniform int uBoxCount;
uniform vec4 uBoxes[${MAX_BOXES}];
uniform int uBoxStyle[${MAX_BOXES}]; // 0 blur, 1 pixelate, 2 solid
uniform float uTexScale;  // texture px per source px
uniform int uOutside;     // -1: redact inside the boxes; 0 blur / 1 pixelate / 2 solid: redact everything outside them
uniform float uGrid;      // >0: draw a faint grid outside the image (unused in export)

const float PI = 3.141592653589793;

vec3 mountToCam(vec3 w) {
  if (uMount == 0) return vec3(w.x, -w.z, w.y);
  if (uMount == 1) return vec3(w.x, w.z, -w.y);
  return w;
}

vec3 rotPitch(vec3 v, float t) {
  float c = cos(t), s = sin(t);
  return vec3(v.x, v.y * c + v.z * s, -v.y * s + v.z * c);
}

vec3 rotYaw(vec3 v, float p) {
  float c = cos(p), s = sin(p);
  return vec3(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
}

float lensRadius(float theta) {
  if (uModel == 1) return uCalib.z * sin(theta * 0.5) / sin(uFov * 0.25);
  return theta / (uFov * 0.5) * uCalib.z;
}

vec3 azEl(float az, float el) {
  return vec3(sin(az) * cos(el), sin(el), cos(az) * cos(el));
}

// returns source px, or (-1e6) if outside lens
vec2 worldToSource(vec3 dw) {
  vec3 d = normalize(mountToCam(dw));
  float theta = acos(clamp(d.z, -1.0, 1.0));
  if (theta > uFov * 0.5) return vec2(-1e6);
  float phi = atan(d.y, d.x);
  float rho = lensRadius(theta);
  return uCalib.xy + rho * vec2(cos(phi), sin(phi));
}

vec3 panoRay(float x, float y, float offset) {
  if (uMount == 2) {
    float span = min(uFov, PI);
    return azEl(offset + (x - 0.5) * span, (-0.25 + y * 0.5) * PI);
  }
  float az = offset + x * 2.0 * PI;
  float el = (uMount == 1) ? -(uPano.z - y * (uPano.z - uPano.y)) : (uPano.y + y * (uPano.z - uPano.y));
  return azEl(az, el);
}

vec4 sampleTex(vec2 p, float lod) {
  vec2 uv = (p - uSrcRect.xy) / uSrcRect.zw;
  if (lod > 0.0) return textureLod(uTex, uv, lod);
  return texture(uTex, uv);
}

// "everything but the boxes": the rest of the frame, with strength relative to the whole frame
// (blocks anchored at the source origin, so screen and export agree whatever region is decoded)
vec4 redactFrame(vec2 p, int st) {
  if (st == 2) return vec4(0.06, 0.06, 0.07, 1.0);
  float m = max(uSrcSize.x, uSrcSize.y);
  if (st == 1) {
    float block = max(8.0, m / 60.0);
    vec2 q = clamp((floor(p / block) + 0.5) * block, vec2(0.0), uSrcSize - 1.0);
    return sampleTex(q, max(0.0, log2(block * uTexScale) - 1.0));
  }
  return sampleTex(p, max(1.0, log2(max(1.0, m * uTexScale / 40.0))));
}

vec4 sampleSource(vec2 p) {
  if (p.x < 0.0 || p.y < 0.0 || p.x >= uSrcSize.x || p.y >= uSrcSize.y) return vec4(0.0, 0.0, 0.0, 1.0);
  for (int i = 0; i < ${MAX_BOXES}; i++) {
    if (i >= uBoxCount) break;
    vec4 b = uBoxes[i];
    if (p.x >= b.x && p.y >= b.y && p.x <= b.x + b.z && p.y <= b.y + b.w) {
      if (uOutside >= 0) return sampleTex(p, 0.0); // inside a box stays visible
      int st = uBoxStyle[i];
      if (st == 2) return vec4(0.06, 0.06, 0.07, 1.0);
      float m = max(b.z, b.w);
      if (st == 1) {
        float block = max(8.0, m / 10.0);
        vec2 q = b.xy + (floor((p - b.xy) / block) + 0.5) * block;
        q = clamp(q, b.xy, b.xy + b.zw);
        return sampleTex(q, max(0.0, log2(block * uTexScale) - 1.0));
      }
      // blur: heavy mip level relative to the box size
      return sampleTex(p, max(1.0, log2(max(1.0, m * uTexScale / 5.0))));
    }
  }
  if (uOutside >= 0) return redactFrame(p, uOutside);
  return sampleTex(p, 0.0);
}

void main() {
  vec2 o = vUv * uOutSize;
  vec2 p;
  if (uMode == 0) {
    p = uNormCenter + (o - uOutSize * 0.5) / uNormScale;
  } else {
    vec3 dw;
    if (uMode == 1) {
      float t = tan(uPtz.z * 0.5);
      float aspect = uOutSize.x / uOutSize.y;
      vec2 uv = vUv * 2.0 - 1.0;
      dw = normalize(vec3(uv.x * t, uv.y * t / aspect, 1.0));
      dw = rotPitch(dw, uPtz.y);
      dw = rotYaw(dw, uPtz.x);
    } else if (uMode == 2) {
      dw = panoRay(vUv.x, vUv.y, uPano.x);
    } else {
      bool top = vUv.y < 0.5;
      float ly = top ? vUv.y * 2.0 : (vUv.y - 0.5) * 2.0;
      dw = panoRay(vUv.x * 0.5, ly, uPano.x + (top ? 0.0 : PI));
    }
    p = worldToSource(dw);
    if (p.x < -1e5) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  }
  outColor = sampleSource(p);
}`
