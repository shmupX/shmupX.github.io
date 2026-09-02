// From a decoded sec7 model to screen-space triangles — everything a 3D
// viewer needs that is not the renderer itself.
//
// Phaser 4 has no 3D: its Mesh2D game object draws textured 2D triangles in
// the order its index list gives them, with no depth test, no face culling
// and one tint for the whole object. So the 3D work happens here, on the
// CPU, in plain arrays a Mesh2D (or a canvas, or a PS2 build) can consume:
//
//   buildModelMesh()  once per model: every part's library mesh transformed
//                     into world space as an unshared triangle soup with
//                     per-triangle normals and colours
//   orbitCamera()     a yaw / pitch / distance camera looking at a target
//   projectModel()    once per frame: project the soup, drop back faces
//                     (by the polygon normal, not by winding — the library's
//                     normals are authoritative, see mesh-library.js), shade
//                     flat from a fixed light, and sort far-to-near so a
//                     painter's draw is right for convex parts
//   packMesh2D()      write the sorted triangles as Phaser's flat
//                     [x, y, u, v] vertices and [a, b, c, page] indices,
//                     colour chosen by pointing every UV at a swatch cell
//
// Conventions, and where each one comes from (FORMAT.md "sec7 shape word and
// the ポリ吉 part library"):
//
//   - rotation order — TRACED from POLYKITI (2026-09-02). Its per-part render
//     routine (overlay +0x2728) calls the kernel's slTranslate, then slRotX
//     with the save's rotX, slRotY with rotY, slRotZ with rotZ, then slScale,
//     then puts the polygons. The kernel routines (0x06011218 / 290 / 308)
//     post-multiply the current matrix with the standard right-handed
//     rotation matrices (the sine lookup at 0x060118ac returns +sin for a
//     positive angle), and points transform as M * p, so the composed matrix
//     is M = T * Rx * Ry * Rz * S: a vertex sees the scale, then the Z
//     rotation, then Y, then X, then the translation. In this module's
//     first-applied-first naming that is ROTATION_ORDER = "zyx". The other
//     five orders stay selectable for comparison only.
//   - Y direction: model +Y is UP on screen. Settled empirically (2026-09-02):
//     DAIOH slot 0 rendered with no flip matches the save's own ポリ吉-rendered
//     ship sprite (needle nose at the top, engine nozzles at the bottom); the
//     part at y = -52 is the engine block. `yDown: true` negates world Y
//     after the transform for the opposite reading — positions and normals
//     flip together, so nothing else changes.
//   - the model colour word — TRACED. POLYKITI's shader (+0xa24c builds the
//     table, +0xb128 reads it) turns each polygon's own RGB555 channel c into
//     clamp(c + tint_c - 31 + light, floor_c, 31). So the per-model word is a
//     whole-model tint: white (31,31,31) is neutral and DAIOH's 0x4210 =
//     (16,16,16) pulls every channel down by 15 of 31 levels. buildModelMesh
//     applies it by default (`tint: true`).
//   - the light term — TRACED. The shader takes the 32.32 dot product of the
//     polygon normal (in view space) with the stored light vector and picks
//     row 16 + floor(16 * dot), clamped to 0..31; light = row - 16. The
//     capture path (+0x5018) sets the vector once, before any view or model
//     transform, as -(Rz(45deg) * Rx(-50deg) * (0, 0, 1)) — so in the
//     Saturn's view frame (x right, y down, z into the screen) the direction
//     TOWARD the light is (0.542, -0.542, -0.643): upper right, in front, and
//     fixed to the screen rather than to the model. LIGHT_VIEW carries that
//     as (right, up, toward-viewer) components and projectModel() rebuilds
//     the world-space vector from the camera basis every frame. The preview
//     lets the user turn the azimuth; the capture does not.
//   - the floors — TRACED with one caveat. Each channel's floor is a minimum
//     the shader clamps to. The master init (+0xf14) sets them once from the
//     word 0x9084 = (4, 4, 4), but the frame-setup handler (+0xa018) zeroes
//     them and the capture path issues a frame setup every time (kernel
//     0x06017C18 writes the window command); the sample game's own sprites
//     contain channels of 0 and 2, so the effective floor is taken as 0
//     (SHADE_FLOOR), with `floor` an option on buildModelMesh.
//   - rotation quantum: the editor steps rotations by 18 degrees and stores
//     them with a one- or two-unit drift; `quantize: true` snaps them.
//
// Environment-neutral ESM (Node + browser).

