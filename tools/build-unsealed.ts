#!/usr/bin/env bun
import { $ } from "bun";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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
const system = "apistubs/android/system/android.jar";
if (!artifacts.includes(system)) throw new Error(`build ${build} has no ${system}`);

const moduleJars = artifacts
  .filter(name => name.startsWith("apistubs/android/module-lib/") && name.endsWith(".jar"))
  .sort();
if (!moduleJars.length) throw new Error(`build ${build} has no module-lib stubs`);

const early = [
  "apistubs/android/module-lib/android-non-updatable.jar",
  "apistubs/android/module-lib/android.jar",
].filter(name => moduleJars.includes(name));
const modules = moduleJars.filter(name => !early.includes(name));
const wanted = [...early, system, ...modules];

console.log(`download ${wanted.length} CI jars`);
const jars = [official];
for (const name of wanted) jars.push(await artifact(ci, name, cache));

console.log("merge jars");
for (const jar of jars) await $`unzip -oq ${jar} -d ${merge}`;
await $`rm -rf ${`${merge}/META-INF`}`;

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

async function artifact(ci: string, name: string, cache: string) {
  const page = await text(`${ci}${name}`);
  const encoded = page.match(/"artifactUrl":"((?:\\.|[^"])*)"/)?.[1];
  if (!encoded) throw new Error(`No download URL for ${name}`);

  const path = `${cache}/${name.replace(/[^A-Za-z0-9_.-]+/g, "_")}`;
  await download(JSON.parse(`"${encoded}"`), path);
  return path;
}
