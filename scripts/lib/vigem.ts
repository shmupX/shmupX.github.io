// A virtual DualShock 4 on the ViGEm bus (Nefarius' Virtual Gamepad Emulation
// Bus), for test drives that need a controller Windows and the browser take for
// a real one: it enumerates as USB\VID_054C&PID_<pid>, Chrome names it exactly
// as it names the hardware ("Wireless Controller (STANDARD GAMEPAD Vendor: 054c
// Product: 09cc)") and gives it the standard mapping, and nothing upstream of
// the Gamepad API can tell. scripts/testdrive-pad.ts is the drive built on it.
//
// WHY THE BUS IS CALLED DIRECTLY. ViGEm's own client is a C library nobody has
// on this path, and the Python wrapper that bundles it (vgamepad) runs the
// ViGEmBus installer on the way in — a driver change, which a test drive has no
// business making. The bus's user-mode protocol is five DeviceIoControl codes
// on one device interface, so they are issued here over FFI. The bus itself has
// to be installed already (DS4Windows and Steam-adjacent remappers bring it).
//
// The pad lives exactly as long as the bus handle: unplug() closes it, and so
// does this process dying, at which point the bus removes every target the
// handle owned. A crashed drive therefore never leaves a phantom controller
// plugged into the machine.
//
// The pure parts — the IOCTL codes and the request and report layouts — are
// exported for tests/testdrive_pad_test.ts; only VirtualDs4 touches FFI.

/** GUID_DEVINTERFACE_BUSENUM_VIGEM {96E42B22-F5E9-42F8-B043-ED0F932F014F}. */
export const VIGEM_BUS_GUID = new Uint8Array([
  0x22,
  0x2B,
  0xE4,
  0x96,
  0xE9,
  0xF5,
  0xF8,
  0x42,
  0xB0,
  0x43,
  0xED,
  0x0F,
  0x93,
  0x2F,
  0x01,
  0x4F,
]);

/** CTL_CODE(FILE_DEVICE_BUS_EXTENDER, IOCTL_VIGEM_BASE + fn, METHOD_BUFFERED, FILE_WRITE_DATA). */
export function vigemIoctl(fn: number): number {
  return (0x2A << 16) | (0x2 << 14) | ((0x801 + fn) << 2);
}

export const IOCTL_VIGEM_PLUGIN_TARGET = vigemIoctl(0x000);
export const IOCTL_VIGEM_UNPLUG_TARGET = vigemIoctl(0x001);
export const IOCTL_VIGEM_CHECK_VERSION = vigemIoctl(0x002);
export const IOCTL_VIGEM_WAIT_DEVICE_READY = vigemIoctl(0x003);
export const IOCTL_DS4_SUBMIT_REPORT = vigemIoctl(0x202);

/** VIGEM_TARGET_TYPE: Xbox360Wired = 0, XboxOneWired = 1, DualShock4Wired = 2. */
const DUALSHOCK4_WIRED = 2;
export const SONY_VENDOR_ID = 0x054C;
/** DS4 v2 (CUH-ZCT2), the one Sony sells now; 0x05C4 is the first model. */
export const DS4_V2_PRODUCT_ID = 0x09CC;

/** The D-pad is a hat in the low nibble of wButtons; 8 is "not pressed". */
export const DS4_DPAD = {
  N: 0,
  NE: 1,
  E: 2,
  SE: 3,
  S: 4,
  SW: 5,
  W: 6,
  NW: 7,
  NONE: 8,
} as const;
export type Ds4Dpad = keyof typeof DS4_DPAD;

export const DS4_BUTTON = {
  square: 1 << 4,
  cross: 1 << 5,
  circle: 1 << 6,
  triangle: 1 << 7,
  l1: 1 << 8,
  r1: 1 << 9,
  l2: 1 << 10,
  r2: 1 << 11,
  share: 1 << 12,
  options: 1 << 13,
  l3: 1 << 14,
  r3: 1 << 15,
} as const;
export type Ds4Button = keyof typeof DS4_BUTTON;