import { rgb555ToHex } from "../decode/decode-cg.js";
import { meshFor, placeholderLibrary, polygonCount } from "./mesh-library.js";

export const ROT_ORDERS = ["xyz", "xzy", "yxz", "yzx", "zxy", "zyx"];
/** Traced: the Saturn applies Z, then Y, then X to a part (see the header). */
export const ROTATION_ORDER = "zyx";
export const ROTATION_QUANTUM = 18;
/** Light rows of the Saturn's shade table: row = SHADE_ZERO + floor(16 * n.L). */
export const SHADE_LEVELS = 32;
export const SHADE_ZERO = 16;
/** Per-channel floor the shader clamps to at capture time (see the header). */
export const SHADE_FLOOR = 0;
/** The capture light: azimuth about Z, then tilt about X, applied to (0,0,1). */
export const LIGHT_AZIMUTH = 45;
export const LIGHT_TILT = -50;
/** Camera-space distance below which a triangle is dropped (near plane). */
export const NEAR = 4;

function normalize3(v) {
    const len = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / len, v[1] / len, v[2] / len];
}

const DEG = Math.PI / 180;

/**
 * The direction TOWARD the light in the camera frame, as (right, up,
 * toward-viewer) components, the way POLYKITI builds it: the stored vector is
 * -(Rz(azimuth) * Rx(tilt) * (0, 0, 1)) in the Saturn's view space, whose y
 * points down and z into the screen, so both of those flip here.
 */
export function saturnLightView(azimuthDeg = LIGHT_AZIMUTH, tiltDeg = LIGHT_TILT) {
    const ca = Math.cos(azimuthDeg * DEG), sa = Math.sin(azimuthDeg * DEG);
    const ct = Math.cos(tiltDeg * DEG), st = Math.sin(tiltDeg * DEG);
    // Rx(tilt) * (0, 0, 1) = (0, -st, ct); then Rz(azimuth)
    const x = -sa * -st, y = ca * -st, z = ct;
    // stored = -(x, y, z) is the direction toward the light in Saturn view
    // space; its y (down) and z (into the screen) become up and toward-viewer
    return normalize3([-x, y, z]);
}
export const LIGHT_VIEW = saturnLightView();

/**
 * The model colour word applied to one polygon colour, both RGB555, the way
 * POLYKITI's shade table does it without the light term:
 * out_c = clamp(c + tint_c - 31, 0, 31). White is the identity.
 */
export function tintRgb555(color, tint) {
    return shadeRgb555(color, SHADE_ZERO, tint, 0);
}

/**
 * The whole shader, per channel: clamp(c + tint_c - 31 + (row - 16), floor, 31).
 * `row` is a light row 0..31 (SHADE_ZERO = no light term).
 */
export function shadeRgb555(color, row, tint = 0x7fff, floor = SHADE_FLOOR) {
    const light = row - SHADE_ZERO;
    let out = 0;
    for (let shift = 0; shift <= 10; shift += 5) {
        const c = (color >> shift) & 31;
        const t = (tint >> shift) & 31;
        const v = Math.min(31, Math.max(floor, c + t - 31 + light));
        out |= v << shift;
    }
    return out;
}

/** 0..31 light row from the cosine between a normal and the light. */
export function shadeRow(ndotl) {
    const row = Math.floor(16 * ndotl) + SHADE_ZERO;
    return row < 0 ? 0 : row > SHADE_LEVELS - 1 ? SHADE_LEVELS - 1 : row;
}

/** Snap a rotation to the editor's step; wraps into [0, 360). */
export function quantizeRotation(deg, step = ROTATION_QUANTUM) {
    const q = Math.round(deg / step) * step;
    return ((q % 360) + 360) % 360;
}

function rotationMatrix(axis, deg) {
    const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
    switch (axis) {
        case "x":
            return [1, 0, 0, 0, c, -s, 0, s, c];
        case "y":
            return [c, 0, s, 0, 1, 0, -s, 0, c];
        default:
            return [c, -s, 0, s, c, 0, 0, 0, 1];
    }
}

