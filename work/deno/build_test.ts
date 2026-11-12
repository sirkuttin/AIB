/**
 * tools/build.ts at unit level (no `deno desktop` run here): asset names for every target and that the updater picks them,
 * SHA256SUMS format (and that the updater reads it), the size guard, the zip writer's unix modes and contents, the .icns header,
 * what is staged, the generated app icon files (tools/make_icons.ts), the Linux package fixes (tools/linux_package.ts), and the Windows launcher icon (.ico parser, group-icon bytes, and embedding into a copy of where.exe).
 * The keeper step: Go target names and build flags per target, adding the keeper to a .deb and an AppImage (multi-block file),
 * and (when Go is installed) a real keeper build for this machine that answers `version`.
 */
import { assert, assertEquals, assertRejects, assertThrows } from "./_assert.ts";
import {
  APP_VERSION,
} from "../../outputs/agent-studio/server/core/app.ts";
import {
  assetNames,
  buildKeeper,
  checkSize,
  DEB_KEEPER_PATH,
  crc32,
  decodePng,
  embedWindowsIcon,
  goCommand,
  goTarget,
  groupIconBytes,
  keeperBuildArgs,
  keeperFile,
  makeIcns,
  makeIco,
  modeFor,
  parseIco,
  parseTargets,
  pngSize,
  readIconResources,
  readZipListing,
  sha256sums,
  SIZE_LIMIT,
  stagedConfig,
  stagedName,
  TARGETS,
  writeZip,
  zipFolder,
} from "../../tools/build.ts";
import {
  encodePng,
  FAVICON_PAGES,
  faviconLink,
  GRID_SIZES,
  HAT,
  hasColour,
  ICO_SIZES,
  icoMaster,
  ICON_SRC,
  parseGrid,
  PNGS,
  RIM,
  TRAY,
} from "../../tools/make_icons.ts";
import { TRAY_PNG_BASE64 } from "../../outputs/agent-studio/server/desktop/tray_icon_data.ts";
import {
  checksumFor,
  pickAsset,
} from "../../outputs/agent-studio/server/desktop/updater.ts";
import {
  addTarFile,
  addToAppImage,
  addToDeb,
  appImageOffset,
  editTar,
  fixAppImage,
  fixDeb,
  fixDesktopEntry,
  readAr,
  readSqFile,
  readSquashfs,
  type SqNode,
  wantedMode,
  writeAr,
  writeSquashfs,
} from "../../tools/linux_package.ts";

const WINDOWS = Deno.build.os === "windows";

Deno.test("asset names for the six targets, and the updater picks each one for its platform", () => {
  const v = "0.2.0-beta.1";
  const all = TARGETS.flatMap((t) => assetNames(v, t));
  assertEquals(all, [
    "AIB-0.2.0-beta.1-windows-x64.zip",
    "AIB-0.2.0-beta.1-windows-arm64.zip",
    "AIB-0.2.0-beta.1-macos-x64.zip",
    "AIB-0.2.0-beta.1-macos-arm64.zip",
    "AIB-0.2.0-beta.1-linux-x64.AppImage",
    "AIB-0.2.0-beta.1-linux-x64.deb",
    "AIB-0.2.0-beta.1-linux-arm64.AppImage",
    "AIB-0.2.0-beta.1-linux-arm64.deb",
  ]);
  assertEquals(TARGETS.map((t) => t.triple), [
    "x86_64-pc-windows-msvc",
    "aarch64-pc-windows-msvc",
    "x86_64-apple-darwin",
    "aarch64-apple-darwin",
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
  ]);
  const assets = all.map((name) => ({ name, state: "uploaded", url: "u/" + name }));
  for (const t of TARGETS) {
    const [first, second] = assetNames(v, t);
    assertEquals(pickAsset(assets, [t.os, t.arch], { APPIMAGE: "/a" })?.name, first, t.id);
    if (second) assertEquals(pickAsset(assets, [t.os, t.arch], {}, () => true)?.name, second, t.id + " deb");
  }
  assertEquals(parseTargets("all"), TARGETS);
  assertEquals(parseTargets("linux-arm64,windows-x64").map((t) => t.id), ["linux-arm64", "windows-x64"]);
  assertThrows(() => parseTargets("windows-x86"));
  assert(/^\d+\.\d+\.\d+/.test(APP_VERSION), "the build's version is APP_VERSION");
});

Deno.test("SHA256SUMS is sha256sum's format, sorted, and the updater reads each line", () => {
  const a = "a".repeat(64), b = "b".repeat(64);
  const text = sha256sums([{ name: "AIB-1-windows-x64.zip", sha256: b }, { name: "AIB-1-linux-x64.deb", sha256: a }]);
  assertEquals(text, `${a}  AIB-1-linux-x64.deb\n${b}  AIB-1-windows-x64.zip\n`);
  assertEquals(checksumFor(text, "AIB-1-windows-x64.zip"), b);
  assertEquals(checksumFor(text, "AIB-1-linux-x64.deb"), a);
});

Deno.test("the size guard", () => {
  assertEquals(SIZE_LIMIT, 160 * 1024 * 1024);
  checkSize("ok.zip", SIZE_LIMIT);
  const error = assertThrows(() => checkSize("big.zip", SIZE_LIMIT + 1));
  assert(error.message.includes("big.zip") && error.message.includes("160 MB"), error.message);
  assertThrows(() => checkSize("small-limit", 11, 10));
});

