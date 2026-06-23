#!/usr/bin/env bun
import { $ } from "bun";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const sdkIndex = "https://dl.google.com/android/repository/repository2-3.xml";
const sdkBase = "https://dl.google.com/android/repository/";

const args = parse(Bun.argv.slice(2));
if (!args.api || !args.build) usage();

const api = args.api;
const build = args.build;
const output = resolve(args.out ?? `sdks/android-${api}.jar`);
const ci = `https://ci.android.com/builds/submitted/${build}/sdk-trunk_staging-userdebug/latest/`;
const work = resolve(`.unsealed-sdk/android-${api}-${build}`);
const cache = `${work}/cache`;
const merge = `${work}/merge`;
const overlay = `${work}/overlay`;

const exactHeaderModules = new Set([
  "framework-minus-apex",
  "telephony-common",
  "ims-common",
  "voip-common",
  "ext",
  "android.hidl.base-V1.0-java",
  "android.hidl.manager-V1.0-java",
  "android.test.base.impl",
  "android.test.mock.impl",
  "android.test.runner.impl",
  "org.apache.http.legacy.impl",
  "com.android.nfc_extras.impl",
  "com.android.future.usb.accessory.impl",
  "com.android.location.provider.impl",
  "com.android.media.remotedisplay.impl",
  "com.android.mediadrm.signer.impl",
  "com.android.extensions.appfunctions.impl",
  "android.net.ipsec.ike.com.android.ipsec",
  "android.ext.adservices.com.android.extservices",
  "updatable-media.com.android.media",
  "SatelliteClient",
]);

await rm(work, { recursive: true, force: true });
await mkdir(cache, { recursive: true });
await mkdir(merge, { recursive: true });

const platform = await platformPackage(api);
const archive = `${cache}/platform.zip`;
const official = `${cache}/official-android.jar`;

console.log(`platform ${platform.path} -> ${platform.url}`);
await download(platform.url, archive);
await verify(archive, platform.sha1);
await extractOfficial(archive, official);

const artifacts = await artifactNames(ci);
const wanted = headerArtifacts(artifacts);
if (!wanted.length) {
  throw new Error(
    `build ${build} has no JAVA_LIBRARIES/*_intermediates/classes-header.jar artifacts. ` +
      "Use a CI target that publishes framework intermediates, not only apistubs.",
  );
}

console.log("merge jars");
await $`unzip -oq ${official} -d ${merge}`;
console.log(`download ${wanted.length} framework header jars`);
for (const item of wanted) {
  const jar = await artifact(ci, item.path, cache);
  await rm(overlay, { recursive: true, force: true });
  await mkdir(overlay, { recursive: true });
  await $`unzip -oq ${jar} -d ${overlay}`;
  const copied = await copyOverlayClasses(overlay, merge);
  console.log(`overlay ${item.module}: ${copied} classes`);
}
await $`rm -rf ${`${merge}/META-INF`}`;
const downleveled = await downlevelClasses(merge, 52);
console.log(`downlevel classfile major > 52: ${downleveled} classes`);

await mkdir(dirname(output), { recursive: true });
await rm(output, { force: true });
await $`cd ${merge} && zip -qr ${output} .`;

const size = (await stat(output)).size;
console.log(`wrote ${output} (${size} bytes)`);

function parse(words: string[]) {
  const options: Record<string, string> = {};
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (!word.startsWith("--")) usage();
    const [key, inline] = word.slice(2).split("=", 2);
    options[key] = inline ?? words[++index] ?? usage();
  }
  return options;
}

function usage(): never {
  console.error("usage: bun tools/build-unsealed.ts --api <level> --build <ci-build-id> [--out <jar>]");
  process.exit(2);
}

async function text(url: string) {
  const response = await fetch(url, { headers: { "User-Agent": "UnsealedSdk/1.0" } });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.text();
}

async function download(url: string, path: string) {
  const response = await fetch(url, { headers: { "User-Agent": "UnsealedSdk/1.0" } });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  await Bun.write(path, await response.arrayBuffer());
}

async function platformPackage(api: string) {
  const catalog = await text(sdkIndex);
  const packages = catalog.matchAll(/<remotePackage\s+[^>]*path="([^"]+)"[^>]*>([\s\S]*?)<\/remotePackage>/g);
  const paths = new Set([`platforms;android-${api}`, `platforms;android-${api}.0`]);

  for (const [, path, body] of packages) {
    if (!paths.has(path)) continue;
    const file = body.match(/<complete>[\s\S]*?<url>([^<]+)<\/url>/)?.[1];
    const sha1 = body.match(/<checksum\s+type="sha1">([^<]+)<\/checksum>/)?.[1];
    if (!file || !sha1) throw new Error(`${path} is missing url or sha1`);
    return { path, sha1, url: new URL(file, sdkBase).toString() };
  }

  throw new Error(`No SDK platform package for API ${api}`);
}

async function verify(path: string, expected: string) {
  const bytes = await Bun.file(path).arrayBuffer();
  const actual = new Bun.CryptoHasher("sha1").update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`${path} sha1 ${actual}, expected ${expected}`);
}

