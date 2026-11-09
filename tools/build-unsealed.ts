#!/usr/bin/env bun
// Builds sdks/android-<api>.jar: Robolectric android-all classes stubbed like the official SDK,
// plus the official android.jar's java/javax classes and every non-class entry.
import { $ } from "bun";
import { readdir, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const sdkIndex = "https://dl.google.com/android/repository/repository2-3.xml";
const sdkBase = "https://dl.google.com/android/repository/";
const robolectric = "https://repo1.maven.org/maven2/org/robolectric/android-all/";

// android-all versions are published under the Android release name, not the API level.
const releases: Record<string, string> = {
  28: "9", 29: "10", 30: "11", 31: "12", 32: "12.1", 33: "13", 34: "14", 35: "15", 36: "16", 37: "17",
};
const blacklist = ["com/android/server/", "android/car/", "com/android/car/"];
const runtime = ["java/", "javax/"];

const { positionals: [api], values } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: { "android-all": { type: "string" }, out: { type: "string" } },
});
if (!api) {
  console.error("usage: bun run tools/build-unsealed.ts <api> [--android-all <version>] [--out <jar>]");
  process.exit(2);
}
const [major, minor = 0] = api.split(".").map(Number);
if (!Number.isInteger(major) || major < 37 || !Number.isInteger(minor) || minor < 0) {
  throw new Error(`API ${api} is not supported: this pipeline builds API 37 and later (minor allowed, e.g. 37.1); jars for 36 and earlier are kept as-is`);
}

const output = resolve(values.out ?? `sdks/android-${api}.jar`);
const cache = resolve(".unsealed-sdk/cache");
const work = resolve(`.unsealed-sdk/android-${api}`);
const merge = `${work}/merge`;
const overlay = `${work}/overlay`;
const supplement = `${work}/supplement`;
await rm(work, { recursive: true, force: true });

const platform = await platformPackage(api);
console.log(`platform ${platform.path} -> ${platform.url}`);
const official = `${work}/official-android.jar`;
await extractOfficial(await cached(platform.url, platform.sha1), official);

const version = values["android-all"] ?? await latestAndroidAll(api);
const androidAllUrl = `${robolectric}${version}/android-all-${version}.jar`;
console.log(`android-all ${version} -> ${androidAllUrl}`);
const androidAll = await cached(androidAllUrl, (await text(`${androidAllUrl}.sha1`)).trim().split(/\s+/)[0]);
await checkRelease(androidAll, api);

await $`unzip -oq ${official} -x '*.class' -d ${merge}`;
await $`unzip -oq ${official} ${runtime.map(prefix => `${prefix}*`)} -d ${merge}`;
await $`unzip -oq ${androidAll} '*.class' -x ${blacklist.map(prefix => `${prefix}*`)} -d ${overlay}`;

const classes = (await readdir(overlay, { recursive: true })).filter(name => name.endsWith(".class"));
console.log(`stub ${classes.length} android-all classes (blacklist: ${blacklist.join(" ")})`);
for (const name of classes) {
  try {
    await Bun.write(join(merge, name), stub(await Bun.file(join(overlay, name)).bytes()));
  } catch (cause) {
    throw new Error(`cannot stub ${name}`, { cause });
  }
}

// android-all has no minor builds, so a minor release's new classes exist only in the official jar.
// Fill the ones android-all lacks from it; they stay official stubs, which is all a minor release adds.
if (minor > 0) {
  await $`unzip -oq ${official} '*.class' -d ${supplement}`;
  const extra = (await readdir(supplement, { recursive: true }))
    .filter(name => name.endsWith(".class") && !blacklist.some(prefix => name.startsWith(prefix)));
  let filled = 0;
  for (const name of extra) {
    const target = join(merge, name);
    if (await Bun.file(target).exists()) continue;
    await Bun.write(target, await Bun.file(join(supplement, name)).bytes());
    filled++;
  }
  console.log(`supplement ${filled} classes new in ${api} from the official jar (stub level only)`);
}

await rm(output, { force: true });
await $`cd ${merge} && zip -qrX ${output} .`;
console.log(`wrote ${output} (${(await stat(output)).size} bytes)`);

async function text(url: string) {
  const response = await fetch(url, { headers: { "User-Agent": "UnsealedSdk/1.0" } });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.text();
}

async function sha1(path: string) {
  return new Bun.CryptoHasher("sha1").update(await Bun.file(path).arrayBuffer()).digest("hex");
}