Deno.test("crc32 and the zip writer: unix modes read back, contents survive (and Windows tar.exe extracts it)", async () => {
  assertEquals(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  const dir = Deno.makeTempDirSync({ prefix: "aib-build-zip-" });
  try {
    const big = new TextEncoder().encode("compress me ".repeat(5000));
    await writeZip(`${dir}/t.zip`, [
      { name: "AIB.app/", mode: 0o755 },
      { name: "AIB.app/Contents/MacOS/laufey_webview", data: big, mode: 0o755 },
      { name: "AIB.app/Contents/Info.plist", data: new TextEncoder().encode("<plist/>"), mode: 0o644 },
      { name: "AIB.app/Contents/empty", data: new Uint8Array(0), mode: 0o600 },
      { name: "AIB.app/Contents/link", data: new TextEncoder().encode("MacOS/laufey_webview"), mode: 0o755, symlink: true },
    ]);
    const listing = readZipListing(Deno.readFileSync(`${dir}/t.zip`));
    assertEquals(listing.map((e) => [e.name, e.mode.toString(8), e.madeBy]), [
      ["AIB.app/", "40755", 3],
      ["AIB.app/Contents/MacOS/laufey_webview", "100755", 3],
      ["AIB.app/Contents/Info.plist", "100644", 3],
      ["AIB.app/Contents/empty", "100600", 3],
      ["AIB.app/Contents/link", "120755", 3],
    ]);
    assertEquals(listing[1].method, 8, "deflated");
    assertEquals(listing[1].size, big.length);
    if (WINDOWS) {
      const root = Deno.env.get("SystemRoot") || "C:\\Windows";
      Deno.mkdirSync(`${dir}/x`);
      const out = await new Deno.Command(`${root}\\System32\\tar.exe`, {
        args: ["-xf", `${dir}/t.zip`, "-C", `${dir}/x`, "AIB.app/Contents/MacOS", "AIB.app/Contents/Info.plist"],
        stdout: "null",
        stderr: "piped",
      }).output();
      assert(out.success, new TextDecoder().decode(out.stderr));
      assertEquals(Deno.readFileSync(`${dir}/x/AIB.app/Contents/MacOS/laufey_webview`), big);
      assertEquals(Deno.readTextFileSync(`${dir}/x/AIB.app/Contents/Info.plist`), "<plist/>");
    }
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("zipFolder: a macOS bundle keeps its executables at 0755, the rest 0644, folders 0755", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "aib-build-folder-" });
  try {
    const app = `${dir}/AIB.app`;
    Deno.mkdirSync(`${app}/Contents/MacOS`, { recursive: true });
    Deno.mkdirSync(`${app}/Contents/Resources`);
    Deno.writeTextFileSync(`${app}/Contents/MacOS/laufey_webview`, "bin");
    Deno.writeTextFileSync(`${app}/Contents/MacOS/libruntime.dylib`, "lib");
    Deno.writeTextFileSync(`${app}/Contents/Info.plist`, "p");
    Deno.writeTextFileSync(`${app}/Contents/Resources/AppIcon.icns`, "i");
    await zipFolder(app, `${dir}/m.zip`, "AIB.app");
    const modes = Object.fromEntries(readZipListing(Deno.readFileSync(`${dir}/m.zip`)).map((e) => [e.name, e.mode & 0o7777]));
    assertEquals(modes, {
      "AIB.app/": 0o755,
      "AIB.app/Contents/": 0o755,
      "AIB.app/Contents/Info.plist": 0o644,
      "AIB.app/Contents/MacOS/": 0o755,
      "AIB.app/Contents/MacOS/laufey_webview": 0o755,
      "AIB.app/Contents/MacOS/libruntime.dylib": 0o755,
      "AIB.app/Contents/Resources/": 0o755,
      "AIB.app/Contents/Resources/AppIcon.icns": 0o644,
    });
    assertEquals([modeFor("AIB.exe", false), modeFor("AIB.dll", false), modeFor(".deno-desktop-app", false)], [0o755, 0o755, 0o644]);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("icns, what is staged, and the staged deno.json", () => {
  const icns = makeIcns([["ic07", new Uint8Array([1, 2, 3])]]);
  assertEquals(new TextDecoder().decode(icns.subarray(0, 4)), "icns");
  assertEquals(new DataView(icns.buffer).getUint32(4), 8 + 8 + 3);
  assertEquals(new TextDecoder().decode(icns.subarray(8, 12)), "ic07");
  for (const [name, dir, want] of [
    ["server", true, true],
    ["icons", true, true], // the phone page's manifest icons (remote/server.ts REMOTE_STATIC)
    ["pwa", true, true], // the phone page's service worker
    ["agent_locks", true, true],
    ["vendor", true, true],
    ["docs", true, false],
    ["public", true, false],
    ["__pycache__", true, false],
    ["chat.html", false, true],
    ["chat.js", false, true],
    ["style.css", false, true],
    ["agent_versions.json", false, true],
    ["studio.py", false, false],
    ["deno.json", false, false],
    ["README.md", false, false],
  ] as [string, boolean, boolean][]) assertEquals(stagedName(name, dir), want, name);
  assertEquals(stagedConfig({ compilerOptions: { strict: true }, tasks: { x: "y" }, nodeModulesDir: "auto" }, "0.2.0-beta.1"), {
    compilerOptions: { strict: true },
    nodeModulesDir: "none",
    version: "0.2.0-beta.1",
    desktop: { app: { name: "AIB", identifier: "dev.aib.app" } },
  });
  // the npm imports (local docs: Yjs, TipTap) go along; deno.lock is copied next to the staged deno.json
  assertEquals(stagedConfig({ imports: { yjs: "npm:yjs@13.6.33" } }, "1.0.0").imports, { yjs: "npm:yjs@13.6.33" });
});

const ICONS_DIR = new URL("../../outputs/agent-studio/icons/", import.meta.url);
const AMBER: [number, number, number] = [0xff, 0xc2, 0x47];
const CORAL: [number, number, number] = [0xff, 0x7a, 0x59];

Deno.test("the app icon files: masters, .ico entries and art, PNG sizes, colour tray PNGs, favicon", async () => {
  assert((await Deno.readTextFile(`${ICON_SRC}/icon.svg`)).includes('viewBox="0 0 100 100"'), "icon.svg");
  const ico = parseIco(await Deno.readFile(new URL("icon.ico", ICONS_DIR)));
  assertEquals(ico.map((i) => [i.width, i.height, i.bitCount]), ICO_SIZES.map((s) => [s & 0xff, s & 0xff, 32]));
  for (const [n, img] of ico.entries()) assertEquals(pngSize(img.data), { width: ICO_SIZES[n], height: ICO_SIZES[n] });
  assertEquals(ICO_SIZES.map(icoMaster), [...GRID_SIZES.map((s) => `icon-${s}.txt`), ...Array(5).fill("icon.svg")]);
  // The small images are the hand-drawn grids, pixel for pixel; every image has the black hat, the teal rim and both agents.
  for (const [n, size] of GRID_SIZES.entries()) {
    const grid = parseGrid(await Deno.readTextFile(`${ICON_SRC}/icon-${size}.txt`), size);
    assertEquals([...(await decodePng(ico[n].data)).rgba], [...grid], `${size} px .ico image = icon-${size}.txt`);
  }
  for (const img of ico) {
    for (const rgb of [HAT, RIM, AMBER, CORAL]) assert(await hasColour(img.data, rgb), `${img.width || 256} px has ${rgb}`);
  }
  assertEquals([...(await Deno.readFile(new URL("32x32.png", ICONS_DIR)))], [...ico[3].data], "32x32.png is the .ico's 32 px image");
  for (const [file, , size] of PNGS) {
    const png = await Deno.readFile(new URL(file, ICONS_DIR));
    assertEquals(pngSize(png), { width: size, height: size }, file);
    assert(await hasColour(png, HAT) && await hasColour(png, RIM), `${file}: black hat, teal rim`);
  }
  // Tray: the 16 20 24 32 px grids (the colour icon on every taskbar theme), the .ico's images byte for byte.
  assertEquals(Object.keys(TRAY_PNG_BASE64).sort(), ["color-16", "color-20", "color-24", "color-32"]);
  assertEquals(TRAY.map((t) => t[1]), GRID_SIZES.map((s) => `icon-${s}.txt`));
  const tray = (key: string) => Uint8Array.from(atob(TRAY_PNG_BASE64[key]), (c) => c.charCodeAt(0));
  for (const [key, , size] of TRAY) assertEquals(pngSize(tray(key)), { width: size, height: size }, key);
  for (const [n, size] of GRID_SIZES.entries()) assertEquals([...tray(`color-${size}`)], [...ico[n].data], `${size} px tray = .ico image`);
  // The favicon: icon.svg as a data: URL in each page; the old tile icon is gone.
  const link = faviconLink(await Deno.readTextFile(`${ICON_SRC}/icon.svg`));
  for (const page of FAVICON_PAGES) {
    const html = await Deno.readTextFile(new URL(`../../outputs/agent-studio/${page}`, import.meta.url));
    assertEquals(html.split('<link rel="icon"').length, 2, page);
    assert(html.includes(link), page);
    assert(!html.includes("rx='22' fill='%2313867A'"), `${page}: no old tile favicon`);
  }
  // makeIco writes what parseIco reads.
  const again = parseIco(makeIco(ico.map((i) => i.data)));
  assertEquals(again.map((i) => i.data.length), ico.map((i) => i.data.length));
});

Deno.test("icon.ico: every size 16-256, each a 32-bit RGBA PNG with real alpha and no light fringe on its see-through edge", async () => {
  const ico = parseIco(await Deno.readFile(new URL("icon.ico", ICONS_DIR)));
  assertEquals(ico.map((i) => i.width || 256), [16, 20, 24, 32, 40, 48, 64, 128, 256]);
  for (const img of ico) {
    const size = img.width || 256;
    assertEquals(img.bitCount, 32, `${size}: 32 bits per pixel`);
    assertEquals([...img.data.subarray(1, 4)], [0x50, 0x4e, 0x47], `${size}: a PNG image`);
    assertEquals([img.data[24], img.data[25]], [8, 6], `${size}: 8-bit RGBA`);
    const { rgba } = await decodePng(img.data);
    const alpha = (x: number, y: number) => rgba[(y * size + x) * 4 + 3];
    // No tile: the corners and the top middle above the crown are see-through; the middle of the crown is opaque.
    for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1], [size >> 1, 0]]) {
      assertEquals(alpha(x, y), 0, `${size}: see-through at ${x},${y}`);
    }
    assertEquals(alpha(size >> 1, Math.round(size * 0.45)), 255, `${size}: opaque inside the hat`);
    // Anti-aliased edges keep their own colour (no white or light grey matte): every part-transparent pixel is dark or teal.
    let partial = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      const a = rgba[i + 3];
      if (a === 0 || a === 255) continue;
      partial++;
      assert(!(rgba[i] > 160 && rgba[i + 1] > 160 && rgba[i + 2] > 160), `${size}: light fringe pixel ${rgba.subarray(i, i + 4)}`);
    }
    if (GRID_SIZES.includes(size)) assertEquals(partial, 0, `${size}: the hand-drawn image has no half pixels`);
  }
});

