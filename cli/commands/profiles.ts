import type { Command } from "commander";
import { loadProfiles, saveProfiles } from "../../src/profiles";

const CONFIG_PATH = "~/.config/threadbase-scanner";

export function registerProfilesCommand(program: Command): void {
  const profiles = program.command("profiles").description("Manage profiles");

  profiles
    .command("list")
    .description("List all profiles")
    .action(async () => {
      const all = await loadProfiles(CONFIG_PATH);
      console.log(`${all.length} profile(s):\n`);
      for (const p of all) {
        const status = p.enabled ? "enabled" : "disabled";
        const emoji = p.emoji || "";
        console.log(`  ${emoji} ${p.label} (${p.id}) [${status}]`);
        console.log(`    ${p.configDir}`);
        console.log();
      }
    });

  profiles
    .command("add <name> <config-dir>")
    .description("Add a profile")
    .action(async (name: string, configDir: string) => {
      const all = await loadProfiles(CONFIG_PATH);
      const id = name.toLowerCase().replace(/\s+/g, "-");
      if (all.find((p) => p.id === id)) {
        console.error(`Profile "${id}" already exists`);
        process.exit(1);
      }
      all.push({ id, label: name, configDir, enabled: true });
      await saveProfiles(all, CONFIG_PATH);
      console.log(`Added profile "${name}" -> ${configDir}`);
    });

  profiles
    .command("remove <name>")
    .description("Remove a profile")
    .action(async (name: string) => {
      const all = await loadProfiles(CONFIG_PATH);
      const filtered = all.filter((p) => p.id !== name);
      if (filtered.length === all.length) {
        console.error(`Profile "${name}" not found`);
        process.exit(1);
      }
      await saveProfiles(filtered, CONFIG_PATH);
      console.log(`Removed profile "${name}"`);
    });
}