async function cached(url: string, expected: string) {
  const path = `${cache}/${basename(new URL(url).pathname)}`;
  if (await Bun.file(path).exists() && await sha1(path) === expected) return path;
  const response = await fetch(url, { headers: { "User-Agent": "UnsealedSdk/1.0" } });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  await Bun.write(path, response);
  const actual = await sha1(path);
  if (actual !== expected) throw new Error(`${path} sha1 ${actual}, expected ${expected}`);
  return path;
}

async function platformPackage(api: string) {
  const catalog = await text(sdkIndex);
  const paths = new Set([`platforms;android-${api}`, `platforms;android-${api}.0`]);
  for (const [, path, body] of catalog.matchAll(/<remotePackage\s+[^>]*path="([^"]+)"[^>]*>([\s\S]*?)<\/remotePackage>/g)) {
    if (!paths.has(path)) continue;
    const file = body.match(/<complete>[\s\S]*?<url>([^<]+)<\/url>/)?.[1];
    const sha1 = body.match(/<checksum\s+type="sha1">([^<]+)<\/checksum>/)?.[1];
    if (!file || !sha1) throw new Error(`${path} is missing url or sha1`);
    return { path, sha1, url: new URL(file, sdkBase).toString() };
  }
  throw new Error(`No SDK platform package for API ${api}`);
}

async function extractOfficial(archive: string, jar: string) {
  const entry = (await $`unzip -Z1 ${archive}`.text()).split("\n").find(name => /^[^/]+\/android\.jar$/.test(name));
  if (!entry) throw new Error(`${archive} has no android.jar`);
  await Bun.write(jar, await $`unzip -p ${archive} ${entry}`.arrayBuffer());
}

async function latestAndroidAll(api: string) {
  const release = releases[api.split(".")[0]];
  if (!release) throw new Error(`No Android release known for API ${api}; pass --android-all`);
  const metadata = await text(`${robolectric}maven-metadata.xml`);
  const build = [...metadata.matchAll(/<version>([^<]+)<\/version>/g)]
    .map(([, version]) => version)
    .filter(version => version.startsWith(`${release}-robolectric-`))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .at(-1);
  if (!build) throw new Error(`No android-all build for Android ${release} (API ${api})`);
  return build;
}

async function checkRelease(jar: string, api: string) {
  const sdk = (await $`unzip -p ${jar} build.prop`.text()).match(/^ro\.build\.version\.sdk=(\d+)$/m)?.[1];
  if (sdk !== api.split(".")[0]) throw new Error(`${basename(jar)} is built for SDK ${sdk}, not API ${api}`);
}

