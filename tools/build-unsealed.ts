#!/usr/bin/env bun
// Builds sdks/android-<api>.jar: Robolectric android-all classes stubbed like the official SDK,
// plus the official android.jar's java/javax classes and every non-class entry.
import { $ } from "bun";
import { readdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const repository = "https://dl.google.com/android/repository/";
const robolectric = "https://repo1.maven.org/maven2/org/robolectric/android-all/";

// android-all versions are published under the Android release name, not the API level.
const releases: Record<number, string> = {
  28: "9", 29: "10", 30: "11", 31: "12", 32: "12.1", 33: "13", 34: "14", 35: "15", 36: "16", 37: "17",
};
const blacklist = ["com/android/server/", "android/car/", "com/android/car/"];
const runtime = ["java/", "javax/"];

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const accessFlags = { static: 0x0008, bridge: 0x0040, native: 0x0100, abstract: 0x0400 } as const;
// Constant-pool tags: leaves (Utf8, Integer, Float, Long, Double) carry their value inline; references
// (Class, String, Field/Method/InterfaceMethod refs, NameAndType, MethodType) hold only u2 pool indexes.
const leafConstants = new Set([1, 3, 4, 5, 6]);
const referenceConstants = new Set([7, 8, 9, 10, 11, 12, 16]);

const { positionals: [api], values: { "android-all": androidAllOption, out: outputOption } } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: { "android-all": { type: "string" }, out: { type: "string" } },
});
if (!api) {
  console.error("usage: bun run tools/build-unsealed.ts <api> [--android-all <version>] [--out <jar>]");
  process.exit(2);
}

const [, majorDigits, minorDigits] = /^([1-9]\d*)(?:\.(0|[1-9]\d*))?$/.exec(api) ?? [];
if (!majorDigits) {
  throw new Error(`API ${api} is not supported: expected digits with an optional minor, e.g. 36, 36.1, 37.0, 37.1`);
}
const [major, minor] = [Number(majorDigits), Number(minorDigits ?? 0)];
// Strict version form: 36 and earlier use "36" or a real minor like "36.1" (an explicit ".0"
// is rejected — Google never published a 36.0 platform); 37 and later must name the minor
// explicitly (bare "37" is rejected). Platform directories and jar names follow the same rule.
if (major < 37 && minor === 0 && minorDigits !== undefined) {
  throw new Error(`API ${api}: API ${major} and earlier do not take an explicit zero minor; pass "${major}"`);
}
if (major >= 37 && minorDigits === undefined) {
  throw new Error(`API ${api}: API ${major} and later must name the minor explicitly, e.g. "${major}.0"`);
}
const release = releases[major];
if (!release) {
  throw new Error(`API ${api}: no Android release known for major ${major}; extend the releases table`);
}

const output = resolve(outputOption ?? `sdks/android-${api}.jar`);
const cache = resolve(".unsealed-sdk/cache");
const work = resolve(`.unsealed-sdk/android-${api}`);
const merge = `${work}/merge`;
const overlay = `${work}/overlay`;
const supplement = `${work}/supplement`;
await rm(work, { recursive: true, force: true });

const platform = await platformPackage(major, minor);
console.log(`platform ${platform.path} -> ${platform.url}`);
const official = `${work}/official-android.jar`;
await extractOfficial(await cached(platform.url, platform.sha1), official);

const version = androidAllOption ?? await latestAndroidAll(release);
const androidAllUrl = `${robolectric}${version}/android-all-${version}.jar`;
console.log(`android-all ${version} -> ${androidAllUrl}`);
const [expectedSha1] = (await fetchText(`${androidAllUrl}.sha1`)).trim().split(/\s+/);
const androidAll = await cached(androidAllUrl, expectedSha1);
await verifySdkLevel(androidAll, major);

// The res PNGs are dropped: linking reads only resources.arsc from the platform jar and records
// references by id, which the device resolves against its own framework resources — the files
// themselves are never read (verified: aapt2 link output is byte-identical without them).
await $`unzip -oq ${official} -x '*.class' 'res/*.png' -d ${merge}`;
await $`unzip -oq ${official} ${runtime.map(prefix => `${prefix}*`)} -d ${merge}`;
await $`unzip -oq ${androidAll} '*.class' -x ${blacklist.map(prefix => `${prefix}*`)} -d ${overlay}`;

