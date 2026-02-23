const FastGlob = require("fast-glob");
const { resolve } = require("node:path");

async function test() {
  const workspacePath = resolve("./test-docs");
  const patterns = ["**/*.md"];

  console.log("Testing discovery...");
  console.log("Workspace:", workspacePath);
  console.log("Patterns:", patterns);

  try {
    const files = await FastGlob(patterns, {
      cwd: workspacePath,
      onlyFiles: true,
      followSymbolicLinks: false,
      dot: false,
      absolute: true,
    });

    console.log("Found files:", files.length);
    files.forEach((f) => {
      console.log("  -", f);
    });
  } catch (err) {
    console.error("Error:", err);
  }
}

test();