// Replaces every concrete method body with the official stub template and lowers the classfile to Java 8.
// The constant pool is copied verbatim and only appended to, so every existing index stays valid.
function stub(input: Uint8Array) {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const u2 = (at: number) => view.getUint16(at);
  const u4 = (at: number) => view.getUint32(at);
  const be = (value: number) => [value >> 8, value & 0xff];
  const be32 = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  const flags = { static: 0x0008, native: 0x0100, abstract: 0x0400 };
  const sizes: Record<number, number> = { 3: 4, 4: 4, 5: 8, 6: 8, 7: 2, 8: 2, 9: 4, 10: 4, 11: 4, 12: 4, 15: 3, 16: 2, 17: 4, 18: 4, 19: 2, 20: 2 };

  const count = u2(8);
  const offsets: number[] = [];
  let poolEnd = 10;
  for (let index = 1; index < count; index++) {
    const tag = input[poolEnd];
    const size = tag === 1 ? 2 + u2(poolEnd + 1) : sizes[tag];
    if (size === undefined) throw new Error(`unknown constant tag ${tag} at #${index}`);
    offsets[index] = poolEnd;
    poolEnd += 1 + size;
    if (tag === 5 || tag === 6) index++;
  }

  const decoder = new TextDecoder();
  const text = (index: number) => decoder.decode(input.subarray(offsets[index] + 3, offsets[index] + 3 + u2(offsets[index] + 1)));
  const pool = input.slice(10, poolEnd);
  const known = new Map<string, number>();
  offsets.forEach((offset, index) => {
    const tag = input[offset];
    const key = tag === 1 ? `1:${text(index)}`
      : tag === 7 || tag === 8 ? `${tag}:${u2(offset + 1)}`
      : tag === 10 || tag === 12 ? `${tag}:${u2(offset + 1)}:${u2(offset + 3)}`
      : undefined;
    if (key && !known.has(key)) known.set(key, index);
    // Indy/condy entries only serve the discarded bodies. Rewriting each into a NameAndType of the same size keeps
    // every index valid, frees BootstrapMethods, and removes condy, which a Java 8 classfile must not contain.
    if (tag === 17 || tag === 18) {
      const signature = offsets[u2(offset + 3)];
      pool.set([12, ...input.subarray(signature + 1, signature + 5)], offset - 10);
    }
  });

  const appended: number[] = [];
  let next = count;
  const intern = (key: string, entry: number[]) => {
    const existing = known.get(key);
    if (existing !== undefined) return existing;
    if (next >= 0xffff) throw new Error("constant pool overflow");
    known.set(key, next);
    appended.push(...entry);
    return next++;
  };
  const utf8 = (value: string) => intern(`1:${value}`, [1, ...be(value.length), ...new TextEncoder().encode(value)]);
  const classRef = (name: string) => { const nameIndex = utf8(name); return intern(`7:${nameIndex}`, [7, ...be(nameIndex)]); };
  const string = (value: string) => { const valueIndex = utf8(value); return intern(`8:${valueIndex}`, [8, ...be(valueIndex)]); };
  const methodRef = (owner: number, name: string, descriptor: string) => {
    const [nameIndex, descriptorIndex] = [utf8(name), utf8(descriptor)];
    const signature = intern(`12:${nameIndex}:${descriptorIndex}`, [12, ...be(nameIndex), ...be(descriptorIndex)]);
    return intern(`10:${owner}:${signature}`, [10, ...be(owner), ...be(signature)]);
  };

  // new RuntimeException("Stub!"); athrow — constructors first call super() on the declared superclass.
  const parent = u2(poolEnd + 4);
  let raise: number[] | undefined;
  let construct: number[] | undefined;
  const body = (constructor: boolean) => {
    raise ??= (() => {
      const exception = classRef("java/lang/RuntimeException");
      const message = string("Stub!");
      const init = methodRef(exception, "<init>", "(Ljava/lang/String;)V");
      return [0xbb, ...be(exception), 0x59, ...(message > 0xff ? [0x13, ...be(message)] : [0x12, message]), 0xb7, ...be(init), 0xbf];
    })();
    if (!constructor || parent === 0) return raise;
    construct ??= [0x2a, 0xb7, ...be(methodRef(parent, "<init>", "()V"))];
    return [...construct, ...raise];
  };

  const slots = (descriptor: string) =>
    (descriptor.slice(1, descriptor.indexOf(")")).match(/\[*(?:L[^;]*;|.)/g) ?? [])
      .reduce((sum, type) => sum + (type === "J" || type === "D" ? 2 : 1), 0);
  const attributes = (at: number) => {
    const table: [string, Uint8Array][] = [];
    let cursor = at + 2;
    for (let left = u2(at); left > 0; left--) {
      const end = cursor + 6 + u4(cursor + 2);
      table.push([text(u2(cursor)), input.subarray(cursor, end)]);
      cursor = end;
    }
    return { table, end: cursor };
  };

  const interfaces = poolEnd + 6;
  const fields = interfaces + 2 + 2 * u2(interfaces);
  let methods = fields + 2;
  for (let left = u2(fields); left > 0; left--) methods = attributes(methods + 6).end;

  const rebuilt: Uint8Array[] = [];
  let cursor = methods + 2;
  for (let left = u2(methods); left > 0; left--) {
    const [access, name, descriptor] = [u2(cursor), u2(cursor + 2), u2(cursor + 4)];
    const { table, end } = attributes(cursor + 6);
    const kept = table.filter(([attribute]) => attribute !== "Code").map(([, bytes]) => bytes);
    const concrete = (access & (flags.abstract | flags.native)) === 0;
    rebuilt.push(Uint8Array.from([...be(access), ...be(name), ...be(descriptor), ...be(kept.length + Number(concrete))]), ...kept);
    if (concrete) {
      const instructions = body(text(name) === "<init>");
      const locals = slots(text(descriptor)) + (access & flags.static ? 0 : 1);
      rebuilt.push(Uint8Array.from([
        ...be(utf8("Code")), ...be32(12 + instructions.length), ...be(3), ...be(locals),
        ...be32(instructions.length), ...instructions, 0, 0, 0, 0,
      ]));
    }
    cursor = end;
  }
  const classAttributes = attributes(cursor).table.filter(([attribute]) => attribute !== "BootstrapMethods").map(([, bytes]) => bytes);

  return Buffer.concat([
    Uint8Array.from([0xca, 0xfe, 0xba, 0xbe, input[4], input[5], 0, 52, ...be(next)]),
    pool,
    Uint8Array.from(appended),
    input.subarray(poolEnd, methods + 2),
    ...rebuilt,
    Uint8Array.from(be(classAttributes.length)),
    ...classAttributes,
  ]);
}