const overlayClasses = (await readdir(overlay, { recursive: true })).filter(entry => entry.endsWith(".class"));
console.log(`stub ${overlayClasses.length} android-all classes (blacklist: ${blacklist.join(" ")})`);
for (const entry of overlayClasses) {
  try {
    await Bun.write(join(merge, entry), stub(await Bun.file(join(overlay, entry)).bytes()));
  } catch (cause) {
    throw new Error(`cannot stub ${entry}`, { cause });
  }
}

// android-all has no minor builds, so what a minor release adds exists only in the official jar:
// classes android-all lacks are filled from it whole, and the linkable surface it added to existing
// classes (members and InnerClasses entries) is merged into the android-all versions. Both stay at
// stub level, which is all a minor release adds.
if (minor > 0) {
  await $`unzip -oq ${official} '*.class' -d ${supplement}`;
  const officialClasses = (await readdir(supplement, { recursive: true }))
    .filter(entry => entry.endsWith(".class") && !blacklist.some(prefix => entry.startsWith(prefix)));
  let newClasses = 0;
  let patchedClasses = 0;
  let newMembers = 0;
  let newInnerClasses = 0;
  for (const entry of officialClasses) {
    const target = Bun.file(join(merge, entry));
    const source = await Bun.file(join(supplement, entry)).bytes();
    if (!await target.exists()) {
      await Bun.write(target, source);
      newClasses++;
      continue;
    }
    try {
      const { merged, members, innerClasses } = supplementClass(await target.bytes(), source);
      if (members + innerClasses === 0) continue;
      await Bun.write(target, merged);
      patchedClasses++;
      newMembers += members;
      newInnerClasses += innerClasses;
    } catch (cause) {
      throw new Error(`cannot supplement ${entry}`, { cause });
    }
  }
  console.log(`supplement ${newClasses} classes new in ${api} from the official jar (stub level only)`);
  console.log(`supplement ${newMembers} members and ${newInnerClasses} InnerClasses entries in ${patchedClasses} existing classes from the official jar`);
}

await rm(output, { force: true });
await $`cd ${merge} && zip -qrX ${output} .`;
console.log(`wrote ${output} (${Bun.file(output).size} bytes)`);

async function request(url: string) {
  const response = await fetch(url, { headers: { "User-Agent": "UnsealedSdk/1.0" } });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response;
}

async function fetchText(url: string) {
  return (await request(url)).text();
}

async function sha1(path: string) {
  return new Bun.CryptoHasher("sha1").update(await Bun.file(path).arrayBuffer()).digest("hex");
}

async function cached(url: string, expected: string) {
  const path = `${cache}/${basename(new URL(url).pathname)}`;
  if (await Bun.file(path).exists() && await sha1(path) === expected) return path;
  await Bun.write(path, await request(url));
  const actual = await sha1(path);
  if (actual !== expected) throw new Error(`${path} sha1 ${actual}, expected ${expected}`);
  return path;
}

async function platformPackage(major: number, minor: number) {
  const catalog = await fetchText(`${repository}repository2-3.xml`);
  // 37.0+ is published as android-<major>.<minor>; older majors drop a zero minor.
  const target = `platforms;android-${major < 37 && minor === 0 ? major : `${major}.${minor}`}`;
  for (const [, path, body] of catalog.matchAll(/<remotePackage\s+[^>]*path="([^"]+)"[^>]*>([\s\S]*?)<\/remotePackage>/g)) {
    if (path !== target) continue;
    const archive = body.match(/<complete>[\s\S]*?<url>([^<]+)<\/url>/)?.[1];
    const checksum = body.match(/<checksum\s+type="sha1">([^<]+)<\/checksum>/)?.[1];
    if (!archive || !checksum) throw new Error(`${path} is missing url or sha1`);
    return { path, sha1: checksum, url: new URL(archive, repository).toString() };
  }
  throw new Error(`No SDK platform package for API ${api}`);
}

