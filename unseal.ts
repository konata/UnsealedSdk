#!/usr/bin/env bun
// Swap SDK platform android.jar between the official and unsealed builds.

import { copyFileSync, existsSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

const icons = { original: "  ", unsealed: "⚡", restored: "📦", chaos: "💀" } as const;
type State = keyof typeof icons;
type Platform = {
  version: string;
  jar: string;
  backup: string;
  unsealed: string;
  state: State;
};

const [, script = "unseal.ts", command = "man", target] = Bun.argv;
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
if (!sdk) fail("ANDROID_HOME is not set");
const platforms = join(sdk, "platforms");

const commands: Record<string, () => Promise<void> | void> = {
  ls() {
    const installed = readdirSync(platforms)
      .map(entry => /^android-(.+)$/.exec(entry)?.[1])
      .filter((version): version is string => version !== undefined && !versionError(version))
      .map(platform)
      .filter((found): found is Platform => found !== null)
      .sort((left, right) => left.version.localeCompare(right.version, undefined, { numeric: true }));
    const width = Math.max(...installed.map(({ version }) => version.length));
    for (const { version, state } of installed) {
      console.log(`${icons[state]} ${version.padEnd(width)}  ${state}`);
    }
  },

  async unseal() {
    const { version, jar, backup, unsealed, state } = requirePlatform(target);
    if (state === "unsealed") {
      console.log(`*** SDK ${version} is already unsealed ***`);
      return;
    }
    if (!existsSync(backup)) {
      copyFileSync(jar, backup);
      console.log(`*** backed up official jar to ${backup} ***`);
    }
    if (Bun.file(unsealed).size === 0) {
      const url = `https://raw.githubusercontent.com/konata/UnsealedSdk/main/sdks/android-${version}.jar`;
      console.log(`*** downloading ${url} ***`);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`);
      const partial = `${unsealed}.part`;
      await Bun.write(partial, response);
      renameSync(partial, unsealed);
    }
    replaceJar(unsealed, jar);
    console.log(`*** unsealed SDK ${version} installed ***`);
  },

  restore() {
    const { version, jar, backup, state } = requirePlatform(target);
    if (state !== "unsealed") {
      console.log(`*** SDK ${version} is ${state}, not unsealed; nothing to do ***`);
      return;
    }
    replaceJar(backup, jar);
    console.log(`*** official SDK ${version} restored ***`);
  },

  purge() {
    const { version, jar, backup, unsealed, state } = requirePlatform(target);
    if (state === "unsealed") {
      replaceJar(backup, jar);
      console.log(`*** official SDK ${version} restored ***`);
    }
    for (const sidecar of [unsealed, backup]) {
      if (!existsSync(sidecar)) continue;
      unlinkSync(sidecar);
      console.log(`*** deleted ${sidecar} ***`);
    }
    console.log(`*** SDK ${version} is original now ***`);
  },

  man() {
    console.log(`Usage: bun <command> [version]  (or: bun ${resolve(script)} <command> [version])

Commands:
  ls                list installed SDK platforms and their states
  unseal <version>  download the unsealed jar if needed, then point android.jar at it
  restore <version> point android.jar back at the official jar (only when unsealed)
  purge <version>   restore if needed, then delete the unsealed and official backup jars
  man               show this help

States: original (never downloaded), restored (android.jar is the official jar),
        unsealed (android.jar is the unsealed jar), chaos (android.jar matches neither).

Version form must match the platform directory exactly: "36" or "36.1" up to API 36,
"37.0" or "37.1" from API 37 on — shorthands like "37" for "37.0" are rejected.

The SDK is located through ANDROID_HOME (ANDROID_SDK_ROOT as fallback).`);
  },
};

const run = commands[command];
if (!run) {
  console.error(`unknown command: ${command}`);
  commands.man();
  process.exit(1);
}
await run();

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// Version form must match the platform directory exactly: "36" or "36.1" for 36 and earlier,
// "37.0" or "37.1" from 37 on. Shorthands like "37" for "37.0" are rejected to stay unambiguous.
function versionError(version: string): string | null {
  const [, major, minor] = /^([1-9]\d*)(?:\.(0|[1-9]\d*))?$/.exec(version) ?? [];
  if (!major) return "expected digits with an optional minor, e.g. 36, 36.1, 37.0, 37.1";
  if (Number(major) < 37 && minor === "0") {
    return `API ${major} and earlier do not take an explicit zero minor; pass "${major}"`;
  }
  if (Number(major) >= 37 && minor === undefined) {
    return `API ${major} and later must name the minor explicitly, e.g. "${major}.0"`;
  }
  return null;
}

function platform(version: string): Platform | null {
  const directory = join(platforms, `android-${version}`);
  const jar = join(directory, "android.jar");
  if (!existsSync(jar)) return null;
  const backup = join(directory, "android.official.jar");
  const unsealed = join(directory, "android.unsealed.jar");
  const jarSize = Bun.file(jar).size;
  const unsealedSize = Bun.file(unsealed).size;
  const state: State = unsealedSize === 0 ? "original"
    : jarSize === unsealedSize ? "unsealed"
    : existsSync(backup) && jarSize === Bun.file(backup).size ? "restored"
    : "chaos";
  return { version, jar, backup, unsealed, state };
}

function requirePlatform(version?: string): Platform {
  if (!version) fail(`missing version, e.g. "bun unseal.ts ${command} 37.1"`);
  const problem = versionError(version);
  if (problem) fail(`invalid version "${version}": ${problem}`);
  return platform(version) ?? fail(`no platform for ${version} at ${platforms}; install it in SDK Manager first`);
}

function replaceJar(source: string, destination: string) {
  unlinkSync(destination);
  copyFileSync(source, destination);
}
