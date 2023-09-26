import { RushConfiguration, PackageJsonDependency } from "@rushstack/rush-sdk";

const rushConfiguration: RushConfiguration =
  RushConfiguration.loadFromDefaultLocation({
    startingFolder: process.cwd(),
  });

for (const project of rushConfiguration.projects) {
  function updateDeps(dependencies: readonly PackageJsonDependency[]): void {
    for (const dependency of dependencies) {
      if (
        rushConfiguration.projectsByName.has(dependency.name) &&
        !project.cyclicDependencyProjects.has(dependency.name)
      ) {
        project.packageJsonEditor.addOrUpdateDependency(
          dependency.name,
          rushConfiguration.projectsByName.get(dependency.name)!.packageJson
            .version,
          dependency.dependencyType
        );
      }
    }
  }

  updateDeps(project.packageJsonEditor.dependencyList);
  updateDeps(project.packageJsonEditor.devDependencyList);

  project.packageJsonEditor.saveIfModified();
}
