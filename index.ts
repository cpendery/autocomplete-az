#!/usr/bin/env node

import fsAsync from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import axios from "axios";
import * as cheerio from "cheerio";
import ProgressBar from "progress";
import pLimit from "p-limit";

const versionRegex = /[0-9]+\.[0-9]+\.[0-9]+/g;
const baseUrl =
  "https://learn.microsoft.com/en-us/cli/azure/reference-index?view=azure-cli-latest";

type BaseCommand = {
  name: string;
  description: string;
  link: string | undefined | null;
};

/* general utility functions */

const removeTrailingDot = (content: string): string =>
  content.endsWith(".") ? content.slice(0, -1) : content;
const figifyList = <T>(list: T[]): T[] | T => {
  switch (list.length) {
    case 1:
      return list[0];
    default:
      return list;
  }
};
const figifyEmptyList = <T>(list: T[]): T[] | T | undefined =>
  list.length === 0 ? undefined : figifyList(list);

/* Loading the base commands / extension */
const cleanCommandName = (command: string) => {
  return command.replace(/\(.*\)/g, "").trim();
};

const getOption = (
  name: string,
  description: string,
  isPersistent: boolean,
  isRequired: boolean
): Fig.Option => {
  const names = name.split(" ").map((n) => n.trim());
  const argName = names
    .sort((a, b) => b.length - a.length)[0]
    .replace(/^-+/, "");
  const has_no_arg =
    description.toLowerCase().includes("default value: false") ||
    (isPersistent &&
      (names.includes("--debug") ||
        names.includes("--verbose") ||
        names.includes("--help") ||
        names.includes("--only-show-errors"))) ||
    names.includes("--yes");

  const matches = description.match(/accepted values:([^\n]+)/);
  const suggestions = matches
    ? matches[1].split(",").map((s) => s.trim())
    : undefined;
  const args: Fig.Arg | undefined = has_no_arg
    ? undefined
    : { name: argName, suggestions };

  const cleanedDescription = description
    .replace(/default value:([^\n]+)/, "")
    .replace(/accepted values:[^\n]+/, "")
    .replaceAll(/\s+/g, " ")
    .trim();

  return {
    name: figifyList(names),
    description: removeTrailingDot(cleanedDescription),
    args,
    isPersistent: isPersistent ? true : undefined,
    isRequired: isRequired ? true : undefined,
  };
};

const genBaseSubcommands = async () => {
  const resp = await axios.get(baseUrl);
  if (resp.status !== 200) throw new Error("Failed to fetch subcommands");
  const $ = cheerio.load(resp.data);
  const baseCommands = $("table tbody tr")
    .map((_, elem) => {
      const name = cleanCommandName(
        $(elem).find("td:nth-child(1)").text()
      ).split(" ")[1];
      const description = $(elem).find("td:nth-child(2)").text().trim();
      const link = $(elem).find("td:nth-child(1) a").attr("href");
      let url = null;
      if (link != null) {
        url = new URL(link, "https://learn.microsoft.com/en-us/cli/azure/");
        url.hash = "";
      }
      if (url != null && url.toString() == baseUrl) {
        url = null;
      }
      return {
        name,
        description: removeTrailingDot(description),
        link: url != null ? url.toString() : null,
      };
    })
    .toArray();

  // avoid duplicates, a bit funky for `ml` since it has a v1 & v2 extension, we will just go with v1
  return [...new Map(baseCommands.map((b) => [b.name, b])).values()];
};

const genGlobalOptions = async (): Promise<Fig.Option[]> => {
  const resp = await axios.get(
    "https://learn.microsoft.com/en-us/cli/azure/reference-index?view=azure-cli-latest"
  );
  if (resp.status !== 200) throw new Error("Failed to global parameters");
  const $ = cheerio.load(resp.data);
  const details = $("details")
    .filter((_, elem) => $(elem).text().trim().toLowerCase().includes("global"))
    .first();

  const names = details
    .find(".parameterName")
    .map((_, elem) => $(elem).text().trim())
    .toArray();
  const descriptions = details
    .find(".parameterInfo")
    .map((_, elem) => $(elem).text().trim())
    .toArray();

  return names.map((name, i) => getOption(name, descriptions[i], true, false));
};

