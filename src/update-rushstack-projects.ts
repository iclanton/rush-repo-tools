import {
  Async,
  Executable,
  FileSystem,
  FolderItem,
  IPackageJson,
  JsonFile,
} from "@rushstack/node-core-library";
import {
  CommonVersionsConfiguration,
  RushConfiguration,
} from "@rushstack/rush-sdk";
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
  // Always fetch the latest Rush version for updating rushVersion in rush.json
  newVersions.set("@microsoft/rush", "");

  function collectDeps(depSet: Record<string, string> | undefined): void {
    if (depSet) {
      for (const dep of Object.keys(depSet)) {
        if (publishedPackages.has(dep)) {
          newVersions.set(dep, "");
        }
      }
    }
  }

  for (const {
    packageJson: { dependencies, devDependencies },
  } of rushConfiguration.projects) {
    collectDeps(dependencies);
    collectDeps(devDependencies);
  }

  const additionalPackageJsonByPath: Map<string, IPackageJson> = new Map();

  // Scan autoinstaller package.json files
  const autoinstallersFolder: string =
    rushConfiguration.commonAutoinstallersFolder;
  let autoinstallerEntries: FolderItem[] = [];
  try {
    autoinstallerEntries =
      await FileSystem.readFolderItemsAsync(autoinstallersFolder);
  } catch (error) {
    if (!FileSystem.isNotExistError(error)) {
      throw error;
    }
  }

  await Async.forEachAsync(
    autoinstallerEntries,
    async (entry) => {
      if (!entry.isDirectory()) {
        return;
      }

      const packageJsonPath: string = `${autoinstallersFolder}/${entry.name}/package.json`;
      try {
        const packageJson: IPackageJson =
          await JsonFile.loadAsync(packageJsonPath);
        additionalPackageJsonByPath.set(packageJsonPath, packageJson);
        collectDeps(packageJson.dependencies);
        collectDeps(packageJson.devDependencies);
      } catch (error) {
        if (!FileSystem.isNotExistError(error)) {
          throw error;
        }
      }
    },
    { concurrency: 50 },
  );

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
      } catch (error) {
        errors.push({ packageName, message: error.message });
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

  function applyVersionPrefix(oldVersion: string, newVersion: string): string {
    const match: RegExpMatchArray | null = oldVersion.match(/^([^\d]*)/);
    const prefix: string = match ? match[1] : "";
    return prefix + newVersion;
  }

  function updateDependencies(
    depSet: Record<string, string> | undefined,
  ): boolean {
    let changed: boolean = false;
    if (depSet) {
      for (const [dep, oldVersion] of Object.entries(depSet)) {
        const newVersion: string | undefined = newVersions.get(dep);
        if (newVersion) {
          const newVersionWithPrefix: string = applyVersionPrefix(
            oldVersion,
            newVersion,
          );
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

  // Update autoinstaller package.json files
  await Async.forEachAsync(
    additionalPackageJsonByPath,
    async ([packageJsonPath, packageJson]) => {
      let updated: boolean = false;
      updated = updateDependencies(packageJson.dependencies) || updated;
      updated = updateDependencies(packageJson.devDependencies) || updated;

      if (updated) {
        updatedProjectCount++;
        console.log(`  Updating ${packageJsonPath}`);
        await JsonFile.saveAsync(packageJson, packageJsonPath, {
          updateExistingFile: true,
        });
      }
    },
    { concurrency: 50 },
  );

  const localRushJson: IRushConfigurationJson = await JsonFile.loadAsync(
    rushConfiguration.rushJsonFile,
  );
  const oldRushVersion: string = localRushJson.rushVersion;
  const newRushVersion: string | undefined = newVersions.get("@microsoft/rush");
  if (newRushVersion && oldRushVersion !== newRushVersion) {
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
  for (const [packageName, version] of newVersions) {
    if (version) {
      const oldPreferredVersion: string | undefined =
        commonVersions.preferredVersions.get(packageName);
      if (oldPreferredVersion !== undefined) {
        const newVersionWithPrefix: string = applyVersionPrefix(
          oldPreferredVersion,
          version,
        );
        if (oldPreferredVersion !== newVersionWithPrefix) {
          commonVersions.preferredVersions.set(
            packageName,
            newVersionWithPrefix,
          );
          commonVersionsUpdated = true;
        }
      }
    }
  }
  if (commonVersionsUpdated) {
    commonVersions.save();
    console.log(`Updated preferred versions in ${commonVersions.filePath}`);
  } else {
    console.log(
      "common-versions.json preferred versions are already up to date.",
    );
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
