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

  const packageNames: string[] = [...newVersions.keys()];
  console.log(`Fetching latest versions for ${packageNames.length} packages...`);

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
              stdoutBuffer.push(chunk)
            );
            childProcess.stderr!.on("data", (chunk) =>
              stderrBuffer.push(chunk)
            );
            childProcess.on("exit", (code: number) => {
              if (code) {
                const stderr: string = stderrBuffer.join("").trim();
                reject(
                  new Error(
                    `"npm view ${packageName} version" exited with code ${code}${stderr ? `:\n  ${stderr}` : ""}`
                  )
                );
              } else {
                const version: string = stdoutBuffer.join("").trim();
                newVersions.set(packageName, version);
                resolve();
              }
            });
          }
        );
      } catch (e) {
        errors.push({ packageName, message: (e as Error).message });
      }

      completed++;
      if (completed % 10 === 0 || completed === packageNames.length) {
        console.log(`  Progress: ${completed}/${packageNames.length}`);
      }
    },
    { concurrency: 10 }
  );

  if (errors.length > 0) {
    console.error(`\nFailed to fetch versions for ${errors.length} package(s):`);
    for (const { packageName, message } of errors) {
      console.error(`  ${packageName}: ${message}`);
    }
    console.log();
  }

  const successCount: number = packageNames.length - errors.length;
  console.log(
    `Successfully resolved ${successCount}/${packageNames.length} packages. Updating project files...`
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
    { concurrency: 50 }
  );

  console.log(`\nDone. Updated ${updatedProjectCount} project(s).`);

  if (errors.length > 0) {
    process.exitCode = 1;
  }
}

runAsync().catch((error: Error) => {
  console.error(`\nFatal error: ${error.message}`);
  process.exitCode = 1;
});
