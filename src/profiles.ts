import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import type { Profile } from "./types";

const PROFILES_FILE = "profiles.json";

export function resolveConfigDir(configDir: string): string {
  return configDir.replace(/^~/, homedir());
}

export function getProjectsDir(profile: Profile): string {
  return join(resolveConfigDir(profile.configDir), "projects");
}

export async function detectDefaultProfile(): Promise<Profile> {
  return {
    id: "default",
    label: "Default",
    configDir: join(homedir(), ".claude"),
    enabled: true,
    emoji: "🤖",
  };
}

export async function loadProfiles(configPath: string): Promise<Profile[]> {
  try {
    const resolved = resolveConfigDir(configPath);
    const data = await readFile(join(resolved, PROFILES_FILE), "utf-8");
    return JSON.parse(data) as Profile[];
  } catch {
    const defaultProfile = await detectDefaultProfile();
    return [defaultProfile];
  }
}

export async function saveProfiles(profiles: Profile[], configPath: string): Promise<void> {
  const resolved = resolveConfigDir(configPath);
  await mkdir(resolved, { recursive: true });
  await writeFile(join(resolved, PROFILES_FILE), JSON.stringify(profiles, null, 2));
}