Deno.test("parseGrid and encodePng: a grid becomes the PNG decodePng reads back", async () => {
  const rgba = parseGrid("TK\n.A\n", 2);
  assertEquals([...rgba], [0x2b, 0xb3, 0xa3, 255, 0x16, 0x15, 0x1b, 255, 0, 0, 0, 0, 0xff, 0xc2, 0x47, 255]);
  const png = await encodePng(2, 2, rgba);
  assertEquals(pngSize(png), { width: 2, height: 2 });
  assertEquals([...(await decodePng(png)).rgba], [...rgba]);
  assertThrows(() => parseGrid("TK\nA\n", 2));
  assertThrows(() => parseGrid("TX\nAA\n", 2));
});

/** A tiny .ico: one 16x16 PNG-style entry (planes/bit count left 0, read from IHDR) and one 32x32 BMP entry. */
function tinyIco(): Uint8Array {
  const png = new Uint8Array(33);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  png[24] = 8; // bit depth
  png[25] = 6; // RGBA
  const bmp = new Uint8Array(40 + 32 * 32 * 4 + 32 * 4);
  const bv = new DataView(bmp.buffer);
  bv.setUint32(0, 40, true);
  bv.setInt32(4, 32, true);
  bv.setInt32(8, 64, true);
  bv.setUint16(12, 1, true);
  bv.setUint16(14, 32, true);
  bmp.fill(0x7f, 40);
  const ico = new Uint8Array(6 + 32 + png.length + bmp.length);
  const v = new DataView(ico.buffer);
  v.setUint16(2, 1, true);
  v.setUint16(4, 2, true);
  ico.set([16, 16, 0, 0], 6);
  v.setUint32(6 + 8, png.length, true);
  v.setUint32(6 + 12, 38, true);
  ico.set([32, 32, 0, 0], 22);
  v.setUint16(22 + 4, 1, true);
  v.setUint16(22 + 6, 32, true);
  v.setUint32(22 + 8, bmp.length, true);
  v.setUint32(22 + 12, 38 + png.length, true);
  ico.set(png, 38);
  ico.set(bmp, 38 + png.length);
  return ico;
}