/** One frame of the pad. Sticks are 0-255 with 0x80 centred; LY 0 is UP. */
export interface Ds4State {
  lx?: number;
  ly?: number;
  rx?: number;
  ry?: number;
  dpad?: Ds4Dpad;
  buttons?: Ds4Button[];
  ps?: boolean;
  touchpad?: boolean;
  l2?: number;
  r2?: number;
}

/** VIGEM_PLUGIN_TARGET: Size, SerialNo, TargetType, VendorId, ProductId (16 bytes). */
export function pluginRequest(serial: number, productId: number): Uint8Array {
  const b = new Uint8Array(16);
  const v = new DataView(b.buffer);
  v.setUint32(0, 16, true);
  v.setUint32(4, serial, true);
  v.setInt32(8, DUALSHOCK4_WIRED, true);
  v.setUint16(12, SONY_VENDOR_ID, true);
  v.setUint16(14, productId, true);
  return b;
}

/** The {ULONG Size; ULONG value} shape CHECK_VERSION, WAIT_DEVICE_READY and UNPLUG share. */
export function sizedRequest(value: number): Uint8Array {
  const b = new Uint8Array(8);
  const v = new DataView(b.buffer);
  v.setUint32(0, 8, true);
  v.setUint32(4, value, true);
  return b;
}

/**
 * DS4_SUBMIT_REPORT: Size, SerialNo, then the 9-byte DS4_REPORT (LX LY RX RY,
 * USHORT wButtons, bSpecial, L2, R2) at natural alignment — 20 bytes, which is
 * the Size the bus checks to tell this from the 63-byte extended report.
 */
