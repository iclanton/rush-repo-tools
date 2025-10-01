import { ChildProcess } from "node:child_process";

import { Async, Executable, JsonFile } from "@rushstack/node-core-library";
import { RushConfiguration } from "@rushstack/rush-sdk";
import type { IRushConfigurationJson } from "@rushstack/rush-sdk/lib/api/RushConfiguration";

async function runAsync(): Promise<void> {
  const rushConfiguration: RushConfiguration =
    RushConfiguration.loadFromDefaultLocation();

  const rushstackDependencies: Set<string> = new Set(["@microsoft/rush"]);

  function addDependencies(depSet: Record<string, string> | undefined): void {
    if (depSet) {
      for (const dep of Object.keys(depSet)) {
        if (dep.startsWith("@rushstack/") || dep.startsWith("@microsoft/")) {
          rushstackDependencies.add(dep);
        }
      }
    }
  }

  for (const {
    packageJson: { dependencies, devDependencies },
  } of rushConfiguration.projects) {
    addDependencies(dependencies);
    addDependencies(devDependencies);
  }

  const newVersions: Map<string, string> = new Map(
    await Async.mapAsync(
      rushstackDependencies.keys(),
      async (dependencyName) => {
        const childProcess: ChildProcess = Executable.spawn("npm", [
          "view",
          dependencyName,
          "version",
        ]);
        const { stdout, stderr } = await Executable.waitForExitAsync(
          childProcess,
          {
            encoding: "utf8",
            throwOnNonZeroExitCode: true,
            throwOnSignal: true,
          }
        );
        if (stderr) {
          throw new Error(
            `Getting version for ${dependencyName} printed to stderr: ${stderr}`
          );
        }
        const version: string = stdout.trim();
        console.log(`Found version "${version}" for "${dependencyName}"`);
        return [dependencyName, version];
      },
      { concurrency: 10 }
    )
  );

  function updateDependencies(
    depSet: Record<string, string> | undefined
  ): boolean {
    let changed: boolean = false;
    if (depSet) {
      for (const [dep, oldVersion] of Object.entries(depSet)) {
        const newVersion = newVersions.get(dep);
        if (newVersion && newVersion !== oldVersion) {
          depSet[dep] = newVersion;
          changed = true;
        }
      }
    }

    return changed;
  }

  await Async.forEachAsync(
    rushConfiguration.projects,
    async ({ projectFolder, packageJson }) => {
      const { dependencies, devDependencies } = packageJson;
      let updated: boolean = false;
      updated = updateDependencies(dependencies) || updated;
      updated = updateDependencies(devDependencies) || updated;

      if (updated) {
        console.log(`Updating ${projectFolder}`);

        JsonFile.saveAsync(packageJson, `${projectFolder}/package.json`, {
          updateExistingFile: true,
        });
      }
    },
    { concurrency: 50 }
  );

  const rushJson: IRushConfigurationJson = await JsonFile.loadAsync(
    rushConfiguration.rushJsonFile
  );
  const newRushVersion: string | undefined = newVersions.get("@microsoft/rush");
  if (newRushVersion && rushJson.rushVersion !== newRushVersion) {
    console.log(
      `Updating rushVersion in rush.json from ${rushJson.rushVersion} to ${newRushVersion}`
    );
    rushJson.rushVersion = newRushVersion;
    await JsonFile.saveAsync(rushJson, rushConfiguration.rushJsonFile, {
      updateExistingFile: true,
    });
  }
}

runAsync();