const writeBaseCommands = async (command: Fig.Subcommand, version: string) => {
  const content = `const completion: Fig.Spec = ${JSON.stringify(command)}
  
  const versions: Fig.VersionDiffMap = {"${version}": {}};

  export { versions };
  export default completion;`;

  if (!fs.existsSync(path.join("src", "az"))) {
    await fsAsync.mkdir(path.join("src", "az"));
  }
  await fsAsync.writeFile(path.join("src", "az", `${version}.ts`), content);
};

/* Infer the latest version */

const genCurrentVersion = async (): Promise<string> => {
  const resp = await axios.get(
    "https://github.com/Azure/azure-cli/releases/latest"
  );
  if (resp.status !== 200)
    throw new Error("Failed to infer the latest version");
  const $ = cheerio.load(resp.data);
  const releaseTitle = $("title").text();
  const version = releaseTitle.match(versionRegex)?.at(0);
  if (!version) throw new Error("Failed to infer the latest version");
  return version;
};

/* Load each individual subcommand in full depth */

const loadSubcommandGroupUrls = async (url: string, commandName: string) => {
  const resp = await axios.get(url);
  if (resp.status !== 200)
    throw new Error(`Failed to fetch subcommand group ${commandName}`);
  const $ = cheerio.load(resp.data);
  const pages = $("table tbody tr")
    .map((_, elem) => {
      const link = $(elem).find("td:nth-child(1) a").attr("href");
      if (link != null) {
        const url = new URL(
          link ?? "",
          "https://learn.microsoft.com/en-us/cli/azure/"
        );
        url.hash = "";
        return url.toString();
      }
      return null;
    })
    .filter((_, elem) => elem != null)
    .toArray();
  return [...new Set(pages)];
};

// this loads both options and arguments for the given subcommand
const loadSubcommandComponents = (
  commandId: string,
  $: cheerio.CheerioAPI,
  type: "required" | "optional"
) => {
  const postfix =
    type === "required" ? "-required-parameters" : "-optional-parameters";
  const hasComponents = $(`[id=${commandId}${postfix}]`).length !== 0;
  if (!hasComponents) return [];
  let lastComponent = $(`[id=${commandId}${postfix}]`);
  let components = [];
  while (true) {
    const componentNameElement = $(lastComponent)
      .next()
      .find(".parameterName")
      .first();
    const componentName = componentNameElement.text().trim();
    if (!componentName) {
      break;
    }
    const componentDescriptionElement = $(lastComponent)
      .nextAll(".parameterInfo")
      .first();
    const componentDescription = componentDescriptionElement.text().trim();

    const isGlobalComponent =
      $(componentNameElement).closest("details").length !== 0;
    const isComponentOfCurrentCommand =
      $(componentDescriptionElement).prevAll(`[id=${commandId}${postfix}]`)
        .length !== 0;
    const isPostfixComponent = $(componentDescriptionElement)
      .prevAll(`h3`)
      .first()
      .is(`h3[id=${commandId}${postfix}]`);

    if (
      !componentDescription ||
      isGlobalComponent ||
      !isComponentOfCurrentCommand ||
      !isPostfixComponent
    ) {
      break;
    }

    components.push({
      name: componentName,
      description: removeTrailingDot(componentDescription),
      isRequired: type === "required",
    });
    lastComponent = componentDescriptionElement;
  }
  return components;
};

const parseSubcommand = (
  $: cheerio.CheerioAPI,
  command: cheerio.Element,
  baseCommand = false
): Fig.Subcommand => {
  const commandSections = cleanCommandName($(command).text())
    .split(" ")
    .slice(baseCommand ? 1 : 2);
  const name = commandSections[commandSections.length - 1];
  const description = $(command).closest("div").nextAll("p").first().text();
  const requiredComponents = loadSubcommandComponents(
    command.attribs.id,
    $,
    "required"
  );
  const optionalComponents = loadSubcommandComponents(
    command.attribs.id,
    $,
    "optional"
  );
  const options = [...requiredComponents, ...optionalComponents]
    .filter((c) => c.name.trim().startsWith("-"))
    .map((c) => getOption(c.name, c.description, false, c.isRequired));
  const args = figifyEmptyList(
    [...requiredComponents, ...optionalComponents]
      .filter((c) => c.name.trim().startsWith("<"))
      .map(
        (c) =>
          ({
            name: c.name.trim(),
            description: removeTrailingDot(c.description.trim()),
            isOptional: !c.isRequired ? true : undefined,
          } as Fig.Arg)
      )
  );
  return {
    name,
    description: removeTrailingDot(description),
    options: options ? options : undefined,
    args,
  };
};