async function extractOfficial(archive: string, destination: string) {
  const entry = (await $`unzip -Z1 ${archive}`.text()).split("\n").find(line => /^[^/]+\/android\.jar$/.test(line));
  if (!entry) throw new Error(`${archive} has no android.jar`);
  await Bun.write(destination, await $`unzip -p ${archive} ${entry}`.arrayBuffer());
}

async function latestAndroidAll(release: string) {
  const metadata = await fetchText(`${robolectric}maven-metadata.xml`);
  const latest = [...metadata.matchAll(/<version>([^<]+)<\/version>/g)]
    .map(([, version]) => version)
    .filter(version => version.startsWith(`${release}-robolectric-`))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .at(-1);
  if (!latest) throw new Error(`No android-all build for Android ${release} (API ${api})`);
  return latest;
}

async function verifySdkLevel(jar: string, expectedMajor: number) {
  const sdk = (await $`unzip -p ${jar} build.prop`.text()).match(/^ro\.build\.version\.sdk=(\d+)$/m)?.[1];
  if (sdk !== String(expectedMajor)) throw new Error(`${basename(jar)} is built for SDK ${sdk}, not API ${api}`);
}

type ClassAttribute = { name: string; at: number; end: number };
type ClassMember = {
  access: number;
  nameIndex: number;
  descriptorIndex: number;
  name: string;
  descriptor: string;
  key: string;
  at: number;
  end: number;
  attributes: ClassAttribute[];
};
type ParsedClass = ReturnType<typeof parseClass>;

// Replaces every concrete method body with the official stub template and lowers the classfile to Java 8.
// The constant pool is copied verbatim and only appended to, so every existing index stays valid.
function stub(input: Uint8Array) {
  const parsed = parseClass(input);
  const writer = poolWriter(parsed);
  const pool = input.slice(10, parsed.poolEnd);
  // Indy/condy entries only serve the discarded bodies. Rewriting each into a NameAndType of the same size keeps
  // every index valid, frees BootstrapMethods, and removes condy, which a Java 8 classfile must not contain.
  parsed.offsets.forEach((offset) => {
    const tag = input[offset];
    if (tag === 17 || tag === 18) {
      const signature = parsed.offsets[parsed.uint16(offset + 3)];
      pool.set([12, ...input.subarray(signature + 1, signature + 5)], offset - 10);
    }
  });

  const rebuiltMethods = parsed.methods.members.flatMap(({ access, nameIndex, descriptorIndex, name, descriptor, attributes }) => {
    const kept = attributes.filter(attribute => attribute.name !== "Code").map(({ at, end }) => input.subarray(at, end));
    const concrete = (access & (accessFlags.abstract | accessFlags.native)) === 0;
    const header = Uint8Array.from([
      ...bytes16(access), ...bytes16(nameIndex), ...bytes16(descriptorIndex), ...bytes16(kept.length + Number(concrete)),
    ]);
    return concrete ? [header, ...kept, Uint8Array.from(writer.stubCode(access, name, descriptor))] : [header, ...kept];
  });
  const classAttributes = parsed.attributes
    .filter(attribute => attribute.name !== "BootstrapMethods")
    .map(({ at, end }) => input.subarray(at, end));

  return Buffer.concat([
    Uint8Array.from([0xca, 0xfe, 0xba, 0xbe, input[4], input[5], 0, 52, ...bytes16(writer.count())]),
    pool,
    Uint8Array.from(writer.appended),
    input.subarray(parsed.poolEnd, parsed.methods.at + 2),
    ...rebuiltMethods,
    Uint8Array.from(bytes16(classAttributes.length)),
    ...classAttributes,
  ]);
}

