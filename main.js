#!/usr/bin/env node
import fetch from "node-fetch";
import ora from "ora";
import { parse } from "node-html-parser";
import { existsSync, writeFileSync, unlinkSync, readdirSync, symlinkSync, mkdirSync } from "node:fs";
import { Command, Option } from "commander";
import path from "path"
import { fileURLToPath } from "url"
import { createRequire } from "module";
import { Console } from "console";
import { Transform } from "stream";
import chalk from "chalk";
import { platform } from "node:os";
const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

if(!existsSync(__dirname + "/config.json")) writeFileSync(__dirname + "/config.json", JSON.stringify({selected_profile: null, mods_dir: getModsDir()}, null, 2));
const config = require("./config.json");
const ROOT_DIR = __dirname + "/.modder";
if(!existsSync(ROOT_DIR)) mkdirSync(ROOT_DIR, { recursive: true });
if(!existsSync(ROOT_DIR + "/profiles")) mkdirSync(ROOT_DIR + "/profiles");
if(!existsSync(ROOT_DIR + "/mods")) mkdirSync(ROOT_DIR + "/mods");
if(!existsSync(ROOT_DIR + "/libs")) mkdirSync(ROOT_DIR + "/libs");

let spinner;

function table(input) {
  // @see https://stackoverflow.com/a/67859384
  const ts = new Transform({ transform(chunk, enc, cb) { cb(null, chunk) } })
  const logger = new Console({ stdout: ts })
  logger.table(input)
  const table = (ts.read() || '').toString()
  let result = '';
  for (let row of table.split(/[\r\n]+/)) {
    let r = row.replace(/[^┬]*┬/, '┌');
    r = r.replace(/^├─*┼/, '├');
    r = r.replace(/│[^│]*/, '');
    r = r.replace(/^└─*┴/, '└');
    r = r.replace(/'/g, ' ');
    result += `${r}\n`;
  }
  console.log(result);
}

function getModsDir() {
  if(platform() == "win32") return process.env.APPDATA + "/.minecraft/mods";
  if(platform() == "darwin") return process.env.HOME + "/Library/Application Support/minecraft/mods";
  if(platform() == "linux") return process.env.HOME + "/.minecraft/mods";
  console.warn("Platform not known, please set the mods directory in config.json manually");
  return "";
}

async function downloadOptifine(path, version) {
  spinner = ora("Fetching optifine versions").start();
  const versions = await fetch("https://optifine.net/downloads").then(res => res.text());
  spinner.succeed();
  const vroot = parse(versions);
  const h2 = vroot.querySelector(`h2:contains("Minecraft ${version}")`);
  const url = h2.nextElementSibling.tagName == "TABLE" ? h2.nextElementSibling.querySelector("tr.downloadLine .colDownload a").attributes.href : h2.nextElementSibling.nextElementSibling.querySelector("tr.downloadLine .colDownload a").attributes.href;
  // const url = vroot.querySelector("table.mainTable tr.downloadLine .colDownload a").attributes.href;
  const predownloadURL = "http://optifine.net" + url.split("http://optifine.net").pop().split("&x=").shift();
  spinner = ora("Fetching optifine download").start();
  const download = await fetch(predownloadURL).then(res => res.text());
  spinner.succeed();
  const droot = parse(download);
  const downloadURL = droot.querySelector(".downloadButton a").attributes.href;
  spinner = ora("Downloading optifine").start();
  const optifine = await fetch("https://optifine.net/" + downloadURL).then(res => res.arrayBuffer());
  writeFileSync(path, Buffer.from(optifine));
  spinner.succeed();
}

function removeLinks() {
  if(existsSync(config.mods_dir)) {
    const oldMods = readdirSync(config.mods_dir);
    for(let mod of oldMods) {
      unlinkSync(`${config.mods_dir}/${mod}`);
    }
  }
}

function createLinks(profile) {
  const mods = profile.mods.map(mod => `${ROOT_DIR}/mods/${mod}-${profile.version}-${profile.loader}.jar`);

  for(const mod of mods) {
    if(!existsSync(mod)) {
      console.error(`Mod ${mod} does not exist on disk`);
      return;
    }

    const modName = mod.split("/").pop();
    const modPath = `${config.mods_dir}/${modName}`;
    if(existsSync(modPath)) {
      unlinkSync(modPath);
    }
    symlinkSync(mod, modPath);
  }

  const libs = profile.libs.map(mod => `${ROOT_DIR}/libs/${mod}-${profile.version}-${profile.loader}.jar`);

  for(const lib of libs) {
    if(!existsSync(lib)) {
      console.error(`Lib ${lib} does not exist on disk`);
      return;
    }

    const libName = lib.split("/").pop();
    const libPath = `${config.mods_dir}/${libName}`;
    if(existsSync(libPath)) {
      unlinkSync(libPath);
    }
    symlinkSync(lib, libPath);
  }

  if(profile.fork) {
    for(const fork of profile.fork) {
      const fprofile = require(ROOT_DIR + "/profiles/" + fork + ".json");
      createLinks(fprofile);
    }
  }
}

function updateModsDir() {
  if(config.selected_profile == null) {
    // console.error("No profile selected. Please select a profile with `modder switch <profile>` or use the --profile option.");
    removeLinks();
    return;
  }
  const profile = require(ROOT_DIR + "/profiles/" + config.selected_profile + ".json");
  if(profile.mods.length == 0) {
    // console.error("No mods in profile");
    removeLinks();
    return;
  }

  removeLinks();

  createLinks(profile);
}

function addToProfile(slug) {
  const profile = require(ROOT_DIR + "/profiles/" + config.selected_profile + ".json");
  if(profile.mods.includes(slug)) return;
  profile.mods.push(slug);
  spinner = ora("Writing profile").start();
  writeFileSync(`${ROOT_DIR}/profiles/${config.selected_profile}.json`, JSON.stringify(profile, null, 2));
  updateModsDir();
  spinner.succeed();
}

async function install(slugs, { add, version, loader, update }) {
  const profile = require(ROOT_DIR + "/profiles/" + config.selected_profile + ".json");
  const VERSION = version || profile.version;
  const LOADER = loader || profile.loader;

  for(const slug of slugs) {
    console.log(`Installing ${slug}`);
    console.log("");
    if(slug == "optifine") {
      if(LOADER !== "forge") {
        console.error("Optifine is only compatible with Forge.");
        continue;
      }
      await downloadOptifine(ROOT_DIR + "/mods/optifine-" + VERSION + "-forge.jar", VERSION);

      if(add) {
        addToProfile(slug);
      }
      continue;
    }
    spinner = ora("Fetching mod info").start();
    const project = await fetch(`https://api.modrinth.com/v2/project/${slug}`).then(res => res.json());
    if(project.client_side == "unsupported") {
      console.log(`${project.title} is not available for the minecraft client.`);
      return;
    }
    let versions = await fetch(`https://api.modrinth.com/v2/project/${slug}/version?loaders=["${LOADER}"]`).then(res => res.json());
    version = versions.find(v => v.game_versions.includes(VERSION));
    if(!version.loaders.includes(LOADER)) {
      spinner.fail(`${project.title} does not support ${LOADER}`);
      continue;
    }
    versions = await fetch(`https://api.modrinth.com/v2/project/${slug}/version?game_versions=["${VERSION}"]`).then(res => res.json());
    version = versions.find(v => v.game_versions.includes(VERSION));
    if(version == undefined) {
      spinner.fail(`${project.title} does not support ${VERSION}`);
      continue;
    }
    versions = await fetch(`https://api.modrinth.com/v2/project/${slug}/version?loaders=["${LOADER}"]&game_versions=["${VERSION}"]`).then(res => res.json());
    let file = version.files.find(f => f.primary);
    if(file == undefined) {
      file = version.files[0];
      if(file == undefined) {
        spinner.fail(`${project.title} does not have a file for ${VERSION}`);
        continue;
      }
    }
    if(existsSync(`${ROOT_DIR}/mods/${project.slug}-${VERSION}-${LOADER}.jar`)) {
      if(update) {
        unlinkSync(`${ROOT_DIR}/mods/${project.slug}-${VERSION}-${LOADER}.jar`);
      } else if(add) {
        spinner.succeed();
        addToProfile(slug);
        continue;
      } else {
        spinner.succeed();
        console.error("Mod already installed and not added to profile");
        continue;
      }
    }
    spinner.succeed();

    spinner = ora("Downloading mod").start();
    const mod = await fetch(file.url).then(res => res.arrayBuffer());
    spinner.succeed();
    spinner = ora("Writing mod").start();
    writeFileSync(`${ROOT_DIR}/mods/${slug}-${VERSION}-${LOADER}.jar`, Buffer.from(mod));
    spinner.succeed();

    // TODO
    // if(version.dependencies.length !== 0) {
    //   for(let dependency of version.dependencies) {
    //     spinner = ora(`Installing dependency ${dependency.title}`).start();
    //     const dep = await fetch(`https://api.modrinth.com/v2/project/${dependency.slug}`).then(res => res.json());
    //     const versions = await fetch(`https://api.modrinth.com/v2/project/${dependency.slug}/version`).then(res => res.json());
    //     const version = versions.find(v => v.game_versions.includes(VERSION));
    //     if(version == undefined) {
    //       spinner.fail(`${dep.title} does not support ${VERSION}`);
    //       continue;
    //     }
    //     if(!version.loaders.includes(LOADER)) {
    //       spinner.fail(`${dep.title} does not support ${LOADER}`);
    //       continue;
    //     }
    //     const file = version.files.find(f => f.primary);
    //     spinner.succeed();

    //     spinner = ora("Downloading dependency").start();
    //     const mod = await fetch(file.url).then(res => res.arrayBuffer());
    //     spinner.succeed();
    //     spinner = ora("Writing dependency").start();
    //     writeFileSync(`${ROOT_DIR}/libs/${dependency.slug}-${VERSION}-${LOADER}.jar`, Buffer.from(mod));
    //     spinner.succeed();
    //   }
    // }

    if(add) {
      addToProfile(slug);
    }
  }
}

function installModsFromProfiles() {

}

const program = new Command().name("modder").version("1.0");


program
  .command("install [slugs...]")
  .description("Install a mod")
  .addOption(new Option("-a, --no-add", "Don't add the mod to the profile"))
  .addOption(new Option("-u, --update", "Update mods"))
  .addOption(new Option("-v, --version <version>", "Game version to install the mod for"))
  .addOption(new Option("-l, --loader <loader>", "The modloader to install the mod for"))
  .action(async (slugs, { noAdd: add, version: ver, loader, update }) => {
    if(config.selected_profile == null) {
      console.error("No profile selected. Please select a profile with `modder switch <profile>` or use the --profile option.");
      return;
    }
    if(add == undefined) {
      add = true;
    }
    
    if(slugs.length > 0) await install(slugs, { add, ver, loader, update });
    else {
      const profile = require(ROOT_DIR + "/profiles/" + config.selected_profile + ".json");
      await install(profile.mods, { add: true, ver, loader, update });
    }
  });


program
  .command("search <mod>")
  .description("Search for mod")
  .action(async (mod) => {
    const search = await fetch(`https://api.modrinth.com/v2/search?index=relevance&query=${mod}`).then(res => res.json());
    const info = [];
    for (const hit of search.hits.filter(hit => hit.project_type === "mod")) {
      info.push({
        slug: hit.slug,
        name: hit.title,
        author: hit.author,
        description: hit.description,
        downloads: hit.downloads,
        follows: hit.follows,
        clientside: hit.client_side === undefined ? "?" : hit.client_side === "required" ? "✓" : hit.clientside === "optional" ? "-" : "✗",
        serverside: hit.client_side === undefined ? "?" : hit.server_side === "required" ? "✓" : hit.serverside === "optional" ? "-" : "✗"
      })
    }
    table(info);
  });

program
  .command("status")
  .description("Show information")
  .action(() => {
    console.log(`Selected Profile: ${config.selected_profile ? config.selected_profile : chalk.red("None")}`);
    console.log(`Installed Mods: ${readdirSync(ROOT_DIR + "/mods").length}`);
    console.log(`Installed Libraries: ${readdirSync(ROOT_DIR + "/libs").length}`);
    console.log(`Created Profiles: ${readdirSync(ROOT_DIR + "/profiles").length}`);
    if(config.selected_profile == null) {
      return;
    }
    const profile = require(ROOT_DIR + "/profiles/" + config.selected_profile + ".json");
    console.log(`Selected Profile version: ${profile.version}`);
    console.log(`Selected Profile modloader: ${profile.loader}`);
    console.log(`Mod Count: ${profile.mods.length}`);
  });

program
  .command("switch [profile]")
  .description("Switch to a different profile")
  .action(async (profile) => {
    if(!profile) profile = null;

    if(!profile || existsSync(ROOT_DIR + "/profiles/" + profile + ".json")) {
      if(profile) spinner = ora("Switching to profile " + profile).start();
      else spinner = ora("Deselecting profile").start();
      config.selected_profile = profile;
      writeFileSync(__dirname + "/config.json", JSON.stringify(config, null, 2));
      spinner.succeed();
      updateModsDir();
      return;
    }

    console.error(`Profile '${profile}' does not exist. Did you mean to create it?`);
  });

program
  .command("create <profile> <version> <loader>")
  .description("Create a new profile")
  .addOption(new Option("-s, --switch", "Switch to the new profile after creation"))
  .action(async (profile, version, loader, { _switch }) => {
    if(!existsSync(ROOT_DIR + "/profiles/" + profile + ".json")) {
      spinner = ora("Creating profile " + profile).start();
      writeFileSync(ROOT_DIR + "/profiles/" + profile + ".json", JSON.stringify({version, loader, mods: [], libs: []}, null, 2));
      spinner.succeed();
      if(_switch) {
        spinner = ora("Switching to profile " + profile).start();
        config.selected_profile = profile;
        writeFileSync(__dirname + "/config.json", JSON.stringify(config, null, 2));
        spinner.succeed();
        updateModsDir();
      }
      return;
    }

    console.error(`Profile '${profile}' already exists. Did you mean to switch to it?`);
  });

program
  .command("delete <profile>")
  .description("Delete a profile")
  .action(async (profile) => {
    if(config.selected_profile === profile) {
      console.error(`Cannot delete the currently selected profile.`);
      return;
    }
    if(existsSync(ROOT_DIR + "/profiles/" + profile + ".json")) {
      spinner = ora("Deleting profile " + profile).start();
      unlinkSync(ROOT_DIR + "/profiles/" + profile + ".json");
      spinner.succeed();
      spinner = ora("Deselecting profile").start();
      config.selected_profile = null;
      writeFileSync(__dirname + "/config.json", JSON.stringify(config, null, 2));
      spinner.succeed();
      updateModsDir();
      return;
    }

    console.error(`Profile '${profile}' does not exist.`);
  });

program.parse();