import { RushConfiguration } from '@microsoft/rush-lib';
import {
  FileSystem,
  JsonFile,
  IPackageJson
} from '@rushstack/node-core-library';
import * as path from 'path';
import * as glob from 'glob';

const rushConfiguration: RushConfiguration = RushConfiguration.loadFromDefaultLocation({
  startingFolder: process.cwd()
});

const ALLOWED_DEPS: Set<string> = new Set<string>([
  'tslib'
]);

function getDependencyReferencesForProject(projectPath: string): Set<string> {
  const requireMatches: Set<string> = new Set<string>();

  for (const filename of glob.sync('{./*.{ts,js,tsx,jsx},./{src,lib}/**/*.{ts,js,tsx,jsx},*.js}', { cwd: projectPath })) {
    try {
      const contents: string = FileSystem.readFile(path.resolve(projectPath, filename));
      const lines: string[] = contents.split('\n');

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        const requireRegExps: RegExp[] = [
          // Example: require('something')
          /\brequire\s*\(\s*[']([^']+\s*)[']\)/g,
          /\brequire\s*\(\s*["]([^"]+)["]\s*\)/g,

          // Example: import('something')
          /\bimport\s*\(\s*[']([^']+\s*)[']\)/g,
          /\bimport\s*\(\s*["]([^"]+)["]\s*\)/g,

          // Example: require.ensure('something')
          /\brequire.ensure\s*\(\s*[']([^']+\s*)[']\)/g,
          /\brequire.ensure\s*\(\s*["]([^"]+)["]\s*\)/g,

          // Example: require.resolve('something')
          /\brequire.resolve\s*\(\s*[']([^']+\s*)[']\)/g,
          /\brequire.resolve\s*\(\s*["]([^"]+)["]\s*\)/g,

          // Example: System.import('something')
          /\bSystem.import\s*\(\s*[']([^']+\s*)[']\)/g,
          /\bSystem.import\s*\(\s*["]([^"]+)["]\s*\)/g,

          // Example:
          //
          // import {
          //   A, B
          // } from 'something';
          /\bfrom\s*[']([^']+)[']/g,
          /\bfrom\s*["]([^"]+)["]/g,

          // Example:  import 'something';
          /\bimport\s*[']([^']+)[']\s*\;/g,
          /\bimport\s*["]([^"]+)["]\s*\;/g,

          // Example:
          // /// <reference types="something" />
          /\/\/\/\s*<\s*reference\s+types\s*=\s*["]([^"]+)["]\s*\/>/g
        ];

        for (const requireRegExp of requireRegExps) {
          let requireRegExpResult: RegExpExecArray | null;
          while (requireRegExpResult = requireRegExp.exec(line)) {
            requireMatches.add(requireRegExpResult[1]);
          }
        }
      }
    } catch (error) {
      console.log(`Skipping file due to error (${error}): ${filename}`);
    }
  }

  const packageMatches: Set<string> = new Set<string>();

  requireMatches.forEach((requireMatch: string) => {
    // Example: "my-package/lad/dee/dah" --> "my-package"
    // Example: "@ms/my-package" --> "@ms/my-package"
    const packageRegExp: RegExp = /^((@[a-z\-0-9!_]+\/)?[a-z\-0-9!_]+)\/?/;

    const packageRegExpResult: RegExpExecArray | null = packageRegExp.exec(requireMatch);
    if (packageRegExpResult) {
      packageMatches.add(packageRegExpResult[1]);
    }
  });

  const tsconfigFilePath: string = path.resolve(projectPath, 'tsconfig.json');
  if (FileSystem.exists(tsconfigFilePath)) {
    const tsconfigFile: { compilerOptions: { types: string[] }} = JsonFile.load(tsconfigFilePath);
    if (tsconfigFile.compilerOptions && tsconfigFile.compilerOptions.types) {
      for (const configType of tsconfigFile.compilerOptions.types) {
        packageMatches.add(configType);
        packageMatches.add(`@types/${configType}`);
      }
    }
  }

  return packageMatches;
}

for (const project of rushConfiguration.projects) {
  console.log(`=== Project: ${project.packageName} === `)
  const usedDependencies: Set<string> = getDependencyReferencesForProject(project.projectFolder);
  const unusedDependencies: Set<string> = new Set<string>([
    ...Object.keys(project.packageJson.devDependencies || []),
    ...Object.keys(project.packageJson.dependencies || []),
    ...Object.keys(project.packageJson.peerDependencies || [])
  ]);

  const undeclaredDependencies: Set<string> = new Set<string>();
  for (const usedDependency of usedDependencies) {
    if (unusedDependencies.has(usedDependency)) {
      unusedDependencies.delete(usedDependency);
      const typesPackageName: string = `@types/${usedDependency}`;
      if (unusedDependencies.has(typesPackageName)) {
        unusedDependencies.delete(typesPackageName);
      }
    } else {
      undeclaredDependencies.add(usedDependency);
    }
  }

  for (const allowedDep of ALLOWED_DEPS) {
    if (unusedDependencies.has(allowedDep)) {
      unusedDependencies.delete(allowedDep);
    }
  }

  for (const unusedDependency of unusedDependencies) {
    for (const [, script] of Object.entries(project.packageJson.scripts)) {
      if (script.indexOf(unusedDependency) !== -1) {
        unusedDependencies.delete(unusedDependency);
        break;
      }
    }
  }

  if (unusedDependencies.size > 0) {
    console.log('Unused dependencies:');
    unusedDependencies.forEach((dependency) => console.log(` - ${dependency}`));
  } else {
    console.log('Unused dependencies: NONE');
  }

  if (undeclaredDependencies.size > 0) {
    console.log('Undeclared dependencies:');
    undeclaredDependencies.forEach((dependency) => console.log(` - ${dependency}`));
  } else {
    console.log('Undeclared dependencies: NONE');
  }

  JsonFile.save(
    {
      unusedDependencies: Array.from(unusedDependencies),
      undeclaredDependencies: Array.from(undeclaredDependencies)
    },
    path.join(project.projectFolder, 'scanned-deps.log')
  );

  if (unusedDependencies.size > 0) {
    const projectPackageJsonPath: string = path.resolve(project.projectFolder, 'package.json');
    const packageJson: IPackageJson = JsonFile.load(projectPackageJsonPath);
    for (const unusedDependency of unusedDependencies) {
      removeEntryFromPackageJsonField(unusedDependency, packageJson.dependencies);
      removeEntryFromPackageJsonField(unusedDependency, packageJson.devDependencies);
      removeEntryFromPackageJsonField(unusedDependency, packageJson.peerDependencies);
    }

    JsonFile.save(packageJson, projectPackageJsonPath, { updateExistingFile: true });
  }

  console.log();
}

function removeEntryFromPackageJsonField(depName: string, field: { [depName: string]: string } | undefined): void {
  if (field && field[depName]) {
    delete field[depName];
  }
}
