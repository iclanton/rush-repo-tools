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

async function getPublishedPackageNamesAsync(): Promise<ReadonlySet<string>> {
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

  return publishedPackages;
}

interface IDependencyNamesResult {
  dependencyNames: ReadonlySet<string>;
  additionalPackageJsonByPath: ReadonlyMap<string, IPackageJson>;
}

async function collectDependencyNamesAsync(
  rushConfiguration: RushConfiguration,
): Promise<IDependencyNamesResult> {
  const publishedPackages: ReadonlySet<string> =
    await getPublishedPackageNamesAsync();

  const dependencyNames: Set<string> = new Set();

  // Always fetch the latest Rush version for updating rushVersion in rush.json
  dependencyNames.add("@microsoft/rush");

  function collectDeps(depSet: Record<string, string> | undefined): void {
    if (depSet) {
      for (const dep of Object.keys(depSet)) {
        if (publishedPackages.has(dep)) {
          dependencyNames.add(dep);
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

  return { dependencyNames, additionalPackageJsonByPath };
}

function applyVersionPrefix(oldVersion: string, newVersion: string): string {
  const match: RegExpMatchArray | null = oldVersion.match(/^([^\d]*)/);
  const prefix: string = match ? match[1] : "";
  return prefix + newVersion;
}

function updateDependencies(
  depSet: Record<string, string> | undefined,
  newVersions: ReadonlyMap<string, string>,
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

interface IFetchVersionsResult {
  newVersions: ReadonlyMap<string, string>;
  errors: ReadonlyArray<{ packageName: string; message: string }>;
}

async function fetchLatestVersionsAsync(
  dependencyNames: ReadonlySet<string>,
): Promise<IFetchVersionsResult> {
  console.log(
    `Fetching latest versions for ${dependencyNames.size} packages...`,
  );

  const errors: { packageName: string; message: string }[] = [];
  let completed: number = 0;

  const newVersions: Map<string, string> = new Map();
  await Async.forEachAsync(
    dependencyNames,
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
      if (completed % 10 === 0 || completed === dependencyNames.size) {
        console.log(`  Progress: ${completed}/${dependencyNames.size}`);
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

  const successCount: number = dependencyNames.size - errors.length;
  console.log(
    `Successfully resolved ${successCount}/${dependencyNames.size} packages. Updating project files...`,
  );

  return { newVersions, errors };
}

interface IUpdateProjectFilesOptions {
  rushConfiguration: RushConfiguration;
  additionalPackageJsonByPath: ReadonlyMap<string, IPackageJson>;
  newVersions: ReadonlyMap<string, string>;
}

async function updateProjectFilesAsync(
  options: IUpdateProjectFilesOptions,
): Promise<number> {
  const { rushConfiguration, additionalPackageJsonByPath, newVersions } = options;
  let updatedProjectCount: number = 0;

  await Async.forEachAsync(
    rushConfiguration.projects,
    async ({ projectFolder, packageJson }) => {
      const { dependencies, devDependencies } = packageJson;
      let updated: boolean = false;
      updated = updateDependencies(dependencies, newVersions) || updated;
      updated = updateDependencies(devDependencies, newVersions) || updated;

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
      updated =
        updateDependencies(packageJson.dependencies, newVersions) || updated;
      updated =
        updateDependencies(packageJson.devDependencies, newVersions) || updated;

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

  return updatedProjectCount;
}

interface IUpdateRushVersionOptions {
  rushConfiguration: RushConfiguration;
  newVersions: ReadonlyMap<string, string>;
}

async function updateRushVersionAsync(
  options: IUpdateRushVersionOptions,
): Promise<void> {
  const { rushConfiguration, newVersions } = options;
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
}

function updatePreferredVersions(
  rushConfiguration: RushConfiguration,
  newVersions: ReadonlyMap<string, string>,
): void {
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
}

async function runAsync(): Promise<void> {
  const rushConfiguration: RushConfiguration =
    RushConfiguration.loadFromDefaultLocation();

  const { dependencyNames, additionalPackageJsonByPath } =
    await collectDependencyNamesAsync(rushConfiguration);

  const { newVersions, errors } =
    await fetchLatestVersionsAsync(dependencyNames);

  const updatedProjectCount: number = await updateProjectFilesAsync({
    rushConfiguration,
    additionalPackageJsonByPath,
    newVersions,
  });

  await updateRushVersionAsync({ rushConfiguration, newVersions });
  updatePreferredVersions(rushConfiguration, newVersions);

  console.log(`\nDone. Updated ${updatedProjectCount} project(s).`);

  if (errors.length > 0) {
    process.exitCode = 1;
  }
}

runAsync().catch((error: Error) => {
  console.error(`\nFatal error: ${error.message}`);
  process.exitCode = 1;
});
