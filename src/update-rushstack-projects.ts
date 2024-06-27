import { Async, Executable, JsonFile } from "@rushstack/node-core-library";
import { RushConfiguration } from "@rushstack/rush-sdk";
import { ChildProcess } from "child_process";

async function runAsync(): Promise<void> {
  const rushConfiguration: RushConfiguration =
    RushConfiguration.loadFromDefaultLocation();

  const newVersions: Map<string, string> = new Map();

  function addDependencies(depSet: Record<string, string> | undefined): void {
    if (depSet) {
      for (const dep of Object.keys(depSet)) {
        if (dep.startsWith("@rushstack/") || dep.startsWith("@microsoft/")) {
          newVersions.set(dep, "");
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

  await Async.forEachAsync(
    newVersions.keys(),
    async (cyclicDependencyName) => {
      await new Promise<void>(
        (resolve: () => void, reject: (error: Error) => void) => {
          const childProcess: ChildProcess = Executable.spawn("npm", [
            "view",
            cyclicDependencyName,
            "version",
          ]);
          const stdoutBuffer: string[] = [];
          childProcess.stdout!.on("data", (chunk) => stdoutBuffer.push(chunk));
          childProcess.on("exit", (code: number) => {
            if (code) {
              reject(
                new Error(
                  `Checking for update for ${cyclicDependencyName} with ${code}`
                )
              );
            } else {
              const version: string = stdoutBuffer.join("").trim();
              console.log(
                `Found version "${version}" for "${cyclicDependencyName}"`
              );
              newVersions.set(cyclicDependencyName, version);
              resolve();
            }
          });
        }
      );
    },
    { concurrency: 10 }
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
}

runAsync();