Deno.test("the .ico parser and the RT_GROUP_ICON bytes", async () => {
  const images = parseIco(tinyIco());
  assertEquals(images.map((i) => [i.width, i.height, i.planes, i.bitCount, i.data.length]), [
    [16, 16, 1, 32, 33],
    [32, 32, 1, 32, 40 + 32 * 32 * 4 + 32 * 4],
  ]);
  assertEquals(images[0].data[1], 0x50);
  const group = groupIconBytes(images, 1);
  const v = new DataView(group.buffer);
  assertEquals(group.length, 6 + 14 * 2);
  assertEquals([v.getUint16(0, true), v.getUint16(2, true), v.getUint16(4, true)], [0, 1, 2]);
  assertEquals([...group.subarray(6, 10)], [16, 16, 0, 0]);
  assertEquals([v.getUint16(10, true), v.getUint16(12, true), v.getUint32(14, true), v.getUint16(18, true)], [1, 32, 33, 1]);
  assertEquals([v.getUint16(20 + 4, true), v.getUint32(20 + 8, true), v.getUint16(20 + 12, true)], [1, images[1].data.length, 2]);
  // The real app icon: nine PNG images, 256 written as 0.
  const app = parseIco(await Deno.readFile(new URL("../../outputs/agent-studio/icons/icon.ico", import.meta.url)));
  assertEquals(app.map((i) => i.width), [16, 20, 24, 32, 40, 48, 64, 128, 0]);
  assertThrows(() => parseIco(new Uint8Array([0, 0, 2, 0, 1, 0])));
  assertThrows(() => parseIco(new Uint8Array([0, 0, 1, 0, 1, 0])));
});