// Merges the official class's linkable surface into the target: fields, methods, and InnerClasses entries
// (javac finds a nested type, or the flags of one a signature mentions, only through them). Where Java source
// cannot overload, the official form wins: a field replaces any target field of its name, and a non-bridge
// method replaces the non-bridge method with its name and parameter list; bridges are never replaced and
// never replace. Official constants are copied into the target pool append-only, so every existing index
// stays valid. Added methods get the stub body stub() writes; added members keep only the attributes a
// signature needs (ConstantValue, Exceptions, Signature, MethodParameters, Deprecated, Synthetic).
function supplementClass(target: Uint8Array, source: Uint8Array) {
  const base = parseClass(target);
  const official = parseClass(source);
  const isBridge = ({ access }: ClassMember) => (access & accessFlags.bridge) !== 0;
  const nestedOf = (parsed: ParsedClass) => {
    const attribute = parsed.attributes.find(({ name }) => name === "InnerClasses");
    const entries = Array.from({ length: attribute ? parsed.uint16(attribute.at + 6) : 0 }, (_, index) => {
      const at = attribute!.at + 8 + 8 * index;
      return { at, name: parsed.stringAt(parsed.uint16(parsed.offsets[parsed.uint16(at)] + 1)) };
    });
    return { attribute, entries };
  };

  const fieldKeys = new Set(base.fields.members.map(field => field.key));
  const addedFields = official.fields.members.filter(field => !fieldKeys.has(field.key));
  const retyped = new Set(addedFields.map(field => field.name));
  const keptFields = base.fields.members.filter(field => !retyped.has(field.name));

  const overloadKey = ({ key }: ClassMember) => key.slice(0, key.indexOf(")") + 1);
  const methodKeys = new Set(base.methods.members.map(method => method.key));
  const realMethods = new Map(base.methods.members.filter(method => !isBridge(method)).map(method => [overloadKey(method), method]));
  const addedMethods = official.methods.members.filter(method => !methodKeys.has(method.key));
  const replaced = new Set(addedMethods.filter(method => !isBridge(method)).flatMap(method => realMethods.get(overloadKey(method)) ?? []));
  const keptMethods = base.methods.members.filter(method => !replaced.has(method));

  const baseNested = nestedOf(base);
  const officialNested = nestedOf(official);
  const nestedNames = new Set(baseNested.entries.map(({ name }) => name));
  const addedNested = officialNested.entries.filter(({ name }) => !nestedNames.has(name));

  const members = addedFields.length + addedMethods.length;
  if (members + addedNested.length === 0) return { merged: target, members, innerClasses: 0 };

  const writer = poolWriter(base);
  // Leaf constants are copied byte for byte; reference constants are rebuilt from their remapped operands.
  const remap = (index: number): number => {
    if (index === 0) return 0;
    const entry = official.entries[index];
    const [tag] = entry;
    if (leafConstants.has(tag)) return writer.intern(entry);
    if (!referenceConstants.has(tag)) throw new Error(`cannot remap constant tag ${tag}`);
    const operands = Array.from({ length: (entry.length - 1) / 2 }, (_, slot) => remap((entry[1 + 2 * slot] << 8) | entry[2 + 2 * slot]));
    return writer.intern(Uint8Array.of(tag, ...operands.flatMap(bytes16)));
  };

  // The name is remapped only for attributes that are carried, before their payload, so a dropped
  // attribute leaves nothing behind in the pool.
  const carryAttribute = ({ name, at }: ClassAttribute): number[] | undefined => {
    const body = at + 6;
    const carry = (payload: () => number[]) => {
      const nameIndex = remap(official.uint16(at));
      const bytes = payload();
      return [...bytes16(nameIndex), ...bytes32(bytes.length), ...bytes];
    };
    switch (name) {
      case "ConstantValue":
      case "Signature":
        return carry(() => bytes16(remap(official.uint16(body))));
      case "Exceptions":
        return carry(() => {
          const count = official.uint16(body);
          return [...bytes16(count), ...Array.from({ length: count }, (_, index) => bytes16(remap(official.uint16(body + 2 + 2 * index)))).flat()];
        });
      case "MethodParameters":
        return carry(() => {
          const count = source[body];
          return [count, ...Array.from({ length: count }, (_, index) => [
            ...bytes16(remap(official.uint16(body + 1 + 4 * index))), ...bytes16(official.uint16(body + 3 + 4 * index)),
          ]).flat()];
        });
      case "Deprecated":
      case "Synthetic":
        return carry(() => []);
      default:
        return undefined;
    }
  };

  const encodeMember = ({ access, nameIndex, descriptorIndex, name, descriptor, attributes }: ClassMember, isMethod: boolean) => {
    const carried = attributes.map(carryAttribute).filter((bytes): bytes is number[] => bytes !== undefined);
    if (isMethod && (access & (accessFlags.abstract | accessFlags.native)) === 0) {
      carried.push(writer.stubCode(access, name, descriptor));
    }
    return Uint8Array.from([
      ...bytes16(access), ...bytes16(remap(nameIndex)), ...bytes16(remap(descriptorIndex)),
      ...bytes16(carried.length), ...carried.flat(),
    ]);
  };

  const encodedFields = addedFields.map(field => encodeMember(field, false));
  const encodedMethods = addedMethods.map(method => encodeMember(method, true));
  const classAttributes = base.attributes.map(({ at, end }) => target.subarray(at, end));
  if (addedNested.length) {
    const encodedNested = addedNested.flatMap(({ at }) => [
      ...bytes16(remap(official.uint16(at))), ...bytes16(remap(official.uint16(at + 2))),
      ...bytes16(remap(official.uint16(at + 4))), ...bytes16(official.uint16(at + 6)),
    ]);
    const existing = baseNested.attribute;
    const entryCount = baseNested.entries.length + addedNested.length;
    const attribute = Uint8Array.from([
      ...bytes16(existing ? base.uint16(existing.at) : remap(official.uint16(officialNested.attribute!.at))),
      ...bytes32(2 + 8 * entryCount), ...bytes16(entryCount),
      ...(existing ? target.subarray(existing.at + 8, existing.end) : []), ...encodedNested,
    ]);
    if (existing) classAttributes[base.attributes.indexOf(existing)] = attribute;
    else classAttributes.push(attribute);
  }

  const merged = Buffer.concat([
    Uint8Array.from([...target.subarray(0, 8), ...bytes16(writer.count())]),
    target.subarray(10, base.poolEnd),
    Uint8Array.from(writer.appended),
    target.subarray(base.poolEnd, base.fields.at),
    Uint8Array.from(bytes16(keptFields.length + encodedFields.length)),
    ...keptFields.map(({ at, end }) => target.subarray(at, end)),
    ...encodedFields,
    Uint8Array.from(bytes16(keptMethods.length + encodedMethods.length)),
    ...keptMethods.map(({ at, end }) => target.subarray(at, end)),
    ...encodedMethods,
    Uint8Array.from(bytes16(classAttributes.length)),
    ...classAttributes,
  ]);
  return { merged, members, innerClasses: addedNested.length };
}