export function ds4SubmitRequest(serial: number, s: Ds4State = {}): Uint8Array {
  const b = new Uint8Array(20);
  const v = new DataView(b.buffer);
  v.setUint32(0, 20, true);
  v.setUint32(4, serial, true);
  b[8] = s.lx ?? 0x80;
  b[9] = s.ly ?? 0x80;
  b[10] = s.rx ?? 0x80;
  b[11] = s.ry ?? 0x80;
  let buttons: number = DS4_DPAD[s.dpad ?? "NONE"];
  for (const name of s.buttons ?? []) buttons |= DS4_BUTTON[name];
  v.setUint16(12, buttons, true);
  b[14] = (s.ps ? 1 : 0) | (s.touchpad ? 2 : 0);
  b[15] = s.l2 ?? 0;
  b[16] = s.r2 ?? 0;
  return b;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function utf16z(s: string): Uint8Array {
  const u = new Uint16Array(s.length + 1);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return new Uint8Array(u.buffer);
}

const IO = [
  "pointer",
  "u32",
  "buffer",
  "u32",
  "buffer",
  "u32",
  "buffer",
  "pointer",
] as const;

function openWin32() {
  const kernel32 = Deno.dlopen("kernel32.dll", {
    CreateFileW: {
      parameters: ["buffer", "u32", "u32", "pointer", "u32", "u32", "pointer"],
      result: "pointer",
    },
    DeviceIoControl: { parameters: IO, result: "i32" },
    // WAIT_DEVICE_READY pends until Windows has started the new device, so it
    // runs off the main thread where a timeout can be raced against it.
    DeviceIoControlAsync: {
      name: "DeviceIoControl",
      parameters: IO,
      result: "i32",
      nonblocking: true,
    },
    CloseHandle: { parameters: ["pointer"], result: "i32" },
    GetLastError: { parameters: [], result: "u32" },
  });
  const setupapi = Deno.dlopen("setupapi.dll", {
    SetupDiGetClassDevsW: {
      parameters: ["buffer", "pointer", "pointer", "u32"],
      result: "pointer",
    },
    SetupDiEnumDeviceInterfaces: {
      parameters: ["pointer", "pointer", "buffer", "u32", "buffer"],
      result: "i32",
    },
    SetupDiGetDeviceInterfaceDetailW: {
      parameters: ["pointer", "buffer", "buffer", "u32", "buffer", "pointer"],
      result: "i32",
    },
    SetupDiDestroyDeviceInfoList: { parameters: ["pointer"], result: "i32" },
  });
  return { kernel32, setupapi };
}
type Win32 = ReturnType<typeof openWin32>;

function invalidHandle(h: Deno.PointerValue): boolean {
  return h === null ||
    BigInt(Deno.UnsafePointer.value(h)) === 0xFFFF_FFFF_FFFF_FFFFn;
}

/** The bus's device path, e.g. \\?\root#system#0001#{96e42b22-…}. */
function busPath(w: Win32): string {
  const sa = w.setupapi.symbols;
  // DIGCF_PRESENT | DIGCF_DEVICEINTERFACE
  const set = sa.SetupDiGetClassDevsW(VIGEM_BUS_GUID, null, null, 0x2 | 0x10);
  if (invalidHandle(set)) throw new Error("SetupDiGetClassDevsW failed");
  try {
    // SP_DEVICE_INTERFACE_DATA on 64-bit: cbSize, GUID, Flags, ULONG_PTR.
    const ifd = new Uint8Array(32);
    new DataView(ifd.buffer).setUint32(0, 32, true);
    if (!sa.SetupDiEnumDeviceInterfaces(set, null, VIGEM_BUS_GUID, 0, ifd)) {
      throw new Error(
        "no ViGEm bus on this machine. Install ViGEmBus (Nefarius Software " +
          "Solutions) first; this drive plugs its virtual pad into that driver.",
      );
    }
    const need = new Uint8Array(4);
    sa.SetupDiGetDeviceInterfaceDetailW(set, ifd, null, 0, need, null);
    const size = new DataView(need.buffer).getUint32(0, true);
    const detail = new Uint8Array(Math.max(size, 8));
    // sizeof(SP_DEVICE_INTERFACE_DETAIL_DATA_W) on 64-bit: a DWORD and one
    // WCHAR, padded to 8 — not the 6 the fields add up to.
    new DataView(detail.buffer).setUint32(0, 8, true);
    if (
      !sa.SetupDiGetDeviceInterfaceDetailW(set, ifd, detail, size, null, null)
    ) {
      throw new Error("SetupDiGetDeviceInterfaceDetailW failed");
    }
    const chars = new Uint16Array(detail.buffer, 4, (detail.length - 4) >> 1);
    const end = chars.indexOf(0);
    return String.fromCharCode(
      ...chars.subarray(0, end < 0 ? chars.length : end),
    );
  } finally {
    sa.SetupDiDestroyDeviceInfoList(set);
  }
}

/** A DualShock 4 plugged into the ViGEm bus for as long as this object lives. */
export class VirtualDs4 {
  readonly serial: number;
  readonly productId: number;
  readonly busPath: string;
  #w: Win32;
  #bus: Deno.PointerValue;
  #closed = false;

  private constructor(
    w: Win32,
    bus: Deno.PointerValue,
    path: string,
    serial: number,
    productId: number,
  ) {
    this.#w = w;
    this.#bus = bus;
    this.busPath = path;
    this.serial = serial;
    this.productId = productId;
  }

  static async plug(
    opts: { productId?: number; readyTimeoutMs?: number } = {},
  ): Promise<VirtualDs4> {
    if (Deno.build.os !== "windows") {
      throw new Error(
        `a ViGEm pad needs Windows (this is ${Deno.build.os}); the bus is a Windows driver`,
      );
    }
    const productId = opts.productId ?? DS4_V2_PRODUCT_ID;
    const w = openWin32();
    const k = w.kernel32.symbols;
    const ioctl = (h: Deno.PointerValue, code: number, req: Uint8Array) =>
      k.DeviceIoControl(
        h,
        code,
        req,
        req.length,
        req,
        req.length,
        new Uint8Array(4),
        null,
      ) !== 0;
    let bus: Deno.PointerValue = null;
    let serial = 0;
    try {
      const path = busPath(w);
      // GENERIC_READ | GENERIC_WRITE, shared, OPEN_EXISTING, NORMAL |
      // NO_BUFFERING | WRITE_THROUGH — the client library's flags minus
      // OVERLAPPED, which nothing here needs.
      bus = k.CreateFileW(
        utf16z(path),
        0xC0000000,
        0x3,
        null,
        3,
        0xA0000080,
        null,
      );
      if (invalidHandle(bus)) {
        throw new Error(
          `could not open the ViGEm bus at ${path} (error ${k.GetLastError()})`,
        );
      }
      if (!ioctl(bus, IOCTL_VIGEM_CHECK_VERSION, sizedRequest(0x0001))) {
        throw new Error(
          `the ViGEm bus refused the version check (error ${k.GetLastError()})`,
        );
      }
      // Serials are per bus; one a DS4Windows or another drive already holds
      // is refused, and the next is tried — which is what the client does.
      for (let s = 1; s <= 16 && !serial; s++) {
        if (
          ioctl(bus, IOCTL_VIGEM_PLUGIN_TARGET, pluginRequest(s, productId))
        ) serial = s;
      }
      if (!serial) {
        throw new Error(
          `the ViGEm bus refused to plug in a DS4 (error ${k.GetLastError()})`,
        );
      }
      const ready = sizedRequest(serial);
      const timeout = opts.readyTimeoutMs ?? 10_000;
      const ok = await Promise.race([
        k.DeviceIoControlAsync(
          bus,
          IOCTL_VIGEM_WAIT_DEVICE_READY,
          ready,
          8,
          ready,
          8,
          new Uint8Array(4),
          null,
        ),
        sleep(timeout).then(() => -1),
      ]);
      if (ok === -1) {
        throw new Error(`the virtual DS4 was not ready after ${timeout} ms`);
      }
      const pad = new VirtualDs4(w, bus, path, serial, productId);
      // Measured: the first report after WAIT_DEVICE_READY is refused (error
      // 259) while the HID stack is still opening the device, and every one
      // after it lands. Retry the neutral frame until one does.
      for (let i = 0; i < 40; i++) {
        if (pad.#submit({})) return pad;
        await sleep(50);
      }
      throw new Error("the virtual DS4 never accepted a report");
    } catch (err) {
      if (!invalidHandle(bus)) {
        if (serial) ioctl(bus, IOCTL_VIGEM_UNPLUG_TARGET, sizedRequest(serial));
        k.CloseHandle(bus);
      }
      // The libraries stay loaded: a timed-out WAIT_DEVICE_READY may still be
      // running on its own thread, and unloading under it would crash the
      // process this error is meant to explain.
      throw err;
    }
  }

  #submit(state: Ds4State): boolean {
    const req = ds4SubmitRequest(this.serial, state);
    return this.#w.kernel32.symbols.DeviceIoControl(
      this.#bus,
      IOCTL_DS4_SUBMIT_REPORT,
      req,
      req.length,
      req,
      req.length,
      new Uint8Array(4),
      null,
    ) !== 0;
  }

  /** Hold `state` for the next report; anything left out is neutral. */
  set(state: Ds4State): void {
    if (this.#closed) throw new Error("the virtual DS4 is unplugged");
    if (!this.#submit(state)) {
      throw new Error(
        `the bus refused a DS4 report (error ${this.#w.kernel32.symbols.GetLastError()})`,
      );
    }
  }

  /** Hold `state` for `ms`, then let go — one tap of a real thumb. */
  async press(state: Ds4State, ms = 150): Promise<void> {
    this.set(state);
    await sleep(ms);
    this.set({});
  }

  unplug(): void {
    if (this.#closed) return;
    this.#closed = true;
    const k = this.#w.kernel32.symbols;
    const req = sizedRequest(this.serial);
    k.DeviceIoControl(
      this.#bus,
      IOCTL_VIGEM_UNPLUG_TARGET,
      req,
      8,
      req,
      8,
      new Uint8Array(4),
      null,
    );
    k.CloseHandle(this.#bus);
    this.#w.kernel32.close();
    this.#w.setupapi.close();
  }
}
