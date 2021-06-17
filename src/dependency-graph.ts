import { RushConfiguration } from "@microsoft/rush-lib";
import { IPackageJsonDependencyTable } from "@rushstack/node-core-library";

const rushConfiguration: RushConfiguration =
  RushConfiguration.loadFromDefaultLocation({
    startingFolder: process.cwd(),
  });

interface IDependencyGraphEntry {
  dependencies: string[];
  dependents: string[];
}

const dependencyGraph: { [projectName: string]: IDependencyGraphEntry } = {};

function ensureAndGetDependencyGraphEntry(
  projectName: string
): IDependencyGraphEntry {
  if (!dependencyGraph[projectName]) {
    dependencyGraph[projectName] = { dependencies: [], dependents: [] };
  }

  return dependencyGraph[projectName];
}

for (const project of rushConfiguration.projects) {
  const thisProjectEntry: IDependencyGraphEntry =
    ensureAndGetDependencyGraphEntry(project.packageName);

  function addDependencies(
    dependencies: IPackageJsonDependencyTable | undefined
  ): void {
    for (const dependencyName in dependencies) {
      if (
        rushConfiguration.projectsByName.has(dependencyName) &&
        !project.cyclicDependencyProjects.has(dependencyName)
      ) {
        thisProjectEntry.dependencies.push(dependencyName);

        const dependencyEntry: IDependencyGraphEntry =
          ensureAndGetDependencyGraphEntry(dependencyName);
        dependencyEntry.dependents.push(project.packageName);
      }
    }
  }

  addDependencies(project.packageJson.dependencies);
  addDependencies(project.packageJson.devDependencies);
}

console.log(JSON.stringify(dependencyGraph, undefined, 2));