function parseClass(bytes: Uint8Array) {
  const constantSizes: Record<number, number> = {
    3: 4, 4: 4, 5: 8, 6: 8, 7: 2, 8: 2, 9: 4, 10: 4, 11: 4, 12: 4, 15: 3, 16: 2, 17: 4, 18: 4, 19: 2, 20: 2,
  };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const uint16 = (at: number) => view.getUint16(at);
  const uint32 = (at: number) => view.getUint32(at);

  const poolCount = uint16(8);
  const offsets: number[] = [];
  const entries: Uint8Array[] = [];
  let poolEnd = 10;
  for (let index = 1; index < poolCount; index++) {
    const tag = bytes[poolEnd];
    const size = tag === 1 ? 2 + uint16(poolEnd + 1) : constantSizes[tag];
    if (size === undefined) throw new Error(`unknown constant tag ${tag} at #${index}`);
    offsets[index] = poolEnd;
    entries[index] = bytes.subarray(poolEnd, poolEnd + 1 + size);
    poolEnd += 1 + size;
    if (tag === 5 || tag === 6) index++;
  }

  const stringAt = (index: number) => {
    const at = offsets[index];
    return decoder.decode(bytes.subarray(at + 3, at + 3 + uint16(at + 1)));
  };
  const readAttributes = (at: number) => {
    const list: ClassAttribute[] = [];
    let cursor = at + 2;
    for (let remaining = uint16(at); remaining > 0; remaining--) {
      const end = cursor + 6 + uint32(cursor + 2);
      list.push({ name: stringAt(uint16(cursor)), at: cursor, end });
      cursor = end;
    }
    return { list, end: cursor };
  };
  const readMembers = (at: number) => {
    const members: ClassMember[] = [];
    let cursor = at + 2;
    for (let remaining = uint16(at); remaining > 0; remaining--) {
      const [access, nameIndex, descriptorIndex] = [uint16(cursor), uint16(cursor + 2), uint16(cursor + 4)];
      const [name, descriptor] = [stringAt(nameIndex), stringAt(descriptorIndex)];
      const { list: attributes, end } = readAttributes(cursor + 6);
      members.push({ access, nameIndex, descriptorIndex, name, descriptor, key: `${name}:${descriptor}`, at: cursor, end, attributes });
      cursor = end;
    }
    return { at, members, end: cursor };
  };

  const superClass = uint16(poolEnd + 4);
  const interfacesAt = poolEnd + 6;
  const fields = readMembers(interfacesAt + 2 + 2 * uint16(interfacesAt));
  const methods = readMembers(fields.end);
  const attributes = readAttributes(methods.end).list;
  return { bytes, uint16, uint32, poolCount, offsets, entries, poolEnd, superClass, stringAt, fields, methods, attributes };
}