const requestLimit = pLimit(2);
const loadSubcommand = async (
  baseCommand: BaseCommand,
  bar: ProgressBar
): Promise<Fig.Subcommand> => {
  if (baseCommand.link == null) {
    const resp = await axios.get(baseUrl);
    if (resp.status !== 200)
      throw new Error(`Failed to fetch subcommand ${baseCommand.name}`);
    const $ = cheerio.load(resp.data);
    const command = $(`h2[id="az-${baseCommand.name}"]`).toArray()[0];
    bar.tick();
    return parseSubcommand($, command, true);
  }
  const groupUrls = await loadSubcommandGroupUrls(
    baseCommand.link,
    baseCommand.name
  );
  const subcommand: Fig.Subcommand = {
    name: baseCommand.name,
    description: removeTrailingDot(baseCommand.description),
    subcommands: [],
  };
  await Promise.all(
    groupUrls.map(async (url) =>
      requestLimit(async () => {
        const resp = await axios.get(url);
        if (resp.status !== 200)
          throw new Error(`Failed to fetch subcommand ${baseCommand.name}`);
        const $ = cheerio.load(resp.data);
        const commands = $('h2[id^="az-"]').toArray();
        const subcommandGroupName = cleanCommandName($("h1").first().text());
        const subcommandGroupNameSections = subcommandGroupName
          .split(" ")
          .slice(2);
        const subcommandGroupDescription = $(".summary").text().trim();

        // TODO: not properly nesting subcommands ex. `az webapp auth apple`
        let currentSubcommand = subcommand;
        subcommandGroupNameSections.forEach((section) => {
          const existingSubcommand = currentSubcommand.subcommands?.find(
            (subcommand) => subcommand.name === section
          );
          if (existingSubcommand != null) {
            currentSubcommand = existingSubcommand;
          } else {
            const newSubcommand: Fig.Subcommand = { name: section };
            currentSubcommand.subcommands?.push(newSubcommand);
            currentSubcommand = newSubcommand;
          }
        });
        currentSubcommand.description = removeTrailingDot(
          subcommandGroupDescription
        );

        // TODO: duplicates appearing from extension methods `az webapp create vs. az webapp create (extension ...)
        commands.forEach((command) => {
          currentSubcommand.subcommands =
            currentSubcommand.subcommands != null
              ? [...currentSubcommand.subcommands, parseSubcommand($, command)]
              : undefined;
        });
      })
    )
  );
  bar.tick();
  return subcommand;
};

const writeSubcommand = async (command: Fig.Subcommand, version: string) => {
  const content = `const completion: Fig.Spec = ${JSON.stringify(command)}
  
  export default completion;`;
  await fsAsync.writeFile(
    path.join("src", "az", version, `${command.name}.ts`),
    content
  );
};

const main = async () => {
  if (!fs.existsSync("src")) {
    console.error("Please run this script from the root of the repository");
    process.exit(1);
  }
  const version = await genCurrentVersion();
  if (fs.existsSync(path.join("src", "az", `${version}.ts`))) {
    console.log("Already up to date");
    process.exit(0);
  }
  const baseCommands = await genBaseSubcommands();
  const globalOptions = await genGlobalOptions();
  const bar = new ProgressBar(
    "[:bar] :current/:total :rate/sps :etas :elapseds",
    { total: baseCommands.length, width: 30 }
  );
  const azCommand: Fig.Subcommand = {
    name: "az",
    subcommands: baseCommands.map((command) => ({
      name: command.name,
      description: removeTrailingDot(command.description),
      loadSpec: `az/${version}/${command.name}`,
    })),
    options: globalOptions,
  };
  await writeBaseCommands(azCommand, version);

  const subcommandLimit = pLimit(1);
  const subcommandSpecs = await Promise.all(
    baseCommands.map(async (command) =>
      subcommandLimit(() => loadSubcommand(command, bar))
    )
  );
  if (!fs.existsSync(path.join("src", "az", version))) {
    await fsAsync.mkdir(path.join("src", "az", version));
  }
  await Promise.all(
    subcommandSpecs.map((spec) => writeSubcommand(spec, version))
  );
  console.log(
    `Don't forget to add the new version to ${path.join(
      process.cwd(),
      "src",
      "az",
      "index.ts"
    )}`
  );
};

main();
