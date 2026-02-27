/**
 * Shared testing guidance injected into worker templates via {{TESTING_GUIDANCE}}.
 * Used by both fix-defect and implement workflows.
 */

export const TESTING_GUIDANCE = `### How to Write Tests in This Project

**If the package has no test setup** (no \`"test"\` script in package.json, no *.test.* files):

Use the \`generate\` tool to scaffold test infrastructure:
\`\`\`
generate(template: "add-tests", name: "<ComponentName>", parent: "<full/package/path>", testType: "view"|"viewmodel"|"model")
\`\`\`
- \`name\`: PascalCase component/class name (e.g. "BreakdownRowView")
- \`parent\`: Full path from repo root (e.g. "packages/features/Overview/breakdown-row/breakdown-row-view")
- \`testType\`: "view" for snapshot/className tests, "viewmodel" for ViewModel unit tests, "model" for Model unit tests

This adds jest config, devDependencies, test script, and a test stub automatically.

**If the package already has tests**, follow the existing patterns in that package.

**DO NOT manually configure babel or jest transforms** — the \`@vectorvest/testing-utils\` preset handles all transform config, react-native mocks, and setup automatically.

**Test patterns:**
- **View (snapshot)**: \`renderer.create(<Component />).toJSON()\` → \`toMatchSnapshot()\`
- **View (className)**: Render → traverse JSON tree → inspect \`className\` props for Tailwind classes
- **ViewModel**: \`new ViewModel(mockModel)\` → assert exposed properties/methods
- **Model**: \`new Model()\` → assert state and behavior
- **ALWAYS** import from \`@jest/globals\`: \`import { describe, expect, it, jest } from '@jest/globals'\`

**Pure TS utility packages (models, ViewModels, non-RN code):**
If the \`add-tests\` generator produces babel/Flow parse errors, the package
likely doesn't need the full RN mock chain. Create a \`jest.config.ts\` manually:
\`\`\`ts
export default {
  clearMocks: true,
  testEnvironment: 'jest-environment-node',
  transformIgnorePatterns: [
    '/node_modules/(?!(@vectorvest|react-native|react-native-.*)/)',
  ],
};
\`\`\`
And in package.json, remove \`"preset": "@vectorvest/testing-utils"\` and
\`"testEnvironment": "jsdom"\` from the jest config. Keep only
\`"scripts": { "test": "jest" }\` and \`"devDependencies": { "@jest/globals": "^29.7.0" }\`.

**Running tests**: \`yarn tensor test <package-name>\` (runs jest scoped to that package)`;
