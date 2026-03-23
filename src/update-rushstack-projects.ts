import { Async, Executable, JsonFile } from "@rushstack/node-core-library";
import { CommonVersionsConfiguration, RushConfiguration } from "@rushstack/rush-sdk";
import type { IRushConfigurationJson } from "@rushstack/rush-sdk/lib/api/RushConfiguration";
import { ChildProcess } from "child_process";

const RUSHSTACK_RUSH_JSON_URL: string =
  "https://raw.githubusercontent.com/microsoft/rushstack/main/rush.json";

async function runAsync(): Promise<void> {
  const rushConfiguration: RushConfiguration =
    RushConfiguration.loadFromDefaultLocation();

  console.log("Fetching rush.json from microsoft/rushstack...");
  const response: Response = await fetch(RUSHSTACK_RUSH_JSON_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch rush.json: ${response.status} ${response.statusText}`,
    );
  }
  const rushJsonText: string = await response.text();
  const rushJson: IRushConfigurationJson = JsonFile.parseString(rushJsonText);

  const publishedPackages: Set<string> = new Set();
  for (const {
    packageName,
    shouldPublish,
    versionPolicyName,
  } of rushJson.projects) {
    if (shouldPublish || versionPolicyName) {
      publishedPackages.add(packageName);
    }
  }
  console.log(
    `Found ${publishedPackages.size} published packages in rushstack repo.`,
  );

  const newVersions: Map<string, string> = new Map();

  for (const {
    packageJson: { dependencies, devDependencies },
  } of rushConfiguration.projects) {
    for (const depSet of [dependencies, devDependencies]) {
      if (depSet) {
        for (const dep of Object.keys(depSet)) {
          if (publishedPackages.has(dep)) {
            newVersions.set(dep, "");
          }
        }
      }
    }
  }

  const packageNames: string[] = [...newVersions.keys()];
  console.log(
    `Fetching latest versions for ${packageNames.length} packages...`,
  );

  const errors: { packageName: string; message: string }[] = [];
  let completed: number = 0;

  await Async.forEachAsync(
    packageNames,
    async (packageName) => {
      try {
        await new Promise<void>(
          (resolve: () => void, reject: (error: Error) => void) => {
            const childProcess: ChildProcess = Executable.spawn("npm", [
              "view",
              packageName,
              "version",
            ]);
            const stdoutBuffer: string[] = [];
            const stderrBuffer: string[] = [];
            childProcess.stdout!.on("data", (chunk) =>
              stdoutBuffer.push(chunk),
            );
            childProcess.stderr!.on("data", (chunk) =>
              stderrBuffer.push(chunk),
            );
            childProcess.on("exit", (code: number) => {
              if (code) {
                const stderr: string = stderrBuffer.join("").trim();
                reject(
                  new Error(
                    `"npm view ${packageName} version" exited with code ${code}${stderr ? `:\n  ${stderr}` : ""}`,
                  ),
                );
              } else {
                const version: string = stdoutBuffer.join("").trim();
                newVersions.set(packageName, version);
                resolve();
              }
            });
          },
        );
      } catch (e) {
        errors.push({ packageName, message: (e as Error).message });
      }

      completed++;
      if (completed % 10 === 0 || completed === packageNames.length) {
        console.log(`  Progress: ${completed}/${packageNames.length}`);
      }
    },
    { concurrency: 10 },
  );

  if (errors.length > 0) {
    console.error(
      `\nFailed to fetch versions for ${errors.length} package(s):`,
    );
    for (const { packageName, message } of errors) {
      console.error(`  ${packageName}: ${message}`);
    }
    console.log();
  }

  const successCount: number = packageNames.length - errors.length;
  console.log(
    `Successfully resolved ${successCount}/${packageNames.length} packages. Updating project files...`,
  );

  function getVersionPrefix(version: string): string {
    const match: RegExpMatchArray | null = version.match(/^([^\d]*)/);
    return match ? match[1] : "";
  }

  function updateDependencies(
    depSet: Record<string, string> | undefined,
  ): boolean {
    let changed: boolean = false;
    if (depSet) {
      for (const [dep, oldVersion] of Object.entries(depSet)) {
        const newVersion: string | undefined = newVersions.get(dep);
        if (newVersion) {
          const prefix: string = getVersionPrefix(oldVersion);
          const newVersionWithPrefix: string = prefix + newVersion;
          if (newVersionWithPrefix !== oldVersion) {
            depSet[dep] = newVersionWithPrefix;
            changed = true;
          }
        }
      }
    }

    return changed;
  }

  let updatedProjectCount: number = 0;

  await Async.forEachAsync(
    rushConfiguration.projects,
    async ({ projectFolder, packageJson }) => {
      const { dependencies, devDependencies } = packageJson;
      let updated: boolean = false;
      updated = updateDependencies(dependencies) || updated;
      updated = updateDependencies(devDependencies) || updated;

      if (updated) {
        updatedProjectCount++;
        console.log(`  Updating ${projectFolder}`);

        await JsonFile.saveAsync(packageJson, `${projectFolder}/package.json`, {
          updateExistingFile: true,
        });
      }
    },
    { concurrency: 50 },
  );

  const localRushJson: IRushConfigurationJson = JsonFile.load(
    rushConfiguration.rushJsonFile,
  ) as IRushConfigurationJson;
  const oldRushVersion: string = localRushJson.rushVersion;
  const newRushVersion: string = rushJson.rushVersion;
  if (oldRushVersion !== newRushVersion) {
    console.log(
      `Updating rushVersion in rush.json: ${oldRushVersion} -> ${newRushVersion}`,
    );
    localRushJson.rushVersion = newRushVersion;
    await JsonFile.saveAsync(localRushJson, rushConfiguration.rushJsonFile, {
      updateExistingFile: true,
    });
  } else {
    console.log(`rushVersion is already up to date (${oldRushVersion}).`);
  }

  const commonVersions: CommonVersionsConfiguration =
    rushConfiguration.defaultSubspace.getCommonVersions();
  let commonVersionsUpdated: boolean = false;
  for (const [packageName, version] of newVersions.entries()) {
    if (version) {
      const oldPreferredVersion: string | undefined = commonVersions.preferredVersions.get(packageName);
      if (oldPreferredVersion !== undefined) {
        const prefix: string = getVersionPrefix(oldPreferredVersion);
        const newVersionWithPrefix: string = prefix + version;
        if (oldPreferredVersion !== newVersionWithPrefix) {
          commonVersions.preferredVersions.set(packageName, newVersionWithPrefix);
          commonVersionsUpdated = true;
        }
      }
    }
  }
  if (commonVersionsUpdated) {
    commonVersions.save();
    console.log(`Updated preferred versions in ${commonVersions.filePath}`);
  } else {
    console.log("common-versions.json preferred versions are already up to date.");
  }

  console.log(`\nDone. Updated ${updatedProjectCount} project(s).`);

  if (errors.length > 0) {
    process.exitCode = 1;
  }
}

runAsync().catch((error: Error) => {
  console.error(`\nFatal error: ${error.message}`);
  process.exitCode = 1;
});