function mul3(a, b) {
    const out = new Array(9);
    for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
            out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] +
                a[r * 3 + 2] * b[6 + c];
        }
    }
    return out;
}

/**
 * A part's model-to-world transform as a row-major 3x4 matrix
 * [a b c tx, d e f ty, g h i tz]: scale, then the rotations in `rotOrder`
 * (first letter first), then the translation.
 */
export function composeTransform(part, { rotOrder = ROTATION_ORDER, quantize = true } = {}) {
    if (!ROT_ORDERS.includes(rotOrder)) {
        throw new Error(`unknown rotation order ${rotOrder}`);
    }
    const rot = part.rotation || { x: 0, y: 0, z: 0 };
    const angle = (axis) => quantize ? quantizeRotation(rot[axis] || 0) : (rot[axis] || 0);
    let r = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    for (const axis of rotOrder) {
        // later rotations are applied after earlier ones: R = R_axis * R
        r = mul3(rotationMatrix(axis, angle(axis)), r);
    }
    const s = part.scale || { x: 1, y: 1, z: 1 };
    const p = part.position || { x: 0, y: 0, z: 0 };
    const m = new Float64Array(12);
    for (let row = 0; row < 3; row++) {
        m[row * 4] = r[row * 3] * s.x;
        m[row * 4 + 1] = r[row * 3 + 1] * s.y;
        m[row * 4 + 2] = r[row * 3 + 2] * s.z;
    }
    m[3] = p.x;
    m[7] = p.y;
    m[11] = p.z;
    return m;
}