function poolWriter(parsed: ParsedClass) {
  const { entries, superClass } = parsed;
  // A constant is identified by its exact serialized bytes, so lookups never depend on decoding.
  const known = new Map<string, number>();
  entries.forEach((entry, index) => {
    const key = entry.toHex();
    if (!known.has(key)) known.set(key, index);
  });

  const appended: number[] = [];
  let count = parsed.poolCount;
  const intern = (entry: Uint8Array) => {
    const key = entry.toHex();
    const existing = known.get(key);
    if (existing !== undefined) return existing;
    const width = entry[0] === 5 || entry[0] === 6 ? 2 : 1;
    if (count + width > 0xffff) throw new Error("constant pool overflow");
    known.set(key, count);
    appended.push(...entry);
    count += width;
    return count - width;
  };
  // Only the stub template's fixed ASCII literals are built from text; everything else is copied as bytes.
  const utf8 = (value: string) => {
    const encoded = encoder.encode(value);
    return intern(Uint8Array.of(1, ...bytes16(encoded.length), ...encoded));
  };
  const classRef = (name: string) => intern(Uint8Array.of(7, ...bytes16(utf8(name))));
  const stringRef = (value: string) => intern(Uint8Array.of(8, ...bytes16(utf8(value))));
  const methodRef = (owner: number, name: string, descriptor: string) => {
    const signature = intern(Uint8Array.of(12, ...bytes16(utf8(name)), ...bytes16(utf8(descriptor))));
    return intern(Uint8Array.of(10, ...bytes16(owner), ...bytes16(signature)));
  };

  // new RuntimeException("Stub!"); athrow — constructors first call super() on the declared superclass.
  let throwStub: number[] | undefined;
  let superInit: number[] | undefined;
  const instructionsFor = (constructor: boolean) => {
    throwStub ??= (() => {
      const exception = classRef("java/lang/RuntimeException");
      const message = stringRef("Stub!");
      const init = methodRef(exception, "<init>", "(Ljava/lang/String;)V");
      return [0xbb, ...bytes16(exception), 0x59, ...(message > 0xff ? [0x13, ...bytes16(message)] : [0x12, message]), 0xb7, ...bytes16(init), 0xbf];
    })();
    if (!constructor || superClass === 0) return throwStub;
    superInit ??= [0x2a, 0xb7, ...bytes16(methodRef(superClass, "<init>", "()V"))];
    return [...superInit, ...throwStub];
  };
  const stubCode = (access: number, name: string, descriptor: string) => {
    const instructions = instructionsFor(name === "<init>");
    const locals = parameterSlots(descriptor) + (access & accessFlags.static ? 0 : 1);
    return [
      ...bytes16(utf8("Code")), ...bytes32(12 + instructions.length), ...bytes16(3), ...bytes16(locals),
      ...bytes32(instructions.length), ...instructions, 0, 0, 0, 0,
    ];
  };

  return { appended, count: () => count, intern, stubCode };
}

function bytes16(value: number) {
  return [value >> 8, value & 0xff];
}

function bytes32(value: number) {
  return [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function parameterSlots(descriptor: string) {
  return (descriptor.slice(1, descriptor.indexOf(")")).match(/\[*(?:L[^;]*;|.)/g) ?? [])
    .reduce((total, type) => total + (type === "J" || type === "D" ? 2 : 1), 0);
}
