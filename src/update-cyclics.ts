import { RushConfiguration, DependencyType } from "@rushstack/rush-sdk";
import { Async, Executable } from "@rushstack/node-core-library";
import { ChildProcess } from "child_process";

const runAsync = async (): Promise<void> => {
  const rushConfiguration: RushConfiguration =
    RushConfiguration.loadFromDefaultLocation({
      startingFolder: process.cwd(),
    });

  const cyclicDependencyNames: Set<string> = new Set<string>();

  for (const project of rushConfiguration.projects) {
    for (const cyclicDependencyProject of project.cyclicDependencyProjects) {
      cyclicDependencyNames.add(cyclicDependencyProject);
    }
  }

  const cyclicDependencyVersions: Map<string, string> = new Map<
    string,
    string
  >();
  await Async.forEachAsync(
    Array.from(cyclicDependencyNames),
    async (cyclicDependencyName) => {
      await new Promise<void>(
        (resolve: () => void, reject: (error: Error) => void) => {
          const childProcess: ChildProcess = Executable.spawn("npm", [
            "view",
            cyclicDependencyName,
            "version",
          ]);
          const stdoutBuffer: string[] = [];
          childProcess.stdout.on("data", (chunk) => stdoutBuffer.push(chunk));
          childProcess.on("exit", (code: number) => {
            if (code) {
              reject(new Error(`Exited with ${code}`));
            } else {
              const version: string = stdoutBuffer.join("").trim();
              console.log(
                `Found version "${version}" for "${cyclicDependencyName}"`
              );
              cyclicDependencyVersions.set(cyclicDependencyName, version);
              resolve();
            }
          });
        }
      );
    },
    { concurrency: 10 }
  );

  for (const project of rushConfiguration.projects) {
    for (const cyclicDependencyProject of project.cyclicDependencyProjects) {
      const version: string = cyclicDependencyVersions.get(
        cyclicDependencyProject
      )!;
      if (project.packageJsonEditor.tryGetDependency(cyclicDependencyProject)) {
        project.packageJsonEditor.addOrUpdateDependency(
          cyclicDependencyProject,
          version,
          DependencyType.Regular
        );
      }

      if (
        project.packageJsonEditor.tryGetDevDependency(cyclicDependencyProject)
      ) {
        project.packageJsonEditor.addOrUpdateDependency(
          cyclicDependencyProject,
          version,
          DependencyType.Dev
        );
      }
    }

    project.packageJsonEditor.saveIfModified();
  }
};

runAsync();
