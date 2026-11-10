#!/usr/bin/env bun
// Swap SDK platform android.jar between the official and unsealed builds.
// The SDK is located through ANDROID_HOME (ANDROID_SDK_ROOT as fallback), the usual rule.

import { copyFileSync, existsSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

type Platform = {
  version: string; // "37" or "37.1"
  dir: string;
  jar: string;
  backup: string;
  unsealed: string;
  remote: string;
  state: "unsealed" | "restored" | "original" | "chaos";
};

const home = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
if (!home) {
  console.error("ANDROID_HOME is not set");
  process.exit(1);
}
const platformsDir = join(home, "platforms");

const sameFile = (a: string, b: string) => Bun.file(a).size === Bun.file(b).size;

// Version form must match the platform directory exactly: "36" or "36.1" for 36 and earlier,
// "37.0" or "37.1" from 37 on. Shorthands like "37" for "37.0" are rejected to stay unambiguous.
const versionOf = (dir: string): string | null => /^android-(\d+(?:\.\d+)?)$/.exec(dir)?.[1] ?? null;

const platform = (version: string): Platform | null => {
  const [major, minor] = version.split(".");
  if (!/^\d+$/.test(major ?? "") || (minor !== undefined && !/^\d+$/.test(minor))) return null;
  if (minor === undefined && Number(major) >= 37) return null;
  const dir = `android-${version}`;
  const jar = join(platformsDir, dir, "android.jar");
  if (!existsSync(jar)) return null;
  const backup = join(jar, "..", "android.official.jar");
  const unsealed = join(jar, "..", "android.unsealed.jar");
  const downloaded = existsSync(unsealed) && statSync(unsealed).size > 0;
  const state = !downloaded
    ? "original"
    : sameFile(jar, unsealed)
      ? "unsealed"
      : existsSync(backup) && sameFile(jar, backup)
        ? "restored"
        : "chaos";
  return {
    version,
    dir,
    jar,
    backup,
    unsealed,
    remote: `android-${version}.jar`,
    state,
  };
};

const known = readdirSync(platformsDir)
  .map(versionOf)
  .filter((v): v is string => v !== null)
  .map(platform)
  .filter((p): p is Platform => p !== null)
  .sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));

const requirePlatform = (version?: string): Platform => {
  if (!version) {
    console.error(`missing version, e.g. "bun unseal.ts ${process.argv[2]} 37.1"`);
    process.exit(1);
  }
  const [major, minor] = version.split(".");
  if (!/^\d+$/.test(major) || (minor !== undefined && !/^\d+$/.test(minor))) {
    console.error(`invalid version "${version}": expected digits with an optional minor, e.g. 36, 36.1, 37.0, 37.1`);
    process.exit(1);
  }
  if (minor === "0" && Number(major) < 37) {
    console.error(`invalid version "${version}": API ${major} and earlier do not take an explicit zero minor; pass "${major}"`);
    process.exit(1);
  }
  if (minor === undefined && Number(major) >= 37) {
    console.error(`invalid version "${version}": API ${major} and later must name the minor explicitly, e.g. "${major}.0"`);
    process.exit(1);
  }
  const p = platform(version);
  if (!p) {
    console.error(`no platform for ${version} at ${platformsDir}; install it in SDK Manager first`);
    process.exit(1);
  }
  return p;
};

const swap = (from: string, to: string) => {
  unlinkSync(to);
  copyFileSync(from, to);
};

const icons = { original: "  ", unsealed: "⚡", restored: "📦", chaos: "💀" } as const;

const commands: Record<string, (version?: string) => void> = {
  ls() {
    const width = Math.max(...known.map((p) => p.version.length));
    for (const p of known) console.log(`${icons[p.state]} ${p.version.padEnd(width)}  ${p.state}`);
  },

  async unseal(version) {
    const p = requirePlatform(version);
    if (p.state === "unsealed") {
      console.log(`*** SDK ${p.version} is already unsealed ***`);
      return;
    }
    if (!existsSync(p.backup)) {
      copyFileSync(p.jar, p.backup);
      console.log(`*** backed up official jar to ${p.backup} ***`);
    }
    if (!existsSync(p.unsealed) || statSync(p.unsealed).size === 0) {
      const url = `https://raw.githubusercontent.com/konata/UnsealedSdk/main/sdks/${p.remote}`;
      console.log(`*** downloading ${url} ***`);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`);
      const part = `${p.unsealed}.part`;
      await Bun.write(part, response);
      renameSync(part, p.unsealed);
    }
    swap(p.unsealed, p.jar);
    console.log(`*** unsealed SDK ${p.version} installed ***`);
  },

  restore(version) {
    const p = requirePlatform(version);
    if (p.state !== "unsealed") {
      console.log(`*** SDK ${p.version} is ${p.state}, not unsealed; nothing to do ***`);
      return;
    }
    swap(p.backup, p.jar);
    console.log(`*** official SDK ${p.version} restored ***`);
  },

  purge(version) {
    const p = requirePlatform(version);
    if (p.state === "unsealed") {
      swap(p.backup, p.jar);
      console.log(`*** official SDK ${p.version} restored ***`);
    }
    for (const jar of [p.unsealed, p.backup]) {
      if (existsSync(jar)) {
        unlinkSync(jar);
        console.log(`*** deleted ${jar} ***`);
      }
    }
    console.log(`*** SDK ${p.version} is original now ***`);
  },

  man() {
    const script = resolve(process.argv[1] ?? "unseal.ts");
    console.log(`Usage: bun <command> [version]  (or: bun ${script} <command> [version])

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

const command = process.argv[2] ?? "man";
const run = commands[command];
if (!run) {
  console.error(`unknown command: ${command}`);
  commands.man();
  process.exit(1);
}
await run(process.argv[3]);