export function transformPoint(m, x, y, z, out, o = 0) {
    out[o] = m[0] * x + m[1] * y + m[2] * z + m[3];
    out[o + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
    out[o + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
    return out;
}

/**
 * The inverse transpose of the 3x3 block, which carries normals through any
 * transform — a mirrored (negative-scale) part keeps outward normals with no
 * special case, because (M^-1)^T n always lies on the same side as M n.
 */
export function normalMatrix(m) {
    const a = m[0], b = m[1], c = m[2];
    const d = m[4], e = m[5], f = m[6];
    const g = m[8], h = m[9], i = m[10];
    const co = [
        e * i - f * h, -(d * i - f * g), d * h - e * g,
        -(b * i - c * h), a * i - c * g, -(a * h - b * g),
        b * f - c * e, -(a * f - c * d), a * e - b * d,
    ];
    const det = a * co[0] + b * co[1] + c * co[2];
    const inv = det === 0 ? 1 : 1 / det;
    // cofactor matrix / det = inverse transpose
    return Float64Array.from(co, (v) => v * inv);
}

/**
 * Every part of a model as one unshared triangle soup in world space.
 *
 *   positions Float32Array(triCount * 9)  three corners per triangle
 *   normals   Float32Array(triCount * 3)  unit, outward
 *   colors    Uint32Array(triCount)       0xRRGGBB, tinted, for display
 *   colors555 Uint16Array(triCount)       the polygon's own RGB555, what the
 *                                         shader starts from
 *   partOf    Uint8Array(triCount)        index into `parts`
 *   parts     [{ index, part, family, meshIndex, colorSet, source,
 *                triStart, triCount }]
 *   bounds    { min, max, center, radius }  radius = max |p - center|
 *   placeholder  true when any part fell back to placeholder geometry
 */
export function buildModelMesh(model, {
    library = placeholderLibrary(),
    yDown = false,
    rotOrder = ROTATION_ORDER,
    quantize = true,
    tint = true,
    floor = SHADE_FLOOR,
} = {}) {
    const partList = (model && model.parts) || [];
    // The per-model colour word is the whole-model tint (traced; header).
    const tintWord = tint && model && Number.isInteger(model.color) ? model.color & 0x7fff : 0x7fff;
    const resolved = partList.map((part) => ({ part, mesh: meshFor(library, part) }));
    let triCount = 0;
    for (const { mesh } of resolved) {
        const polys = polygonCount(mesh);
        for (let q = 0; q < polys; q++) {
            triCount += mesh.polygons[q * 4 + 2] === mesh.polygons[q * 4 + 3] ? 1 : 2;
        }
    }
    const positions = new Float32Array(triCount * 9);
    const normals = new Float32Array(triCount * 3);
    const colors = new Uint32Array(triCount);
    const colors555 = new Uint16Array(triCount);
    const partOf = new Uint8Array(triCount);
    const parts = [];
    const tmp = new Float64Array(3);
    const ySign = yDown ? -1 : 1;
    let t = 0;
    let placeholder = false;
    resolved.forEach(({ part, mesh }, index) => {
        const m = composeTransform(part, { rotOrder, quantize });
        const nm = normalMatrix(m);
        const setIndex = Math.min(Math.max(part.colorSet | 0, 0), mesh.colorSets.length - 1);
        const colorSet = mesh.colorSets[setIndex];
        const triStart = t;
        if (mesh.source !== "mdldt") placeholder = true;
        const polys = polygonCount(mesh);
        const emit = (q, a, b, c) => {
            const corners = [a, b, c];
            for (let k = 0; k < 3; k++) {
                const vi = corners[k] * 3;
                transformPoint(m, mesh.vertices[vi], mesh.vertices[vi + 1], mesh.vertices[vi + 2], tmp, 0);
                positions[t * 9 + k * 3] = tmp[0];
                positions[t * 9 + k * 3 + 1] = tmp[1] * ySign;
                positions[t * 9 + k * 3 + 2] = tmp[2];
            }
            const nx0 = mesh.normals[q * 3], ny0 = mesh.normals[q * 3 + 1], nz0 = mesh.normals[q * 3 + 2];
            let nx = nm[0] * nx0 + nm[1] * ny0 + nm[2] * nz0;
            let ny = nm[3] * nx0 + nm[4] * ny0 + nm[5] * nz0;
            let nz = nm[6] * nx0 + nm[7] * ny0 + nm[8] * nz0;
            const len = Math.hypot(nx, ny, nz) || 1;
            nx /= len;
            ny /= len;
            nz /= len;
            normals[t * 3] = nx;
            normals[t * 3 + 1] = ny * ySign;
            normals[t * 3 + 2] = nz;
            colors555[t] = colorSet[q] & 0x7fff;
            // display colour: tinted, no light term
            colors[t] = rgb555ToHex(shadeRgb555(colors555[t], SHADE_ZERO, tintWord, floor));
            partOf[t] = index;
            t++;
        };
        for (let q = 0; q < polys; q++) {
            const a = mesh.polygons[q * 4], b = mesh.polygons[q * 4 + 1];
            const c = mesh.polygons[q * 4 + 2], d = mesh.polygons[q * 4 + 3];
            emit(q, a, b, c);
            if (c !== d) emit(q, a, c, d);
        }
        parts.push({
            index,
            part,
            family: part.shapeFamily,
            meshIndex: part.meshIndex,
            colorSet: setIndex,
            source: mesh.source,
            triStart,
            triCount: t - triStart,
        });
    });
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            if (positions[i + k] < min[k]) min[k] = positions[i + k];
            if (positions[i + k] > max[k]) max[k] = positions[i + k];
        }
    }
    if (!triCount) {
        min.fill(0);
        max.fill(0);
    }
    const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    let radius = 0;
    for (let i = 0; i < positions.length; i += 3) {
        radius = Math.max(
            radius,
            Math.hypot(positions[i] - center[0], positions[i + 1] - center[1], positions[i + 2] - center[2]),
        );
    }
    return {
        positions,
        normals,
        colors,
        partOf,
        parts,
        triCount,
        bounds: { min, max, center, radius },
        placeholder,
        yDown,
        rotOrder,
        tint: tintWord,
        floor,
        colors555,
    };
}

/** Per-frame scratch buffers for projectModel(), sized to a model. */
export function allocFrame(mesh) {
    const n = mesh.triCount;
    return {
        triCount: n,
        xy: new Float32Array(n * 6),
        depth: new Float32Array(n),
        shade: new Uint8Array(n),
        visible: new Uint8Array(n),
        order: new Uint32Array(n),
        visibleCount: 0,
    };
}