async function extractOfficial(archive: string, android: string) {
  const entries = (await $`unzip -Z1 ${archive}`.text()).trim().split("\n");
  const entry = entries.find(name => name.endsWith("/android.jar") || name === "android.jar");
  if (!entry) throw new Error(`${archive} has no android.jar`);
  await $`unzip -p ${archive} ${entry}`.quiet().nothrow().then(async output => {
    if (output.exitCode !== 0) throw new Error(`Could not extract ${entry}`);
    await Bun.write(android, output.stdout);
  });
}

async function artifactNames(ci: string) {
  const page = await text(ci);
  return [...page.matchAll(/"name":"((?:\\.|[^"])*)"/g)].map(match => JSON.parse(`"${match[1]}"`) as string);
}

function headerArtifacts(artifacts: string[]) {
  return artifacts
    .map(path => {
      const match = path.match(/(?:^|\/)JAVA_LIBRARIES\/([^/]+)_intermediates\/classes-header\.jar$/);
      if (!match) return undefined;
      const module = match[1];
      return wantedHeaderModule(module) ? { module, path } : undefined;
    })
    .filter((item): item is { module: string; path: string } => item !== undefined)
    .sort((left, right) => headerPriority(left.module) - headerPriority(right.module) || left.module.localeCompare(right.module));
}

function wantedHeaderModule(module: string) {
  if (module.startsWith("service-") || module === "services") return false;
  if (module.startsWith("core-")) return false;
  if (module.startsWith("conscrypt.") || module.startsWith("bouncycastle.")) return false;
  if (module.startsWith("okhttp.") || module.startsWith("apache-xml.")) return false;
  if (module.includes(".debug") || module.includes(".testing") || module.endsWith("-debug")) return false;
  return module.startsWith("framework-") || exactHeaderModules.has(module);
}

function headerPriority(module: string) {
  const priorities: Record<string, number> = {
    "framework-minus-apex": 0,
    "android.ext.adservices.com.android.extservices": 5,
    "android.net.ipsec.ike.com.android.ipsec": 6,
    "updatable-media.com.android.media": 7,
    SatelliteClient: 8,
    "framework-graphics": 10,
    "framework-location": 11,
    "framework-permission.com.android.permission": 12,
    "framework-wifi.com.android.wifi": 13,
    "framework-connectivity.com.android.tethering": 14,
    "framework-bluetooth.com.android.bt": 15,
    "telephony-common": 30,
    "ims-common": 31,
    "voip-common": 32,
  };
  return priorities[module] ?? 20;
}

async function copyOverlayClasses(from: string, to: string) {
  let count = 0;
  for (const file of await files(from)) {
    const name = slash(relative(from, file));
    if (!wantedOverlayClass(name)) continue;
    const destination = join(to, ...name.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(file, destination);
    count++;
  }
  return count;
}

function wantedOverlayClass(name: string) {
  if (!name.endsWith(".class") || name === "module-info.class" || name.startsWith("META-INF/")) return false;
  if (name.startsWith("com/android/server/")) return false;
  if (name.startsWith("kotlin/") || name.startsWith("kotlinx/") || name.startsWith("androidx/")) return false;
  if (name.startsWith("_COROUTINE/") || name.startsWith("perfetto/") || name.startsWith("co/")) return false;

  const embeddedDependencyMarkers = [
    "/jarjar/",
    "/kotlin/",
    "/kotlinx/",
    "/androidx/",
    "/guava_common/",
    "/guava_thirdparty/",
    "/com/google/",
    "/thirdparty/",
    "/publicsuffix/",
  ];
  return !embeddedDependencyMarkers.some(marker => name.includes(marker));
}

async function downlevelClasses(root: string, targetMajor: number) {
  let count = 0;
  for (const file of await files(root)) {
    if (!file.endsWith(".class")) continue;
    const bytes = new Uint8Array(await readFile(file));
    if (bytes.length < 8) continue;
    if (bytes[0] !== 0xca || bytes[1] !== 0xfe || bytes[2] !== 0xba || bytes[3] !== 0xbe) continue;

    const major = (bytes[6] << 8) | bytes[7];
    if (major <= targetMajor) continue;
    bytes[6] = (targetMajor >> 8) & 0xff;
    bytes[7] = targetMajor & 0xff;
    await writeFile(file, bytes);
    count++;
  }
  return count;
}

async function files(root: string) {
  const result: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

function slash(path: string) {
  return sep === "/" ? path : path.split(sep).join("/");
}

async function artifact(ci: string, name: string, cache: string) {
  const page = await text(`${ci}${name}`);
  const encoded = page.match(/"artifactUrl":"((?:\\.|[^"])*)"/)?.[1];
  if (!encoded) throw new Error(`No download URL for ${name}`);

  const path = `${cache}/${name.replace(/[^A-Za-z0-9_.-]+/g, "_")}`;
  await download(JSON.parse(`"${encoded}"`), path);
  return path;
}