Deno.test({
  name: "embedWindowsIcon writes the .ico into a PE as RT_ICON 1..n + RT_GROUP_ICON 1, and a second run replaces it",
  ignore: !WINDOWS,
  fn: async () => {
    const dir = Deno.makeTempDirSync({ prefix: "aib-build-icon-" });
    try {
      const exe = `${dir}/where.exe`;
      Deno.copyFileSync(`${Deno.env.get("SystemRoot") ?? "C:/Windows"}/System32/where.exe`, exe);
      for (const ico of [tinyIco(), await Deno.readFile(new URL("../../outputs/agent-studio/icons/icon.ico", import.meta.url))]) {
        embedWindowsIcon(exe, ico);
        const images = parseIco(ico);
        const { groups, icons } = readIconResources(exe);
        assertEquals(groups.map((g) => [g.name, g.lang]), [[1, 0]]);
        assertEquals([...groups[0].data], [...groupIconBytes(images, 1)]);
        assertEquals(icons.map((i) => [i.name, i.lang]), images.map((_, n) => [n + 1, 0]));
        icons.forEach((icon, n) => assertEquals([...icon.data], [...images[n].data]));
      }
      // Still a loadable PE: where.exe runs and answers.
      const out = new Deno.Command(exe, { args: ["cmd.exe"], stdout: "piped", stderr: "piped" }).outputSync();
      assert(out.success && /cmd\.exe/i.test(new TextDecoder().decode(out.stdout)));
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  },
});

const te = new TextEncoder();
const td = new TextDecoder();

Deno.test("desktop entries get the app's Name (and StartupWMClass when asked)", () => {
  const deb = "[Desktop Entry]\nType=Application\nName=aib\nName[de]=aib\nExec=aib\nStartupWMClass=dev.aib.app\n";
  assertEquals(fixDesktopEntry(deb, "AIB"), deb.replace("Name=aib\n", "Name=AIB\n"));
  assertEquals(fixDesktopEntry(deb, "AIB", "x"), deb.replace("Name=aib\n", "Name=AIB\n"));
  assertEquals(
    fixDesktopEntry("[Desktop Entry]\nName=AIB\nIcon=AIB", "AIB", "dev.aib.app"),
    "[Desktop Entry]\nName=AIB\nIcon=AIB\nStartupWMClass=dev.aib.app\n",
  );
});

/** A ustar archive of regular files (what deno desktop's data.tar holds, minus folders and links). */
function tarOf(files: [string, string][]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [name, text] of files) {
    const h = new Uint8Array(512);
    h.set(te.encode(name), 0);
    h.set(te.encode("0000644\0"), 100);
    h.set(te.encode(text.length.toString(8).padStart(11, "0") + "\0"), 124);
    h[156] = 0x30;
    h.set(te.encode("ustar\u000000"), 257);
    h.fill(0x20, 148, 156);
    h.set(te.encode(h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 "), 148);
    const body = new Uint8Array(Math.ceil(text.length / 512) * 512);
    body.set(te.encode(text));
    parts.push(h, body);
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, o), o += p.length;
  return out;
}

function arOf(members: [string, Uint8Array][]): Uint8Array {
  const header = (name: string) => {
    const h = new Uint8Array(60).fill(0x20);
    h.set(te.encode(name), 0);
    h.set(te.encode("0"), 16);
    h.set(te.encode("`\n"), 58);
    return h;
  };
  return writeAr(members.map(([name, data]) => ({ name, header: header(name), data })));
}

async function gz(data: Uint8Array, how: "gzip" | "gunzip"): Promise<Uint8Array> {
  const stream = how === "gzip" ? new CompressionStream("gzip") : new DecompressionStream("gzip");
  return new Uint8Array(await new Response(new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream)).arrayBuffer());
}

Deno.test("tar and ar editing keep every other byte, and fixDeb renames the desktop entries", async () => {
  const entry = "[Desktop Entry]\nName=aib\nExec=aib\n";
  const tar = tarOf([["./usr/bin/readme", "x".repeat(700)], ["./usr/share/applications/aib.desktop", entry]]);
  const { tar: edited, edited: paths } = editTar(tar, (p) => p.endsWith(".desktop"), (_p, d) => te.encode(td.decode(d) + "#"));
  assertEquals(paths, ["usr/share/applications/aib.desktop"]);
  assertEquals(edited.subarray(0, 512 + 1024), tar.subarray(0, 512 + 1024)); // the first file untouched
  assertEquals(td.decode(edited.subarray(1536 + 512, 1536 + 512 + entry.length + 1)), entry + "#");
  const odd = new Uint8Array([1, 2, 3]);
  const ar = arOf([["debian-binary", te.encode("2.0\n")], ["control.tar.gz", odd]]);
  assertEquals(readAr(ar).map((m) => [m.name, [...m.data]]), [["debian-binary", [50, 46, 48, 10]], ["control.tar.gz", [1, 2, 3]]]);
  assertEquals(writeAr(readAr(ar)), ar);

  const dir = Deno.makeTempDirSync({ prefix: "aib-build-deb-" });
  try {
    const deb = `${dir}/aib.deb`;
    Deno.writeFileSync(deb, arOf([["debian-binary", te.encode("2.0\n")], ["control.tar.gz", odd], ["data.tar.gz", await gz(tar, "gzip")]]));
    assertEquals(await fixDeb(deb, "AIB"), ["usr/share/applications/aib.desktop"]);
    const members = readAr(Deno.readFileSync(deb));
    assertEquals(members.map((m) => m.name), ["debian-binary", "control.tar.gz", "data.tar.gz"]);
    assertEquals([...members[1].data], [1, 2, 3]);
    const out = await gz(members[2].data, "gunzip");
    assertEquals(td.decode(out.subarray(1536 + 512, 1536 + 512 + entry.length)), entry.replace("Name=aib", "Name=AIB"));
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

/** An empty zstd squashfs 4.0 superblock (one id, no fragments, no xattrs), for writeSquashfs to fill. */
function emptySquashfs(root: SqNode) {
  const sb = new Uint8Array(96);
  const v = new DataView(sb.buffer);
  v.setUint32(0, 0x73717368, true);
  v.setUint32(12, 131072, true);
  v.setUint16(20, 6, true);
  v.setUint16(22, 17, true);
  v.setUint16(24, 0x40, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, 4, true);
  for (const o of [56, 88]) v.setBigInt64(o, -1n, true);
  return { superblock: sb, blockSize: 131072, dataEnd: 96, fragments: [], ids: new Uint8Array(4), root, image: sb };
}

Deno.test("squashfs: written, read back, and an AppImage gets .DirIcon, root 0755 and StartupWMClass", async () => {
  const file = (name: string, text: string, mode = 0o644): SqNode => ({
    name,
    kind: "file",
    mode,
    uid: 0,
    gid: 0,
    mtime: 0,
    nlink: 1,
    newData: te.encode(text),
  });
  const root: SqNode = {
    name: "",
    kind: "dir",
    mode: 0,
    uid: 0,
    gid: 0,
    mtime: 0,
    nlink: 2,
    children: [
      file("AIB.desktop", "[Desktop Entry]\nType=Application\nName=AIB\nExec=AIB\nIcon=AIB\n"),
      file("AIB.png", "png bytes"),
      file("AppRun", "#!/bin/sh\n", 0o755),
      { name: "lib", kind: "dir", mode: 0o755, uid: 0, gid: 0, mtime: 0, nlink: 2, children: [file("a.txt", "a")] },
      { name: "link", kind: "symlink", mode: 0o777, uid: 0, gid: 0, mtime: 0, nlink: 1, target: te.encode("AppRun") },
    ],
  };
  const image = writeSquashfs(emptySquashfs(root));
  const back = readSquashfs(image);
  const names = (n: SqNode): unknown => n.children ? [n.name, n.children.map(names)] : n.name;
  assertEquals(names(back.root), ["", ["AIB.desktop", "AIB.png", "AppRun", ["lib", ["a.txt"]], "link"]]);
  assertEquals(back.root.mode, 0);
  assertEquals(td.decode(readSqFile(back, back.root.children![1])), "png bytes");
  assertEquals(back.root.children![2].mode, 0o755);
  assertEquals(td.decode(readSqFile(back, back.root.children![3].children![0])), "a");
  assertEquals(td.decode(back.root.children![4].target!), "AppRun");

  // An AppImage: a 64-byte ELF header (no section headers, so the squashfs starts at 64), then the squashfs.
  const elf = new Uint8Array(64);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  new DataView(elf.buffer).setBigUint64(0x28, 64n, true);
  const dir = Deno.makeTempDirSync({ prefix: "aib-build-appimage-" });
  try {
    const path = `${dir}/AIB.AppImage`;
    const app = new Uint8Array(64 + image.length);
    app.set(elf);
    app.set(image, 64);
    Deno.writeFileSync(path, app);
    assertEquals(appImageOffset(app), 64);
    assertEquals(await fixAppImage(path, "AIB", "dev.aib.app"), ["root directory mode 0755", "AIB.desktop", ".DirIcon (from AIB.png)"]);
    assertEquals(await fixAppImage(path, "AIB", "dev.aib.app"), []); // a second run finds nothing to do
    const fixed = Deno.readFileSync(path);
    assertEquals(fixed.subarray(0, 64), elf);
    const fs = readSquashfs(fixed.subarray(64));
    const kid = (n: string) => fs.root.children!.find((c) => c.name === n)!;
    assertEquals(fs.root.mode, 0o755);
    assertEquals(td.decode(readSqFile(fs, kid(".DirIcon"))), "png bytes");
    assert(td.decode(readSqFile(fs, kid("AIB.desktop"))).endsWith("Icon=AIB\nStartupWMClass=dev.aib.app\n"));
    assertEquals(td.decode(readSqFile(fs, kid("lib").children![0])), "a");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

const ELF = "\x7fELF";

Deno.test("ELF programs get 0755 and ELF shared libraries 0644, in the .deb and in the AppImage", async () => {
  assertEquals(wantedMode("usr/lib/aib/aib", te.encode(ELF)), 0o755);
  assertEquals(wantedMode("usr/lib/aib/aib.so", te.encode(ELF)), 0o644);
  assertEquals(wantedMode("usr/lib/aib/libx.so.3", te.encode(ELF)), 0o644);
  assertEquals(wantedMode("usr/lib/aib/AppIcon.png", te.encode("\x89PNG")), null);

  // .deb: the program's tar header gets 0755 (valid checksum), the library stays 0644, every other byte is kept.
  const tar = tarOf([["./usr/lib/aib/aib", ELF + "prog"], ["./usr/lib/aib/aib.so", ELF + "lib"], ["./usr/share/applications/aib.desktop", "Name=AIB\n"]]);
  const { tar: out, modes } = editTar(tar, () => false, (_p, d) => d, (p, d) => wantedMode(p, d.subarray(0, 4)));
  assertEquals(modes, ["usr/lib/aib/aib 755"]);
  const header = out.subarray(0, 512);
  assertEquals(td.decode(header.subarray(100, 108)), "0000755\0");
  const sum = header.reduce((a, b, i) => a + (i >= 148 && i < 156 ? 0x20 : b), 0);
  assertEquals(parseInt(td.decode(header.subarray(148, 154)), 8), sum);
  const diff = [...out].flatMap((b, i) => (b === tar[i] ? [] : [i]));
  assert(diff.every((i) => (i >= 100 && i < 108) || (i >= 148 && i < 156)), `changed bytes ${diff}`);

  const dir = Deno.makeTempDirSync({ prefix: "aib-build-debmode-" });
  try {
    const deb = `${dir}/aib.deb`;
    Deno.writeFileSync(deb, arOf([["debian-binary", te.encode("2.0\n")], ["control.tar.gz", new Uint8Array([1])], ["data.tar.gz", await gz(tar, "gzip")]]));
    assertEquals(await fixDeb(deb, "AIB"), ["mode usr/lib/aib/aib 755"]);
    assertEquals(await fixDeb(deb, "AIB"), []);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }

  // AppImage: the program at the top level gets 0755, AppRun (a script) and the library keep their modes.
  const file = (name: string, text: string, mode = 0o644): SqNode => ({ name, kind: "file", mode, uid: 0, gid: 0, mtime: 0, nlink: 1, newData: te.encode(text) });
  const root: SqNode = {
    name: "",
    kind: "dir",
    mode: 0o755,
    uid: 0,
    gid: 0,
    mtime: 0,
    nlink: 2,
    children: [
      file(".DirIcon", "png"),
      file("AIB", ELF + "prog"),
      file("AIB.desktop", "[Desktop Entry]\nName=AIB\nIcon=AIB\nStartupWMClass=dev.aib.app\n"),
      file("AIB.png", "png"),
      file("AIB.so", ELF + "lib"),
      file("AppRun", "#!/bin/sh\n", 0o755),
    ],
  };
  const elf = new Uint8Array(64);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  new DataView(elf.buffer).setBigUint64(0x28, 64n, true);
  const image = writeSquashfs(emptySquashfs(root));
  const app = new Uint8Array(64 + image.length);
  app.set(elf);
  app.set(image, 64);
  const dir2 = Deno.makeTempDirSync({ prefix: "aib-build-appmode-" });
  try {
    const path = `${dir2}/AIB.AppImage`;
    Deno.writeFileSync(path, app);
    assertEquals(await fixAppImage(path, "AIB", "dev.aib.app"), ["mode AIB 755"]);
    const fs = readSquashfs(Deno.readFileSync(path).subarray(64));
    const modeOf = (n: string) => fs.root.children!.find((c) => c.name === n)!.mode;
    assertEquals([modeOf("AIB"), modeOf("AIB.so"), modeOf("AppRun"), modeOf("AIB.png")], [0o755, 0o644, 0o755, 0o644]);
    assertEquals(td.decode(readSqFile(fs, fs.root.children!.find((c) => c.name === "AIB")!)), ELF + "prog");
  } finally {
    Deno.removeSync(dir2, { recursive: true });
  }
});

Deno.test("release.json names the version, the agent-host protocol and what it needs of a keeper; --version rewrites only the staged app.ts", async () => {
  const { releaseInfo, setStagedVersion } = await import("../../tools/build.ts");
  const { PROTOCOL_VERSION } = await import("../../outputs/agent-studio/server/host/host_client.ts");
  assertEquals(JSON.parse(releaseInfo("0.1.0-beta.2")), {
    version: "0.1.0-beta.2",
    protocol: PROTOCOL_VERSION,
    appId: "dev.aib.app",
    keeper: { protocols: [1], needs: ["notes", "once", "channel-ids"] },
  });
  const dir = Deno.makeTempDirSync({ prefix: "aib-stage-version-" });
  try {
    Deno.mkdirSync(`${dir}/server/core`, { recursive: true });
    Deno.writeTextFileSync(`${dir}/server/core/app.ts`, "x\nexport const APP_VERSION = '0.1.0-beta.1';\ny\n");
    await setStagedVersion(dir, "0.1.0-test.2");
    assertEquals(Deno.readTextFileSync(`${dir}/server/core/app.ts`), "x\nexport const APP_VERSION = '0.1.0-test.2';\ny\n");
    Deno.writeTextFileSync(`${dir}/server/core/app.ts`, "no version here");
    let failed = false;
    await setStagedVersion(dir, "1.0.0").catch(() => (failed = true));
    assert(failed);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

// ---- the keeper step -----------------------------------------------------------------------------------------------------

Deno.test("keeper: Go target, file name and build flags for each of the six targets", () => {
  const got = TARGETS.map((t) => `${t.id} ${goTarget(t).GOOS}/${goTarget(t).GOARCH} ${keeperFile(t)}`);
  assertEquals(got, [
    "windows-x64 windows/amd64 AIB-keeper.exe",
    "windows-arm64 windows/arm64 AIB-keeper.exe",
    "macos-x64 darwin/amd64 AIB-keeper",
    "macos-arm64 darwin/arm64 AIB-keeper",
    "linux-x64 linux/amd64 AIB-keeper",
    "linux-arm64 linux/arm64 AIB-keeper",
  ]);
  for (const t of TARGETS) {
    const args = keeperBuildArgs(t, "out");
    assertEquals(args.slice(0, 2), ["build", "-trimpath"]);
    assertEquals(args[3].includes("-H windowsgui"), t.os === "windows"); // a Windows keeper can never get a console window
  }
  assertEquals(DEB_KEEPER_PATH, "usr/lib/aib/AIB-keeper"); // next to the app's program, usr/lib/aib/aib
});

Deno.test("keeper: added to a tar (new entry before the end blocks, or replacing one) and to a .deb", async () => {
  const tar = tarOf([["./usr/lib/aib/aib", ELF + "prog"], ["./usr/share/applications/aib.desktop", "Name=AIB\n"]]);
  const data = new Uint8Array(1300).map((_, i) => i % 251);
  const added = addTarFile(tar, DEB_KEEPER_PATH, data, 0o755);
  const body = tar.length - 1024; // tarOf ends with two zero blocks
  assertEquals(added.subarray(0, body), tar.subarray(0, body)); // every existing byte kept
  const header = added.subarray(body, body + 512);
  assertEquals(td.decode(header.subarray(0, 25)), "./usr/lib/aib/AIB-keeper\0");
  assertEquals(td.decode(header.subarray(100, 108)), "0000755\0");
  assertEquals(parseInt(td.decode(header.subarray(124, 135)), 8), 1300);
  const sum = header.reduce((a, b, i) => a + (i >= 148 && i < 156 ? 0x20 : b), 0);
  assertEquals(parseInt(td.decode(header.subarray(148, 154)), 8), sum);
  assertEquals(added.subarray(body + 512, body + 512 + 1300), data);
  assert(added.subarray(added.length - 1024).every((b) => b === 0));
  // A second add replaces it rather than adding another entry.
  const again = addTarFile(added, DEB_KEEPER_PATH, new Uint8Array([1, 2, 3]), 0o755);
  const paths: string[] = [];
  editTar(again, (p) => (paths.push(p), false), (_p, d) => d);
  assertEquals(paths, ["usr/lib/aib/aib", "usr/share/applications/aib.desktop", "usr/lib/aib/AIB-keeper"]);

  const dir = Deno.makeTempDirSync({ prefix: "aib-build-debkeeper-" });
  try {
    const deb = `${dir}/aib.deb`;
    Deno.writeFileSync(deb, arOf([["debian-binary", te.encode("2.0\n")], ["control.tar.gz", new Uint8Array([1])], ["data.tar.gz", await gz(tar, "gzip")]]));
    await addToDeb(deb, DEB_KEEPER_PATH, data, 0o755);
    const members = readAr(Deno.readFileSync(deb));
    const inner = await gz(members.find((m) => m.name === "data.tar.gz")!.data, "gunzip");
    let keeper: Uint8Array | null = null;
    editTar(inner, (p) => p === "usr/lib/aib/AIB-keeper", (_p, d) => (keeper = d.slice(), d));
    assertEquals(keeper, data);
    await assertRejects(() => addToDeb(deb, "opt/elsewhere/AIB-keeper", data, 0o755)); // a layout change fails the build
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("keeper: added at the top of an AppImage as a multi-block file, 0755, read back intact", async () => {
  const file = (name: string, text: string, mode = 0o644): SqNode => ({ name, kind: "file", mode, uid: 0, gid: 0, mtime: 0, nlink: 1, newData: te.encode(text) });
  const root: SqNode = { name: "", kind: "dir", mode: 0o755, uid: 0, gid: 0, mtime: 0, nlink: 2, children: [file("AIB", ELF + "prog", 0o755), file("AppRun", "#!/bin/sh\n", 0o755)] };
  const elf = new Uint8Array(64);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  new DataView(elf.buffer).setBigUint64(0x28, 64n, true);
  const image = writeSquashfs(emptySquashfs(root));
  const app = new Uint8Array(64 + image.length);
  app.set(elf);
  app.set(image, 64);
  const keeper = new Uint8Array(131072 * 2 + 777).map((_, i) => (i * 7) % 256); // three blocks, the last one short
  const dir = Deno.makeTempDirSync({ prefix: "aib-build-appkeeper-" });
  try {
    const path = `${dir}/AIB.AppImage`;
    Deno.writeFileSync(path, app);
    await addToAppImage(path, "AIB-keeper", keeper, 0o755);
    const fs = readSquashfs(Deno.readFileSync(path).subarray(64));
    const kid = (n: string) => fs.root.children!.find((c) => c.name === n)!;
    assertEquals(kid("AIB-keeper").mode, 0o755);
    assertEquals(readSqFile(fs, kid("AIB-keeper")), keeper);
    assertEquals(td.decode(readSqFile(fs, kid("AIB"))), ELF + "prog");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

let goWorks = false;
try {
  goWorks = new Deno.Command(goCommand(), { args: ["version"], stdout: "null", stderr: "null" }).outputSync().success;
} catch { /* no Go here */ }

Deno.test({
  name: "keeper: a real build for this machine answers `version` (skipped without Go)",
  ignore: !goWorks,
  fn: async () => {
    const t = TARGETS.find((t) => t.triple === Deno.build.target);
    if (!t) return;
    const dir = Deno.makeTempDirSync({ prefix: "aib-build-keeper-" });
    try {
      const exe = `${dir}/${keeperFile(t)}`;
      const bytes = await buildKeeper(t, exe);
      assert(bytes > 1e6 && bytes < 20e6, `keeper is ${bytes} bytes`);
      const out = await new Deno.Command(exe, { args: ["version"], stdout: "piped", stderr: "null" }).output();
      assert(td.decode(out.stdout).startsWith("AIB keeper "), td.decode(out.stdout));
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  },
});