/**
 * An orbit camera. yaw/pitch in degrees; the eye sits `distance` away from
 * `target` along the basis pixel-composer uses (yaw 0 / pitch 0 looks down
 * -Z with Y up). `focal` is the perspective scale in pixels.
 */
export function orbitCamera({
    yaw = 35,
    pitch = 25,
    distance = 200,
    focal = 360,
    width = 640,
    height = 400,
    target = [0, 0, 0],
    near = NEAR,
} = {}) {
    const t = yaw * DEG, p = pitch * DEG;
    const sinT = Math.sin(t), cosT = Math.cos(t);
    const sinP = Math.sin(p), cosP = Math.cos(p);
    const cam = [sinT * cosP, sinP, cosT * cosP];
    const right = [cosT, 0, -sinT];
    const up = [-sinT * sinP, cosP, -cosT * sinP];
    return {
        eye: [target[0] + cam[0] * distance, target[1] + cam[1] * distance, target[2] + cam[2] * distance],
        cam,
        right,
        up,
        focal,
        width,
        height,
        near,
        yaw,
        pitch,
        distance,
    };
}

/**
 * Project the soup through `cam` into `frame`: screen xy per corner,
 * visibility (front-facing and in front of the near plane), shade level and
 * a far-to-near draw order. Returns the visible count. No allocation.
 */
export function projectModel(mesh, cam, frame, lightView = LIGHT_VIEW) {
    const { positions, normals, triCount } = mesh;
    const { eye, cam: dir, right, up, focal, width, height, near } = cam;
    const cx = width / 2, cy = height / 2;
    const { xy, depth, shade, visible, order } = frame;
    // the light is fixed to the screen: rebuild it in world space from the
    // camera basis (dir points from the target toward the viewer)
    const lx = lightView[0] * right[0] + lightView[1] * up[0] + lightView[2] * dir[0];
    const ly = lightView[0] * right[1] + lightView[1] * up[1] + lightView[2] * dir[1];
    const lz = lightView[0] * right[2] + lightView[1] * up[2] + lightView[2] * dir[2];
    let n = 0;
    for (let t = 0; t < triCount; t++) {
        const p = t * 9;
        let far = -Infinity;
        let ok = true;
        let mx = 0, my = 0, mz = 0;
        for (let k = 0; k < 3 && ok; k++) {
            const px = positions[p + k * 3], py = positions[p + k * 3 + 1], pz = positions[p + k * 3 + 2];
            const dx = px - eye[0], dy = py - eye[1], dz = pz - eye[2];
            const vz = -(dx * dir[0] + dy * dir[1] + dz * dir[2]);
            if (vz < near) {
                ok = false;
                break;
            }
            const vx = dx * right[0] + dy * right[1] + dz * right[2];
            const vy = dx * up[0] + dy * up[1] + dz * up[2];
            xy[t * 6 + k * 2] = cx + focal * vx / vz;
            xy[t * 6 + k * 2 + 1] = cy - focal * vy / vz;
            if (vz > far) far = vz;
            mx += px;
            my += py;
            mz += pz;
        }
        if (!ok) {
            visible[t] = 0;
            continue;
        }
        const nx = normals[t * 3], ny = normals[t * 3 + 1], nz = normals[t * 3 + 2];
        // back-face: the normal must face the eye
        const facing = nx * (eye[0] - mx / 3) + ny * (eye[1] - my / 3) + nz * (eye[2] - mz / 3);
        if (facing <= 0) {
            visible[t] = 0;
            continue;
        }
        visible[t] = 1;
        depth[t] = far;
        shade[t] = shadeRow(nx * lx + ny * ly + nz * lz);
        order[n++] = t;
    }
    const slice = order.subarray(0, n);
    slice.sort((a, b) => depth[b] - depth[a]);
    frame.visibleCount = n;
    return n;
}

// ---------------------------------------------------------------------------
// Colour swatches: Mesh2D tints a whole object, so per-triangle colour comes
// from the texture. A swatch atlas holds SHADE_LEVELS cells (one per light
// row) per distinct polygon colour; a triangle's three UVs all point at the
// centre of its cell. 128 colours x 32 rows = 4096 cells of 4 px in 256 px.

export const MAX_SWATCH_COLORS = 128;
export const SWATCH_LAYOUT = { cellPx: 4, cols: 64, rows: 64, texPx: 256 };

/** Distinct RGB555 polygon colours of a soup (capped) and each triangle's index. */
export function buildSwatchTable(mesh, maxColors = MAX_SWATCH_COLORS) {
    const index = new Map();
    const colors = [];
    const triColor = new Uint16Array(mesh.triCount);
    for (let t = 0; t < mesh.triCount; t++) {
        const c = mesh.colors555[t];
        let i = index.get(c);
        if (i === undefined) {
            if (colors.length < maxColors) {
                i = colors.length;
                colors.push(c);
            } else {
                i = 0; // over budget: the first colour stands in
            }
            index.set(c, i);
        }
        triColor[t] = i;
    }
    return { colors: Uint16Array.from(colors), triColor };
}

export function swatchCell(colorIndex, level) {
    return colorIndex * SHADE_LEVELS + level;
}

/** Pixel rectangle of a swatch cell in the atlas. */
export function swatchCellRect(cell, layout = SWATCH_LAYOUT) {
    const col = cell % layout.cols;
    const row = (cell / layout.cols) | 0;
    return { x: col * layout.cellPx, y: row * layout.cellPx, w: layout.cellPx, h: layout.cellPx };
}

/** Texture coordinates of a cell's centre (safe under linear filtering). */
export function swatchUV(cell, layout = SWATCH_LAYOUT) {
    const r = swatchCellRect(cell, layout);
    return [(r.x + r.w / 2) / layout.texPx, (r.y + r.h / 2) / layout.texPx];
}

/** A polygon colour (RGB555) at a light row through the shader, 0xRRGGBB. */
export function swatchRgb(color555, row, tint = 0x7fff, floor = SHADE_FLOOR) {
    return rgb555ToHex(shadeRgb555(color555, row, tint, floor));
}

/**
 * Write the projected, sorted triangles as Phaser Mesh2D arrays into `out`:
 * out.vertices = [x, y, u, v] x 3 per triangle, out.indices = [a, b, c, 0]
 * (page 0: the swatch atlas has a single texture source). Both arrays are
 * reused and trimmed to the visible count.
 */
export function packMesh2D(mesh, frame, table, layout = SWATCH_LAYOUT, out = {}) {
    const n = frame.visibleCount;
    const vertices = out.vertices || (out.vertices = []);
    const indices = out.indices || (out.indices = []);
    vertices.length = n * 12;
    indices.length = n * 4;
    const { xy, shade, order } = frame;
    for (let r = 0; r < n; r++) {
        const t = order[r];
        const [u, v] = swatchUV(swatchCell(table.triColor[t], shade[t]), layout);
        for (let k = 0; k < 3; k++) {
            const o = r * 12 + k * 4;
            vertices[o] = xy[t * 6 + k * 2];
            vertices[o + 1] = xy[t * 6 + k * 2 + 1];
            vertices[o + 2] = u;
            vertices[o + 3] = v;
        }
        indices[r * 4] = r * 3;
        indices[r * 4 + 1] = r * 3 + 1;
        indices[r * 4 + 2] = r * 3 + 2;
        indices[r * 4 + 3] = 0;
    }
    out.count = n;
    return out;
}

/** Visible triangle edges as [x0, y0, x1, y1] x 3 per triangle, painter order. */
export function wireframeSegments(mesh, frame, out = []) {
    const n = frame.visibleCount;
    out.length = n * 12;
    const { xy, order } = frame;
    for (let r = 0; r < n; r++) {
        const t = order[r];
        for (let k = 0; k < 3; k++) {
            const a = t * 6 + k * 2, b = t * 6 + ((k + 1) % 3) * 2;
            const o = r * 12 + k * 4;
            out[o] = xy[a];
            out[o + 1] = xy[a + 1];
            out[o + 2] = xy[b];
            out[o + 3] = xy[b + 1];
        }
    }
    return out;
}

/** Slot and part totals of a decoded model list (for the editor's summary). */
export function modelStats(models) {
    const list = models || [];
    let parts = 0;
    for (const m of list) parts += (m.parts || []).length;
    return { slots: list.length, parts };
}
